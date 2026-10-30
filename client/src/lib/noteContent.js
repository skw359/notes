export const ENCRYPTED_BLOB_PREFIX = 'notes-blob:'
export const ATTACHMENT_SCHEME = ENCRYPTED_BLOB_PREFIX
export const EMPTY_NOTE_SUMMARY = Object.freeze({
  title: 'Untitled',
  preview: '',
})

const LEGACY_UPLOAD_RE = /^\/api\/(?:uploads|legacy-uploads)\/([^?#/]+)$/i
const TITLE_MAX_LENGTH = 120
const PREVIEW_MAX_LENGTH = 240

export function createEmptyNoteContent() {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value
}

// DATA-10: a malformed escape such as "100%.jpg" must not throw.
export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function parsePositiveInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function parseBlobId(value) {
  if (typeof value !== 'string' || !value.startsWith(ENCRYPTED_BLOB_PREFIX)) {
    return null
  }
  const id = value.slice(ENCRYPTED_BLOB_PREFIX.length).split('?')[0]
  return parsePositiveInt(id) ? id : null
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectTextLines(node, lines) {
  if (!node || typeof node !== 'object') {
    return
  }
  if (node.type === 'hardBreak') {
    lines.push('\n')
    return
  }
  if (typeof node.text === 'string') {
    lines.push(node.text)
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      collectTextLines(child, lines)
    }
  }
  if (node.type === 'paragraph' || node.type === 'heading') {
    lines.push('\n')
  }
}

function buildNormalizedPlainText(content) {
  const parts = []
  collectTextLines(content, parts)
  return parts
    .join('')
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
}

function mapNodeSync(node, mapper) {
  if (!node || typeof node !== 'object') {
    return node
  }
  const nextNode = {
    ...node,
    ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
    ...(Array.isArray(node.marks) ? { marks: node.marks.map((mark) => ({ ...mark, ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}) })) } : {}),
    ...(Array.isArray(node.content) ? { content: node.content.map((child) => mapNodeSync(child, mapper)) } : {}),
  }
  return mapper(nextNode)
}

async function mapNodeAsync(node, mapper) {
  if (!node || typeof node !== 'object') {
    return node
  }
  const nextNode = {
    ...node,
    ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
    ...(Array.isArray(node.content)
      ? { content: (await Promise.all(node.content.map((child) => mapNodeAsync(child, mapper)))).flat() }
      : {}),
  }
  return mapper(nextNode)
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') {
    return
  }
  visit(node)
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      walk(child, visit)
    }
  }
}

// ── Encrypted attachments ───────────────────────────────────────────────
// Images are image nodes; other files are links with a notes-blob: href.
// Both record the blob's client-generated UUID, format version and key id
// inside the encrypted note, which is what the client trusts when
// decrypting (not server headers).

export function buildBlobRef(blobId) {
  return `${ENCRYPTED_BLOB_PREFIX}${blobId}`
}

export function getBlobIdFromImageAttrs(attrs = {}) {
  return attrs.blobId ? String(attrs.blobId) : parseBlobId(attrs.src)
}

export function blobReferenceFromImageAttrs(attrs = {}) {
  const blobId = getBlobIdFromImageAttrs(attrs)
  if (!blobId) {
    return null
  }
  return {
    blobId,
    blobUuid: attrs.blobUuid || null,
    blobVersion: attrs.blobVersion ? Number(attrs.blobVersion) : null,
    keyId: attrs.keyId || null,
    mimeType: attrs.mimeType || null,
  }
}

export function imageAttrsForBlob(uploaded) {
  return {
    src: buildBlobRef(uploaded.blobId),
    blobId: String(uploaded.blobId),
    blobUuid: uploaded.blobUuid,
    blobVersion: uploaded.blobVersion,
    keyId: uploaded.keyId,
    mimeType: uploaded.mimeType || null,
  }
}

export function buildAttachmentHref(uploaded) {
  const params = new URLSearchParams()
  params.set('u', uploaded.blobUuid)
  params.set('k', uploaded.keyId)
  params.set('v', String(uploaded.blobVersion))
  if (uploaded.name) {
    params.set('n', uploaded.name)
  }
  if (uploaded.mimeType) {
    params.set('t', uploaded.mimeType)
  }
  if (uploaded.size) {
    params.set('s', String(uploaded.size))
  }
  return `${ATTACHMENT_SCHEME}${uploaded.blobId}?${params.toString()}`
}

export function parseAttachmentHref(href) {
  if (typeof href !== 'string' || !href.startsWith(ATTACHMENT_SCHEME)) {
    return null
  }
  const [idPart, query = ''] = href.slice(ATTACHMENT_SCHEME.length).split('?')
  if (!parsePositiveInt(idPart)) {
    return null
  }
  const params = new URLSearchParams(query)
  return {
    blobId: idPart,
    blobUuid: params.get('u'),
    keyId: params.get('k'),
    blobVersion: params.get('v') ? Number(params.get('v')) : null,
    name: params.get('n') || 'attachment',
    mimeType: params.get('t') || 'application/octet-stream',
    size: params.get('s') ? Number(params.get('s')) : null,
  }
}

function linkMark(node) {
  return Array.isArray(node.marks) ? node.marks.find((mark) => mark?.type === 'link') : null
}

// Every blob a document references (images and attachment links). Reported
// to the server on save so it can garbage-collect safely (DATA-4).
export function collectBlobReferences(content) {
  const references = new Map()
  walk(content, (node) => {
    if (node.type === 'image' && node.attrs) {
      const reference = blobReferenceFromImageAttrs(node.attrs)
      if (reference) {
        references.set(reference.blobId, reference)
      }
    }
    const link = linkMark(node)
    const attachment = link ? parseAttachmentHref(link.attrs?.href) : null
    if (attachment) {
      references.set(attachment.blobId, attachment)
    }
  })
  return references
}

export function extractBlobIdsFromContent(content) {
  return new Set(collectBlobReferences(content).keys())
}

export function blobIdsForSave(content) {
  return [...extractBlobIdsFromContent(content)].map(Number).filter((id) => Number.isInteger(id) && id > 0)
}

// Editor documents may carry object URLs; storage keeps only references.
export function normalizeContentForStorage(content) {
  return mapNodeSync(clone(content), (node) => {
    if (node.type !== 'image' || !node.attrs) {
      return node
    }
    const blobId = getBlobIdFromImageAttrs(node.attrs)
    if (!blobId) {
      return node
    }
    return { ...node, attrs: { ...node.attrs, blobId, src: buildBlobRef(blobId) } }
  })
}

// Rewrites blob references (key rotation copies blobs under new ids).
export function rewriteBlobReferences(content, mapping) {
  return mapNodeSync(clone(content), (node) => {
    if (node.type === 'image' && node.attrs) {
      const blobId = getBlobIdFromImageAttrs(node.attrs)
      const replacement = blobId ? mapping.get(blobId) : null
      if (replacement) {
        return { ...node, attrs: { ...node.attrs, ...imageAttrsForBlob({ ...replacement, mimeType: node.attrs.mimeType }) } }
      }
    }
    if (Array.isArray(node.marks)) {
      const marks = node.marks.map((mark) => {
        const attachment = mark?.type === 'link' ? parseAttachmentHref(mark.attrs?.href) : null
        const replacement = attachment ? mapping.get(attachment.blobId) : null
        if (!replacement) {
          return mark
        }
        return {
          ...mark,
          attrs: {
            ...mark.attrs,
            href: buildAttachmentHref({ ...replacement, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }),
          },
        }
      })
      return { ...node, marks }
    }
    return node
  })
}

// ── Pre-encryption (legacy) files ───────────────────────────────────────

export function extractLegacyFilename(url) {
  if (typeof url !== 'string') {
    return null
  }
  const match = url.match(LEGACY_UPLOAD_RE)
  if (!match) {
    return null
  }
  const decoded = safeDecodeURIComponent(match[1])
  return decoded && !/[/\\\0]/.test(decoded) && decoded !== '.' && decoded !== '..' ? decoded : null
}

// Legacy files referenced by images or by link targets (CRYPTO-3: links to
// non-image attachments used to be ignored and became dead after migration).
export function extractLegacyReferences(content) {
  const files = new Set()
  walk(content, (node) => {
    const fromImage = node.type === 'image' ? extractLegacyFilename(node.attrs?.src) : null
    if (fromImage) {
      files.add(fromImage)
    }
    const link = linkMark(node)
    const fromLink = link ? extractLegacyFilename(link.attrs?.href) : null
    if (fromLink) {
      files.add(fromLink)
    }
  })
  return files
}

/**
 * Replaces legacy upload references with encrypted ones. `resolveFile`
 * returns an uploaded blob reference, or null when the file is missing or
 * not owned; missing media becomes a visible placeholder instead of
 * failing the whole migration (DATA-5). With `keepUnresolved`, unresolved
 * references are left exactly as they were instead.
 */
export async function migrateLegacyContent(content, resolveFile, { keepUnresolved = false } = {}) {
  return mapNodeAsync(clone(content), async (node) => {
    if (node.type === 'image' && node.attrs?.src) {
      const filename = extractLegacyFilename(node.attrs.src)
      if (!filename && /^\/api\/(?:uploads|legacy-uploads)\//i.test(node.attrs.src) && !keepUnresolved) {
        return { type: 'paragraph', content: [{ type: 'text', text: '[Image unavailable: invalid file name]' }] }
      }
      if (filename) {
        const uploaded = await resolveFile(filename)
        if (!uploaded) {
          return keepUnresolved
            ? node
            : { type: 'paragraph', content: [{ type: 'text', text: `[Image unavailable: ${filename}]` }] }
        }
        return { ...node, attrs: { ...node.attrs, ...imageAttrsForBlob(uploaded) } }
      }
    }

    if (node.type === 'text' && Array.isArray(node.marks)) {
      const link = linkMark(node)
      const filename = link ? extractLegacyFilename(link.attrs?.href) : null
      if (filename) {
        const uploaded = await resolveFile(filename)
        if (!uploaded && keepUnresolved) {
          return node
        }
        if (!uploaded) {
          return [
            { ...node, marks: node.marks.filter((mark) => mark !== link) },
            { type: 'text', text: ` [attachment unavailable: ${filename}]` },
          ]
        }
        return {
          ...node,
          marks: node.marks.map((mark) =>
            mark === link
              ? { ...mark, attrs: { ...mark.attrs, href: buildAttachmentHref({ ...uploaded, name: uploaded.name || filename }) } }
              : mark
          ),
        }
      }
    }
    return node
  })
}

// ── Summaries and search ────────────────────────────────────────────────

export function createNoteSummary(content) {
  const lines = buildNormalizedPlainText(content)
  if (!lines.length) {
    return EMPTY_NOTE_SUMMARY
  }
  const title = lines[0].slice(0, TITLE_MAX_LENGTH) || EMPTY_NOTE_SUMMARY.title
  const bodyText = lines.join(' ')
  const previewBase = bodyText.startsWith(title) ? bodyText.slice(title.length).trim() : bodyText
  return { title, preview: previewBase.slice(0, PREVIEW_MAX_LENGTH) }
}

export function createNoteSearchText(content) {
  return buildNormalizedPlainText(content).join(' ').toLowerCase()
}

export function getSummarySearchText(summary) {
  if (!summary) {
    return ''
  }
  return `${summary.title || ''} ${summary.preview || ''}`.trim().toLowerCase()
}
