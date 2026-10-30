import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDevice, fastArgon2, startServer } from '../test/serverHarness.js'
import { signup } from './account.js'
import { fetchAttachmentBytes } from './attachments.js'
import { CONTEXTS } from './envelope.js'
import { rescueLegacyAttachments, scanLegacyAttachments } from './legacyRescue.js'
import { parseAttachmentHref } from './noteContent.js'

let server

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.stop()
})

describe('CRYPTO-3: rescuing attachments of accounts migrated by 1.x', () => {
  it('re-encrypts linked legacy files, rewrites the notes and quarantines the plaintext', async () => {
    const device = createDevice(server.base)
    const { data, vault } = await signup({
      api: device.api,
      email: `rescue-${Date.now()}@example.com`,
      password: 'correct horse battery staple',
      firstName: 'R',
      lastName: 'S',
      argon2id: fastArgon2,
    })
    const userId = data.user.id
    const pdf = `imported-u${userId}-cccccccccccc-tax-return.pdf`
    const foreign = 'imported-someone-elses.pdf'
    await fsp.mkdir(server.config.storage.legacyUploadsDir, { recursive: true })
    await fsp.writeFile(path.join(server.config.storage.legacyUploadsDir, pdf), 'TAX PDF')
    await server.pool.query("INSERT INTO legacy_uploads (filename, user_id, source) VALUES ($1, $2, 'prefix:import')", [pdf, userId])

    // A note as 1.x left it: encrypted, but its link still targets the
    // plaintext upload (which the SPA answered with index.html).
    const created = await device.api.post('/api/notes', {})
    const noteId = created.note.id
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Taxes', marks: [{ type: 'link', attrs: { href: `/api/uploads/${pdf}` } }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'theirs', marks: [{ type: 'link', attrs: { href: `/api/uploads/${foreign}` } }] }] },
      ],
    }
    await device.api.put(`/api/notes/${noteId}`, {
      baseRevision: 0,
      encryptedContent: await vault.encryptJson(content, CONTEXTS.noteContent(noteId), { revision: 1 }),
      encryptedSummary: await vault.encryptJson({ title: 'Taxes' }, CONTEXTS.noteSummary(noteId)),
      blobIds: [],
    })

    const scan = await scanLegacyAttachments({ api: device.api, vault })
    expect(scan.files.map((f) => f.filename)).toEqual([pdf])
    expect(scan.notes).toEqual([{ id: noteId, filenames: [pdf] }])
    expect(scan.unavailable).toEqual([foreign])

    const result = await rescueLegacyAttachments({ api: device.api, vault, scan })
    expect(result).toMatchObject({ notesUpdated: 1, filesRescued: 1, released: [pdf] })

    const row = (await server.pool.query('SELECT encrypted_content FROM notes WHERE id = $1', [noteId])).rows[0]
    const rewritten = await vault.decryptJson(row.encrypted_content, CONTEXTS.noteContent(noteId))
    const attachment = parseAttachmentHref(rewritten.content[0].content[0].marks[0].attrs.href)
    expect(attachment.name).toBe(pdf)
    expect(new TextDecoder().decode(await fetchAttachmentBytes({ api: device.api, vault, reference: attachment }))).toBe('TAX PDF')
    // The link to a file this account does not own is left untouched.
    expect(rewritten.content[1].content[0].marks[0].attrs.href).toBe(`/api/uploads/${foreign}`)

    // The plaintext original left the served directory.
    expect(await fsp.readdir(server.config.storage.legacyUploadsDir)).not.toContain(pdf)
    expect((await scanLegacyAttachments({ api: device.api, vault })).files).toEqual([])
  })
})
