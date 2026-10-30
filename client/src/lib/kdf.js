// Argon2id for derivePasswordMaterial: in a Web Worker when possible, on the
// main thread otherwise (same library, so identical output either way).
let workerState = null

function unavailable(message) {
  const error = new Error(message)
  error.fallback = true
  return error
}

function startWorker() {
  if (typeof Worker === 'undefined') {
    return 'unavailable'
  }
  try {
    const worker = new Worker(new URL('../workers/argon2.worker.js', import.meta.url), { type: 'module' })
    const state = { worker, pending: new Map(), nextId: 1 }
    worker.onmessage = (event) => {
      const { id, hash, error } = event.data || {}
      const entry = state.pending.get(id)
      if (!entry) {
        return
      }
      state.pending.delete(id)
      if (error) {
        entry.reject(new Error(error))
      } else {
        entry.resolve(new Uint8Array(hash))
      }
    }
    worker.onerror = () => {
      for (const entry of state.pending.values()) {
        entry.reject(unavailable('Key derivation worker failed'))
      }
      state.pending.clear()
      worker.terminate()
      workerState = 'unavailable'
    }
    return state
  } catch {
    return 'unavailable'
  }
}

function deriveInWorker(input) {
  if (workerState === null) {
    workerState = startWorker()
  }
  if (workerState === 'unavailable') {
    return Promise.reject(unavailable('Workers are unavailable'))
  }
  const state = workerState
  const id = state.nextId++
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject })
    state.worker.postMessage({ id, ...input })
  })
}

async function deriveOnMainThread({ password, salt, time, mem, hashLen, parallelism }) {
  const { default: argon2 } = await import('argon2-browser/dist/argon2-bundled.min.js')
  const result = await argon2.hash({
    pass: password,
    salt,
    time,
    mem,
    hashLen,
    parallelism,
    type: argon2.ArgonType.Argon2id,
  })
  return new Uint8Array(result.hash)
}

export async function argon2id(input) {
  try {
    return await deriveInWorker(input)
  } catch (error) {
    if (!error.fallback) {
      throw error
    }
    return deriveOnMainThread(input)
  }
}
