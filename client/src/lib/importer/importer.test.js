// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { htmlToBlocks } from './html.js'
import { buildImportPlan, resolveMediaPath } from './index.js'
import { ensureTitle, markdownToBlocks, parseFrontmatter, titleFromFilename } from './markdown.js'

function fileAt(path, contents = 'x', type = '') {
  const file = new File([contents], path.split('/').pop(), { type })
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

const ctx = {
  resolveImage: (target) => (target.includes('missing') ? null : target.endsWith('.heic') ? { link: { href: 'notes-blob:9?u=x', label: 'photo.heic' } } : { src: 'notes-blob:1', blobId: '1' }),
  resolveLink: (target) => (/^https?:/.test(target) ? { href: target } : target.endsWith('.pdf') ? { href: 'notes-blob:2?u=y' } : null),
}

describe('Markdown conversion', () => {
  it('parses frontmatter and builds the title heading', () => {
    const { frontmatter, body } = parseFrontmatter('---\ntitle: "Groceries"\ncreation_date: 2024-01-02T03:04:05Z\n---\nmilk')
    expect(frontmatter).toEqual({ title: 'Groceries', creation_date: '2024-01-02T03:04:05Z' })
    const blocks = ensureTitle(markdownToBlocks(body, ctx), frontmatter.title)
    expect(blocks[0]).toEqual({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Groceries' }] })
    expect(titleFromFilename('Groceries-12-03-2024.md')).toBe('Groceries')
    expect(titleFromFilename('Q3-planning.md')).toBe('Q3-planning')
    expect(titleFromFilename('!-20-08-2024.md')).toBe('!')
  })

  it('converts blocks and inline marks', () => {
    const md = [
      '# Heading',
      '- **bold** and *italic*',
      '- ~~strike~~ `code`',
      '',
      '1. one',
      '> quoted',
      '```',
      'const x = 1',
      '```',
      '[site](https://example.com) [bad](javascript:alert(1)) [doc](attachments/tax.pdf) [note](other.md)',
      '![pic](images/a.png)',
      '![heic](images/photo.heic)',
      '![gone](images/missing.png)',
    ].join('\n')
    const blocks = markdownToBlocks(md, ctx)
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'bulletList',
      'orderedList',
      'blockquote',
      'codeBlock',
      'paragraph',
      'image',
      'paragraph',
      'paragraph',
    ])
    const bullet = blocks[1].content[0].content[0].content
    expect(bullet[0]).toEqual({ type: 'text', text: 'bold', marks: [{ type: 'bold' }] })
    const links = blocks[5].content.filter((n) => n.marks?.some((m) => m.type === 'link')).map((n) => n.marks[0].attrs.href)
    expect(links).toEqual(['https://example.com', 'notes-blob:2?u=y'])
    expect(JSON.stringify(blocks[5])).not.toContain('javascript:')
    expect(blocks[7].content[0].marks[0].attrs.href).toBe('notes-blob:9?u=x')
    expect(blocks[8].content[0].text).toBe('[Image unavailable: images/missing.png]')
  })
})

describe('HTML conversion', () => {
  it('converts the Apple Notes HTML structure and drops active content', () => {
    const html = `<html><body>
      <h1>Title</h1><div>First line<br>Second <b>bold</b></div>
      <ul><li>one</li><li><i>two</i></li></ul>
      <div><img src="images/a.png"></div>
      <table><tr><td>a</td><td>b</td></tr></table>
      <script>alert(1)</script><iframe src="x"></iframe>
      <a href="https://example.com">site</a>
    </body></html>`
    const blocks = htmlToBlocks(html, ctx)
    const text = JSON.stringify(blocks)
    expect(blocks[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(text).toContain('"bulletList"')
    expect(text).toContain('"image"')
    expect(text).toContain('a | b')
    expect(text).toContain('https://example.com')
    expect(text).not.toContain('alert')
  })
})

describe('import plan and media resolution (SEC-3 in the browser)', () => {
  const files = [
    fileAt('export/Notes/Note one.md', '# One'),
    fileAt('export/Notes/images/a.png', 'png', 'image/png'),
    fileAt('export/Notes/attachments/tax.pdf', 'pdf'),
    fileAt('export/Notes/secret.txt', 'not media'),
    fileAt('export/.env', 'JWT_SECRET=nope'),
    fileAt('export/Notes/.DS_Store', ''),
  ]
  const plan = buildImportPlan(files)

  it('detects the format and ignores dotfiles', () => {
    expect(plan.format).toBe('markdown')
    expect(plan.counts).toEqual({ markdown: 1, html: 0, media: 2 })
  })

  it('resolves only media inside the selected folder', () => {
    const note = 'export/Notes/Note one.md'
    expect(resolveMediaPath(plan, note, 'images/a.png')?.path).toBe('export/Notes/images/a.png')
    expect(resolveMediaPath(plan, note, 'images%2Fa.png')?.path).toBe('export/Notes/images/a.png')
    expect(resolveMediaPath(plan, note, 'a.png')?.path).toBe('export/Notes/images/a.png')
    expect(resolveMediaPath(plan, note, 'tax.pdf')?.path).toBe('export/Notes/attachments/tax.pdf')
    // Not media, outside the selection, or a URL: never resolved.
    expect(resolveMediaPath(plan, note, 'secret.txt')).toBeNull()
    expect(resolveMediaPath(plan, note, '../.env')).toBeNull()
    expect(resolveMediaPath(plan, note, '../../../../server/.env')).toBeNull()
    expect(resolveMediaPath(plan, note, 'images/../../.env')).toBeNull()
    expect(resolveMediaPath(plan, note, 'file:///etc/passwd')).toBeNull()
    expect(resolveMediaPath(plan, note, 'https://example.com/a.png')).toBeNull()
    expect(resolveMediaPath(plan, note, '100%.png')).toBeNull()
  })
})
