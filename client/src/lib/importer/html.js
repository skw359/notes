// Apple Notes HTML export to TipTap JSON. Ported from the former
// server/import-notes.js, using the browser's DOMParser (no shell, no
// server-side file access).

function inline(node, ctx, marks = []) {
  const result = []
  if (node.nodeType === 3) {
    const text = node.textContent.replace(/\n/g, ' ')
    if (/^\s*$/.test(text)) {
      return result
    }
    const item = { type: 'text', text }
    if (marks.length) {
      item.marks = marks.map((type) => ({ type }))
    }
    result.push(item)
    return result
  }
  if (node.nodeType !== 1) {
    return result
  }
  const tag = node.tagName.toUpperCase()
  if (tag === 'BR') {
    return [{ type: 'hardBreak' }]
  }
  if (tag === 'IMG') {
    const src = node.getAttribute('src')
    return src ? [{ type: '__image__', src }] : []
  }
  if (tag === 'A') {
    const href = node.getAttribute('href')
    const link = href ? ctx.resolveLink(href) : null
    const children = [...node.childNodes].flatMap((child) => inline(child, ctx, marks))
    if (!link) {
      return children
    }
    return children.map((child) =>
      child.type === 'text' ? { ...child, marks: [...(child.marks || []), { type: 'link', attrs: { href: link.href } }] } : child
    )
  }
  const next = [...marks]
  const add = (mark) => !next.includes(mark) && next.push(mark)
  if (tag === 'B' || tag === 'STRONG') add('bold')
  if (tag === 'I' || tag === 'EM') add('italic')
  if (tag === 'U') add('underline')
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') add('strike')
  if (tag === 'CODE') add('code')
  for (const child of node.childNodes) {
    result.push(...inline(child, ctx, next))
  }
  return result
}

function stripTrailingBreaks(content) {
  while (content.length && content[content.length - 1].type === 'hardBreak') {
    content.pop()
  }
  return content
}

function imageBlock(src, ctx) {
  const resolved = ctx.resolveImage(src)
  if (resolved?.link) {
    return {
      type: 'paragraph',
      content: [{ type: 'text', text: resolved.link.label, marks: [{ type: 'link', attrs: { href: resolved.link.href } }] }],
    }
  }
  if (resolved) {
    return { type: 'image', attrs: resolved }
  }
  return { type: 'paragraph', content: [{ type: 'text', text: `[Image unavailable: ${src}]` }] }
}

export function collectHtmlTargets(html, parser = new DOMParser()) {
  const doc = parser.parseFromString(html, 'text/html')
  return {
    images: new Set([...doc.querySelectorAll('img[src]')].map((img) => img.getAttribute('src'))),
    links: new Set([...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))),
  }
}

export function htmlToBlocks(html, ctx, parser = new DOMParser()) {
  const source = html.replace(/<(b|i|u|strong|em|s)>\s*<li>/gi, '<li><$1>')
  const body = parser.parseFromString(source, 'text/html').body
  const doc = []
  let current = []

  function flush() {
    stripTrailingBreaks(current)
    let run = []
    let pushed = false
    for (const item of current) {
      if (item.type === '__image__') {
        if (run.length) {
          doc.push({ type: 'paragraph', content: run })
          run = []
        }
        doc.push(imageBlock(item.src, ctx))
        pushed = true
      } else {
        run.push(item)
      }
    }
    if (run.length) {
      doc.push({ type: 'paragraph', content: run })
      pushed = true
    }
    // An empty flush is a blank line (how <br> separates paragraphs).
    if (!pushed) {
      doc.push({ type: 'paragraph' })
    }
    current = []
  }

  function listItems(list) {
    const items = []
    for (const child of list.children) {
      if (child.tagName.toUpperCase() === 'LI') {
        const content = stripTrailingBreaks(inline(child, ctx).filter((item) => item.type !== '__image__'))
        items.push({ type: 'listItem', content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }] })
      } else {
        items.push(...listItems(child))
      }
    }
    return items
  }

  function walk(node) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\n/g, ' ')
      if (!/^\s*$/.test(text)) {
        current.push({ type: 'text', text })
      }
      return
    }
    if (node.nodeType !== 1) {
      return
    }
    const tag = node.tagName.toUpperCase()
    if (tag === 'BR') {
      flush()
      return
    }
    if (/^H[1-6]$/.test(tag)) {
      flush()
      const content = stripTrailingBreaks(inline(node, ctx).filter((item) => item.type !== '__image__'))
      doc.push({ type: 'heading', attrs: { level: Number(tag[1]) }, ...(content.length ? { content } : {}) })
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      flush()
      const items = listItems(node)
      if (items.length) {
        doc.push({ type: tag === 'UL' ? 'bulletList' : 'orderedList', content: items })
      }
      return
    }
    if (tag === 'BLOCKQUOTE') {
      flush()
      const content = stripTrailingBreaks(inline(node, ctx).filter((item) => item.type !== '__image__'))
      doc.push({ type: 'blockquote', content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }] })
      return
    }
    if (tag === 'HR') {
      flush()
      doc.push({ type: 'horizontalRule' })
      return
    }
    if (tag === 'PRE') {
      flush()
      const text = node.textContent
      doc.push({ type: 'codeBlock', content: text ? [{ type: 'text', text }] : [] })
      return
    }
    if (tag === 'IMG') {
      flush()
      const src = node.getAttribute('src')
      if (src) {
        doc.push(imageBlock(src, ctx))
      }
      return
    }
    if (tag === 'TABLE') {
      flush()
      for (const row of node.querySelectorAll('tr')) {
        const text = [...row.querySelectorAll('td, th')]
          .map((cell) => cell.textContent.trim())
          .filter(Boolean)
          .join(' | ')
        if (text) {
          doc.push({ type: 'paragraph', content: [{ type: 'text', text }] })
        }
      }
      return
    }
    if (['VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'SCRIPT', 'STYLE', 'IFRAME'].includes(tag)) {
      return
    }
    if (tag === 'DIV' || tag === 'P') {
      flush()
      for (const child of node.childNodes) {
        walk(child)
      }
      flush()
      return
    }
    current.push(...inline(node, ctx))
  }

  for (const child of body.childNodes) {
    walk(child)
  }
  if (current.length) {
    flush()
  }
  while (doc.length > 1 && doc[0].type === 'paragraph' && !doc[0].content) {
    doc.shift()
  }
  while (doc.length > 1 && doc[doc.length - 1].type === 'paragraph' && !doc[doc.length - 1].content) {
    doc.pop()
  }
  return doc.length ? doc : [{ type: 'paragraph' }]
}

export function dateFromHtmlFilename(filename) {
  const match = filename.match(/-(\d{1,2})-(\d{1,2})-(\d{4})\.html$/i)
  if (!match) {
    return null
  }
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null
}
