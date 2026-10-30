import { createHash } from 'node:crypto'
// The real server, on a private test database (see server/test/helpers).
import { createTestApp } from '../../../server/test/helpers/testApp.js'
import { createApiClient } from '../lib/api.js'

export async function startServer(options = {}) {
  const testApp = await createTestApp({ standalone: true, ...options })
  const server = testApp.app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    ...testApp,
    base,
    async stop() {
      await new Promise((resolve) => server.close(resolve))
      await testApp.close()
    },
  }
}

// One browser profile: its own cookie jar, and a switch to simulate going
// offline (requests fail like a dropped network).
export function createDevice(base) {
  const jar = new Map()
  let offline = false
  const fetchImpl = async (path, init = {}) => {
    if (offline) {
      throw new TypeError('Failed to fetch')
    }
    const headers = new Headers(init.headers || {})
    if (jar.size) {
      headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    const response = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index)
      const value = pair.slice(index + 1)
      if (!value || /expires=thu, 01 jan 1970/i.test(cookie)) {
        jar.delete(name)
      } else {
        jar.set(name, value)
      }
    }
    return response
  }
  return {
    api: createApiClient({ fetchImpl }),
    jar,
    setOffline(value) {
      offline = value
    },
  }
}

// Deterministic, fast stand-in for Argon2id (the real KDF is covered by the
// known-answer tests and the browser E2E suite).
export async function fastArgon2({ password, salt }) {
  return Uint8Array.from(createHash('sha256').update(String(password)).update(Buffer.from(salt)).digest())
}
