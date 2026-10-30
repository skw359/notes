import argon2 from 'argon2-browser/dist/argon2-bundled.min.js'

// Argon2id off the main thread: a 64 MiB derivation used to freeze the UI
// for about a second on every login and unlock.
self.onmessage = async (event) => {
  const { id, password, salt, time, mem, hashLen, parallelism } = event.data || {}
  try {
    const result = await argon2.hash({
      pass: password,
      salt,
      time,
      mem,
      hashLen,
      parallelism,
      type: argon2.ArgonType.Argon2id,
    })
    const hash = new Uint8Array(result.hash)
    self.postMessage({ id, hash }, [hash.buffer])
  } catch (error) {
    self.postMessage({ id, error: error?.message || 'Key derivation failed' })
  }
}
