// Markdown (Apple Notes "Exporter" format: optional frontmatter with title,
// creation_date, modification_date) to TipTap JSON. Ported from the former
// server/import-script.js; media targets are resolved by the caller.

export function parseFrontmatter(raw) {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) {
    return { frontmatter: {}, body: text }
  }
  const end = text.indexOf('\n---', 4)
  if (end === -1) {
    return { frontmatter: {}, body: text }
  }
  const frontmatter = {}
  for (const line of text.slice(4, end).trim().split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) {
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
    if (key) {
      frontmatter[key] = value
    }
  }
  return { frontmatter, body: text.slice(end + 4).replace(/^\n/, '') }
}

export function cleanTarget(rawTarget) {
  let target = String(rawTarget || '').trim()
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim()
  }
  const titled = target.match(/^(.+?)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/)
  if (titled) {
    target = titled[1].trim()
  }
  if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1)
  }
  return target.trim()
}

const UNSAFE_HREF_RE = /^\s*(?:javascript|vbscript|data):/i

function textNode(text, marks = []) {
  const node = { type: 'text', text }
  if (marks.length) {
    node.marks = marks
  }
  return node
}

function appendText(nodes, text, marks = []) {
  if (!text) {
    return
  }
  const previous = nodes[nodes.length - 1]
  if (previous?.type === 'text' && JSON.stringify(previous.marks || []) === JSON.stringify(marks)) {
    previous.text += text
  } else {
    nodes.push(textNode(text, marks))
  }
}

function withMark(nodes, mark) {
  return nodes.map((node) => {
    if (node.type !== 'text') {
      return node
    }
    const marks = [...(node.marks || [])]
    if (!marks.some((existing) => JSON.stringify(existing) === JSON.stringify(mark))) {
      marks.push(mark)
    }
    return { ...node, marks }
  })
}

// `resolveLink(target)` returns { href } for links (an attachment href for
// local files, the URL for remote ones) or null to drop the link.
function parseInline(text, ctx, marks = [], depth = 0) {
  if (!text) {
    return []
  }
  if (depth > 25) {
    return [textNode(text, marks)]
  }
  const nodes = []
  let index = 0
  while (index < text.length) {
    const positions = ['[', '`', '*', '_', '~'].map((char) => text.indexOf(char, index)).filter((p) => p !== -1)
    if (!positions.length) {
      appendText(nodes, text.slice(index), marks)
      break
    }
    const next = Math.min(...positions)
    if (next > index) {
      appendText(nodes, text.slice(index, next), marks)
      index = next
    }
    const char = text[index]

    if (char === '[') {
      const close = text.indexOf(']', index + 1)
      if (close !== -1 && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2)
        if (paren !== -1) {
          const label = text.slice(index + 1, close)
          const link = ctx.resolveLink(cleanTarget(text.slice(close + 2, paren)))
          const inner = parseInline(label, ctx, marks, depth + 1)
          nodes.push(...(link && !UNSAFE_HREF_RE.test(link.href) ? withMark(inner, { type: 'link', attrs: { href: link.href } }) : inner))
          index = paren + 1
          continue
        }
      }
    }
    if (char === '`') {
      const close = text.indexOf('`', index + 1)
      if (close !== -1) {
        appendText(nodes, text.slice(index + 1, close), [...marks, { type: 'code' }])
        index = close + 1
        continue
      }
    }
    if (char === '*' && text[index + 1] === '*') {
      const close = text.indexOf('**', index + 2)
      if (close !== -1) {
        nodes.push(...withMark(parseInline(text.slice(index + 2, close), ctx, marks, depth + 1), { type: 'bold' }))
        index = close + 2
        continue
      }
    }
    if ((char === '*' && text[index + 1] !== '*') || char === '_') {
      const close = text.indexOf(char, index + 1)
      if (close !== -1 && !(char === '*' && text[close + 1] === '*')) {
        nodes.push(...withMark(parseInline(text.slice(index + 1, close), ctx, marks, depth + 1), { type: 'italic' }))
        index = close + 1
        continue
      }
    }
    if (char === '~' && text[index + 1] === '~') {
      const close = text.indexOf('~~', index + 2)
      if (close !== -1) {
        nodes.push(...withMark(parseInline(text.slice(index + 2, close), ctx, marks, depth + 1), { type: 'strike' }))
        index = close + 2
        continue
      }
    }
    appendText(nodes, text[index], marks)
    index += 1
  }
  return nodes.filter((node) => node.type !== 'text' || node.text.length > 0)
}

function parseInlineLines(text, ctx) {
  const nodes = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    nodes.push(...parseInline(line, ctx))
    if (i < lines.length - 1) {
      nodes.push({ type: 'hardBreak' })
    }
  })
  return nodes
}

function paragraph(content) {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

/**
 * ctx.resolveImage(target) -> image node attrs, an attachment link
 * ({ link: { href, label } }) or null (placeholder);
 * ctx.resolveLink(target) -> { href } or null.
 */
export function markdownToBlocks(markdown, ctx) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  const isFence = (line) => /^\s*```/.test(line)
  const isHeading = (line) => /^\s{0,3}#{1,6}\s+/.test(line)
  const isBullet = (line) => /^\s*[-*+]\s+/.test(line)
  const isOrdered = (line) => /^\s*\d+\.\s+/.test(line)
  const isQuote = (line) => /^\s*>\s?/.test(line)
  const isImage = (line) => /^\s*!\[[^\]]*]\([^)]+\)\s*$/.test(line)
  const isSpecial = (line) => isFence(line) || isHeading(line) || isBullet(line) || isOrdered(line) || isQuote(line) || isImage(line)
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    if (isFence(line)) {
      const code = []
      i += 1
      while (i < lines.length && !isFence(lines[i])) {
        code.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push({ type: 'codeBlock', content: code.length ? [textNode(code.join('\n'))] : [] })
      continue
    }
    if (isImage(line)) {
      const target = cleanTarget(line.trim().match(/^!\[[^\]]*]\(([^)]+)\)$/)?.[1])
      const resolved = ctx.resolveImage(target)
      if (resolved?.link) {
        blocks.push(paragraph([textNode(resolved.link.label, [{ type: 'link', attrs: { href: resolved.link.href } }])]))
      } else if (resolved) {
        blocks.push({ type: 'image', attrs: resolved })
      } else {
        blocks.push(paragraph([textNode(`[Image unavailable: ${target}]`)]))
      }
      i += 1
      continue
    }
    if (isHeading(line)) {
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
      const content = parseInlineLines(match[2].trim(), ctx)
      blocks.push({ type: 'heading', attrs: { level: match[1].length }, ...(content.length ? { content } : {}) })
      i += 1
      continue
    }
    if (isQuote(line)) {
      const quoted = []
      while (i < lines.length && isQuote(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'blockquote', content: [paragraph(parseInlineLines(quoted.join('\n').trim(), ctx))] })
      continue
    }
    if (isBullet(line) || isOrdered(line)) {
      const ordered = isOrdered(line)
      const matcher = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
      const items = []
      while (i < lines.length && lines[i].trim() && (ordered ? isOrdered(lines[i]) : isBullet(lines[i]))) {
        let text = lines[i].match(matcher)?.[1] ?? lines[i].trim()
        i += 1
        while (i < lines.length && lines[i].trim() && !isSpecial(lines[i]) && /^\s+/.test(lines[i])) {
          text += `\n${lines[i].trim()}`
          i += 1
        }
        items.push({ type: 'listItem', content: [paragraph(parseInlineLines(text.trim(), ctx))] })
      }
      blocks.push({ type: ordered ? 'orderedList' : 'bulletList', content: items })
      continue
    }
    const paragraphLines = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) {
      paragraphLines.push(lines[i])
      i += 1
    }
    blocks.push(paragraph(parseInlineLines(paragraphLines.join('\n').trimEnd(), ctx)))
  }
  return blocks.length ? blocks : [{ type: 'paragraph' }]
}

// Every target a note references, so media can be uploaded before parsing.
export function collectMarkdownTargets(markdown) {
  const images = new Set()
  const links = new Set()
  for (const match of markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
    images.add(cleanTarget(match[1]))
  }
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]+]\(([^)]+)\)/g)) {
    links.add(cleanTarget(match[1]))
  }
  return { images, links }
}

function plainText(node) {
  return (node?.content || [])
    .filter((child) => child.type === 'text')
    .map((child) => child.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Puts the note's title first, as the former importer did, unless the body
// already starts with it.
export function ensureTitle(blocks, title) {
  const trimmed = String(title || '').replace(/\s+/g, ' ').trim()
  if (!trimmed) {
    return blocks
  }
  if (blocks[0]?.type === 'heading' && plainText(blocks[0]).toLowerCase() === trimmed.toLowerCase()) {
    return blocks
  }
  return [{ type: 'heading', attrs: { level: 1 }, content: [textNode(trimmed)] }, ...blocks]
}

// Exports name files "<title>-<DD>-<MM>-<YYYY>.md"; only that date suffix is
// removed, so titles with their own dashes stay intact.
export function titleFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, '')
  return base.replace(/-\d{1,2}-\d{1,2}-\d{4}$/, '').trim() || base.trim()
}

export function parseDate(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const parsed = new Date(value.trim())
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
