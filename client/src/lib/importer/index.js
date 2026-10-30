import { uploadAttachment } from '../attachments.js'
import { encodeBase64Url } from '../base64.js'
import { CONTEXTS } from '../envelope.js'
import { blobIdsForSave, buildAttachmentHref, createNoteSummary, imageAttrsForBlob } from '../noteContent.js'
import { getMeta, setMeta } from '../persistentNoteCache.js'
import { collectHtmlTargets, dateFromHtmlFilename, htmlToBlocks } from './html.js'
import {
  collectMarkdownTargets,
  ensureTitle,
  markdownToBlocks,
  parseDate,
  parseFrontmatter,
  titleFromFilename,
} from './markdown.js'

// Shown inline. HEIC/TIFF are kept as downloadable attachments (most
// browsers cannot display them); SVG too, so it is never rendered as markup.
const INLINE_IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}
const OTHER_TYPES = {
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain',
}
const REMOTE_LINK_RE = /^(?:https?:|mailto:|tel:)/i
const MEDIA_DIRS = new Set(['images', 'attachments'])

function extensionOf(path) {
  const match = path.toLowerCase().match(/\.[a-z0-9]+$/)
  return match ? match[0] : ''
}

function basename(path) {
  return path.split('/').pop()
}

function normalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function inMediaDir(path) {
  return path
    .toLowerCase()
    .split('/')
    .slice(0, -1)
    .some((segment) => MEDIA_DIRS.has(segment))
}

/** Groups the files of a selected export folder into notes and media. */
export function buildImportPlan(files) {
  const entries = [...files]
    .map((file) => ({ file, path: normalizePath(file.webkitRelativePath || file.relativePath || file.name) }))
    .filter((entry) => !basename(entry.path).startsWith('.'))
  const byPath = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]))
  const markdown = entries.filter((entry) => /\.md$/i.test(entry.path) && !inMediaDir(entry.path))
  const html = entries.filter((entry) => /\.html?$/i.test(entry.path) && !inMediaDir(entry.path))
  const format = markdown.length && markdown.length >= html.length ? 'markdown' : html.length ? 'html' : null
  return {
    byPath,
    format,
    counts: { markdown: markdown.length, html: html.length, media: entries.filter((e) => inMediaDir(e.path)).length },
    notesFor: (chosen) => (chosen === 'html' ? html : markdown),
  }
}

/**
 * Resolves a note's media reference to one of the files the user selected.
 * Only files inside an images/ or attachments/ folder of the selection are
 * eligible, '..' cannot climb out of the selection, and URLs are never
 * fetched: the browser equivalent of the SEC-3 fix.
 */
export function resolveMediaPath(plan, notePath, rawTarget) {
  if (!rawTarget || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || rawTarget.startsWith('/') || rawTarget.startsWith('#')) {
    return null
  }
  let decoded = rawTarget
  try {
    decoded = decodeURIComponent(rawTarget)
  } catch {
    // keep the raw form (DATA-10)
  }
  decoded = decoded.replace(/\\/g, '/').split(/[?#]/)[0]

  const baseDir = notePath.split('/').slice(0, -1)
  const segments = [...baseDir]
  for (const part of decoded.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      if (!segments.length) {
        return null
      }
      segments.pop()
      continue
    }
    segments.push(part)
  }
  const direct = plan.byPath.get(segments.join('/').toLowerCase())
  if (direct && inMediaDir(direct.path)) {
    return direct
  }
  // Exporters often reference media by bare file name.
  const name = basename(decoded)
  for (const dir of MEDIA_DIRS) {
    const entry = plan.byPath.get([...baseDir, dir, name].join('/').toLowerCase())
    if (entry) {
      return entry
    }
  }
  return null
}

async function fingerprint(path, text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${path}\n${text}`))
  return encodeBase64Url(new Uint8Array(digest))
}

/**
 * Imports an export into the vault: each note is converted and encrypted in
 * the browser, then uploaded through the normal API (create + first save),
 * keeping its original dates. Append-only; sources already imported on
 * this device are skipped. Nothing plaintext reaches the server (ARCH-4).
 */
export async function runImport({ api, vault, plan, format, userId, onProgress = () => {}, signal, parser }) {
  const notes = plan.notesFor(format)
  const imported = new Set((await getMeta(userId, 'imported-sources')) || [])
  const uploads = new Map()
  const summary = { created: 0, skipped: 0, failed: [], attachments: 0, missingMedia: 0 }

  async function upload(entry) {
    if (uploads.has(entry.path)) {
      return uploads.get(entry.path)
    }
    const ext = extensionOf(entry.path)
    let reference = null
    try {
      reference = await uploadAttachment({
        api,
        vault,
        bytes: new Uint8Array(await entry.file.arrayBuffer()),
        mimeType: entry.file.type || INLINE_IMAGE_TYPES[ext] || OTHER_TYPES[ext] || 'application/octet-stream',
        name: basename(entry.path),
      })
      reference.inline = Boolean(INLINE_IMAGE_TYPES[ext])
      summary.attachments += 1
    } catch {
      summary.missingMedia += 1
    }
    uploads.set(entry.path, reference)
    return reference
  }

  async function buildContext(notePath, targets) {
    const resolved = new Map()
    for (const target of [...targets.images, ...targets.links]) {
      if (resolved.has(target)) {
        continue
      }
      const entry = resolveMediaPath(plan, notePath, target)
      if (!entry && targets.images.has(target)) {
        summary.missingMedia += 1
      }
      resolved.set(target, entry ? await upload(entry) : null)
    }
    return {
      resolveImage(target) {
        const reference = resolved.get(target)
        if (!reference) {
          return null
        }
        if (reference.inline) {
          return imageAttrsForBlob(reference)
        }
        return { link: { href: buildAttachmentHref(reference), label: reference.name } }
      },
      resolveLink(target) {
        if (REMOTE_LINK_RE.test(target)) {
          return { href: target }
        }
        const reference = resolved.get(target)
        return reference ? { href: buildAttachmentHref(reference) } : null
      },
    }
  }

  async function convert(entry, text) {
    const name = basename(entry.path)
    const fileDate = entry.file.lastModified ? new Date(entry.file.lastModified) : null
    if (format === 'markdown') {
      const { frontmatter, body } = parseFrontmatter(text)
      const ctx = await buildContext(entry.path, collectMarkdownTargets(body))
      const blocks = ensureTitle(markdownToBlocks(body, ctx), frontmatter.title || titleFromFilename(name))
      const createdAt = parseDate(frontmatter.creation_date) || fileDate
      return { blocks, createdAt, updatedAt: parseDate(frontmatter.modification_date) || createdAt }
    }
    const ctx = await buildContext(entry.path, collectHtmlTargets(text, parser))
    const createdAt = dateFromHtmlFilename(name) || fileDate
    return { blocks: htmlToBlocks(text, ctx, parser), createdAt, updatedAt: createdAt }
  }

  const now = Date.now()
  const clampDate = (date) => (date && date.getTime() <= now ? date.toISOString() : undefined)

  for (let index = 0; index < notes.length; index += 1) {
    if (signal?.aborted) {
      break
    }
    const entry = notes[index]
    try {
      const text = await entry.file.text()
      const key = await fingerprint(entry.path, text)
      if (imported.has(key)) {
        summary.skipped += 1
      } else {
        const { blocks, createdAt, updatedAt } = await convert(entry, text)
        const content = { type: 'doc', content: blocks }
        const { note } = await api.post('/api/notes', { createdAt: clampDate(createdAt) })
        await api.put(`/api/notes/${note.id}`, {
          baseRevision: 0,
          encryptedContent: await vault.encryptJson(content, CONTEXTS.noteContent(note.id), { revision: 1 }),
          encryptedSummary: await vault.encryptJson(createNoteSummary(content), CONTEXTS.noteSummary(note.id)),
          blobIds: blobIdsForSave(content),
          reason: 'import',
          updatedAt: clampDate(updatedAt) || clampDate(createdAt),
        })
        imported.add(key)
        summary.created += 1
        if (summary.created % 25 === 0) {
          await setMeta(userId, 'imported-sources', [...imported])
        }
      }
    } catch (error) {
      summary.failed.push({ path: entry.path, message: error.message })
    }
    onProgress({ done: index + 1, total: notes.length, ...summary })
  }

  await setMeta(userId, 'imported-sources', [...imported])
  return summary
}
