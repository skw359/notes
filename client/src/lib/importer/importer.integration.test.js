// @vitest-environment jsdom
import 'fake-indexeddb/auto'
// Browser-like File (text()/arrayBuffer(); jsdom's File lacks them).
import { File } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDevice, fastArgon2, startServer } from '../../test/serverHarness.js'
import { signup } from '../account.js'
import { fetchAttachmentBytes } from '../attachments.js'
import { CONTEXTS } from '../envelope.js'
import { collectBlobReferences } from '../noteContent.js'
import { buildImportPlan, runImport } from './index.js'

let server

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.stop()
})

function fileAt(path, contents, type = '') {
  const file = new File([contents], path.split('/').pop(), { type, lastModified: Date.UTC(2023, 4, 6) })
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

describe('in-browser import (ARCH-4)', () => {
  it('imports an export encrypted, with media and original dates, and skips it the second time', async () => {
    const device = createDevice(server.base)
    const { data, vault } = await signup({
      api: device.api,
      email: `import-${Date.now()}@example.com`,
      password: 'correct horse battery staple',
      firstName: 'I',
      lastName: 'M',
      argon2id: fastArgon2,
    })

    const files = [
      fileAt(
        'iCloud/Notes/Groceries-02-01-2024.md',
        '---\ntitle: Groceries\ncreation_date: 2024-01-02T10:00:00Z\nmodification_date: 2024-03-04T10:00:00Z\n---\n- milk\n\n![receipt](images/receipt.png)\n[scan](attachments/scan.pdf)\n![gone](images/nowhere.png)\n[secrets](../../server/.env)'
      ),
      fileAt('iCloud/Notes/Plain.md', 'Just text'),
      fileAt('iCloud/Notes/images/receipt.png', 'PNG DATA', 'image/png'),
      fileAt('iCloud/Notes/attachments/scan.pdf', 'PDF DATA', 'application/pdf'),
      fileAt('server/.env', 'JWT_SECRET=should-never-upload'),
    ]
    const plan = buildImportPlan(files)
    const summary = await runImport({ api: device.api, vault, plan, format: 'markdown', userId: data.user.id })
    expect(summary).toMatchObject({ created: 2, skipped: 0, failed: [], attachments: 2, missingMedia: 1 })

    const rows = (await server.pool.query('SELECT * FROM notes WHERE user_id = $1 ORDER BY id', [data.user.id])).rows
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.content === null && row.encrypted_content)).toBe(true)
    const groceries = rows[0]
    expect(groceries.created_at.toISOString()).toBe('2024-01-02T10:00:00.000Z')
    expect(groceries.updated_at.toISOString()).toBe('2024-03-04T10:00:00.000Z')

    const content = await vault.decryptJson(groceries.encrypted_content, CONTEXTS.noteContent(groceries.id))
    expect(content.content[0]).toMatchObject({ type: 'heading', content: [{ text: 'Groceries' }] })
    const references = [...collectBlobReferences(content).values()]
    expect(references).toHaveLength(2)
    const pdf = references.find((ref) => ref.name === 'scan.pdf')
    expect(new TextDecoder().decode(await fetchAttachmentBytes({ api: device.api, vault, reference: pdf }))).toBe('PDF DATA')
    expect(JSON.stringify(content)).toContain('[Image unavailable: images/nowhere.png]')

    // Nothing outside the media folders was uploaded.
    const blobs = await server.pool.query('SELECT byte_length FROM blobs WHERE user_id = $1', [data.user.id])
    expect(blobs.rows).toHaveLength(2)

    const again = await runImport({ api: device.api, vault, plan, format: 'markdown', userId: data.user.id })
    expect(again).toMatchObject({ created: 0, skipped: 2 })
  })
})
