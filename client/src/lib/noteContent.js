export const ENCRYPTED_BLOB_PREFIX = 'notes-blob:'
export const EMPTY_NOTE_SUMMARY = Object.freeze({
  title: 'Untitled',
  preview: '',
})

const LEGACY_UPLOAD_RE = /^\/api\/(?:uploads|legacy-uploads)\/([^?#/]+)$/i
const TITLE_MAX_LENGTH = 120
const PREVIEW_MAX_LENGTH = 240

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value
}

function parseBlobId(value) {
  if (typeof value !== 'string') {
    return null
  }

  if (!value.startsWith(ENCRYPTED_BLOB_PREFIX)) {
    return null
  }

  const blobId = value.slice(ENCRYPTED_BLOB_PREFIX.length)
  return blobId || null
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
  const joined = parts.join('')
  const lines = joined
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)

  return lines
}

function mapNodeSync(node, mapper) {
  if (!node || typeof node !== 'object') {
    return node
  }

  const nextNode = {
    ...node,
    ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
    ...(Array.isArray(node.content)
      ? { content: node.content.map((child) => mapNodeSync(child, mapper)) }
      : {}),
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
      ? { content: await Promise.all(node.content.map((child) => mapNodeAsync(child, mapper))) }
      : {}),
  }

  return mapper(nextNode)
}

export function buildBlobRef(blobId) {
  return `${ENCRYPTED_BLOB_PREFIX}${blobId}`
}

export function getBlobIdFromImageAttrs(attrs = {}) {
  return attrs.blobId || parseBlobId(attrs.src)
}

export function extractLegacyFilename(url) {
  if (typeof url !== 'string') {
    return null
  }

  const match = url.match(LEGACY_UPLOAD_RE)
  return match ? decodeURIComponent(match[1]) : null
}

export function normalizeContentForStorage(content) {
  return mapNodeSync(clone(content), (node) => {
    if (node.type !== 'image' || !node.attrs) {
      return node
    }

    const blobId = getBlobIdFromImageAttrs(node.attrs)
    if (!blobId) {
      return node
    }

    return {
      ...node,
      attrs: {
        ...node.attrs,
        blobId,
        src: buildBlobRef(blobId),
      },
    }
  })
}

export function extractBlobIdsFromContent(content) {
  const ids = new Set()

  mapNodeSync(clone(content), (node) => {
    if (node.type === 'image' && node.attrs) {
      const blobId = getBlobIdFromImageAttrs(node.attrs)
      if (blobId) {
        ids.add(String(blobId))
      }
    }

    return node
  })

  return ids
}

export function createNoteSummary(content) {
  const lines = buildNormalizedPlainText(content)
  if (!lines.length) {
    return EMPTY_NOTE_SUMMARY
  }

  const title = lines[0].slice(0, TITLE_MAX_LENGTH) || EMPTY_NOTE_SUMMARY.title
  const bodyText = lines.join(' ')
  const previewBase = bodyText.startsWith(title) ? bodyText.slice(title.length).trim() : bodyText

  return {
    title,
    preview: previewBase.slice(0, PREVIEW_MAX_LENGTH),
  }
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

export async function migrateLegacyContent(content, migrateFile) {
  return mapNodeAsync(clone(content), async (node) => {
    if (node.type !== 'image' || !node.attrs?.src) {
      return node
    }

    const legacyFilename = extractLegacyFilename(node.attrs.src)
    if (!legacyFilename) {
      return node
    }

    const migratedBlob = await migrateFile(legacyFilename)
    return {
      ...node,
      attrs: {
        ...node.attrs,
        blobId: migratedBlob.blobId,
        mimeType: migratedBlob.mimeType,
        src: migratedBlob.url,
      },
    }
  })
}
