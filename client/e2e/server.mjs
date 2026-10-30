// Started by Playwright (webServer): the real app on an isolated test
// database, plus a test-only control port for inspecting that database.
// Never part of the application.
import { createHmac, hkdfSync } from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectGarbageBlobs } from '../../server/services/blobs.js'
import { createTestApp, insertLegacyNote, insertLegacyUser } from '../../server/test/helpers/testApp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '..', '..', 'server', 'package.json'))
const argon2 = require('argon2')

const APP_PORT = Number(process.env.E2E_APP_PORT || 4610)
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT || 4611)

const testApp = await createTestApp({ standalone: true, clientDist: path.join(here, '..', 'dist') })
const appServer = testApp.app.listen(APP_PORT, '127.0.0.1')

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

// Recomputes the auth secret with the native Argon2id reference and compares
// it with what the browser registered (via the stored HMAC verifier).
async function verifyDerivation({ email, password }) {
  const user = (await testApp.pool.query('SELECT auth_salt, kdf_params, auth_verifier_hash FROM users WHERE email = $1', [email])).rows[0]
  const salt = Buffer.from(user.auth_salt, 'base64')
  const master = await argon2.hash(password, {
    type: argon2.argon2id,
    salt,
    timeCost: user.kdf_params.time,
    memoryCost: user.kdf_params.mem,
    parallelism: user.kdf_params.parallelism,
    hashLength: 32,
    raw: true,
  })
  const authSecret = Buffer.from(hkdfSync('sha256', master, salt, Buffer.from('notes-auth-secret-v1'), 32)).toString('base64url')
  const pepper = (await testApp.pool.query("SELECT value FROM server_settings WHERE key = 'verifier_pepper'")).rows[0].value
  const expected = `hmac-sha256$v1$${createHmac('sha256', Buffer.from(pepper, 'base64')).update(authSecret).digest('base64url')}`
  return { matches: expected === user.auth_verifier_hash, kdfParams: user.kdf_params }
}

// A pre-encryption (1.x) account: plaintext notes and uploaded files.
async function createLegacyAccount({ email, password, files = {}, notes = [] }) {
  const { user } = await insertLegacyUser(testApp.pool, { email, password })
  const dir = testApp.config.storage.legacyUploadsDir
  await fsp.mkdir(dir, { recursive: true })
  for (const [filename, base64] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, filename), Buffer.from(base64, 'base64'))
    await testApp.pool.query("INSERT INTO legacy_uploads (filename, user_id, source) VALUES ($1, $2, 'e2e')", [filename, user.id])
  }
  for (const content of notes) {
    await insertLegacyNote(testApp.pool, user.id, content)
  }
  return { userId: user.id }
}

// The blob garbage collector with no grace period.
async function collectGarbage() {
  const config = { ...testApp.config, retention: { ...testApp.config.retention, blobGraceMs: 0 } }
  return collectGarbageBlobs({ pool: testApp.pool, storage: testApp.ctx.storage, config, log: console })
}

const control = http.createServer(async (req, res) => {
  try {
    let result
    if (req.url === '/health') {
      result = { ok: true }
    } else if (req.url === '/sql' && req.method === 'POST') {
      const { text, params } = await readJson(req)
      result = { rows: (await testApp.pool.query(text, params || [])).rows }
    } else if (req.url === '/verify-derivation' && req.method === 'POST') {
      result = await verifyDerivation(await readJson(req))
    } else if (req.url === '/config') {
      result = { storage: testApp.config.storage }
    } else if (req.url === '/legacy-account' && req.method === 'POST') {
      result = await createLegacyAccount(await readJson(req))
    } else if (req.url === '/legacy-files') {
      result = { files: await fsp.readdir(testApp.config.storage.legacyUploadsDir).catch(() => []) }
    } else if (req.url === '/gc' && req.method === 'POST') {
      result = await collectGarbage()
    } else {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }))
  }
})
control.listen(CONTROL_PORT, '127.0.0.1')

async function shutdown() {
  control.close()
  appServer.close()
  await testApp.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
console.log(`e2e app on http://127.0.0.1:${APP_PORT}, control on ${CONTROL_PORT}`)
