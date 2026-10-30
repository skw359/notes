// Device-local storage. Holds ciphertext and metadata only, never plaintext:
//   summary_lists  last summary list per user (encrypted summaries)
//   note_bodies    encrypted note bodies, keyed by revision
//   note_search    search text, encrypted under the vault key
//   outbox         saves not yet confirmed by the server (encrypted), so an
//                  edit survives reloads, crashes and offline periods
//   meta           sync position, revision high-water marks, settings
// Every operation degrades to a no-op if IndexedDB is unavailable.
const DB_NAME = 'notes-persistent-cache'
const DB_VERSION = 2
const SUMMARY_STORE = 'summary_lists'
const BODY_STORE = 'note_bodies'
const SEARCH_STORE = 'note_search'
const OUTBOX_STORE = 'outbox'
const META_STORE = 'meta'
const ALL_STORES = [SUMMARY_STORE, BODY_STORE, SEARCH_STORE, OUTBOX_STORE, META_STORE]
// The cache is an optimization: an operation that does not finish in time
// (a tab of an older app version blocking the schema upgrade, a lost
// connection in Safari) is treated as a cache miss instead of stalling the app.
const BLOCKED_GRACE_MS = 3000
const OPERATION_TIMEOUT_MS = 5000

let dbPromise = null

function openDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null)
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let settled = false
      const finish = (db) => {
        if (!settled) {
          settled = true
          resolve(db)
        }
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        for (const name of ALL_STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' })
          }
        }
      }
      request.onsuccess = () => {
        const db = request.result
        // Another tab upgrading the schema must not be blocked by this one.
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        if (settled) {
          // Opened after this page gave up waiting: use it from now on.
          dbPromise = Promise.resolve(db)
          return
        }
        finish(db)
      }
      request.onerror = () => {
        if (!settled) {
          reject(request.error || new Error('Failed to open local cache'))
        }
      }
      // An open tab of an older app version holds the database at its old
      // version; work without the cache until that tab is closed.
      request.onblocked = () => {
        setTimeout(() => finish(null), BLOCKED_GRACE_MS)
      }
    }).catch(() => {
      dbPromise = null
      return null
    })
  }
  return dbPromise
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(storeName, mode, fn) {
  const db = await openDb()
  if (!db) {
    return null
  }
  return new Promise((resolve, reject) => {
    let result
    const timer = setTimeout(() => reject(new Error('Local storage timed out')), OPERATION_TIMEOUT_MS)
    const done = (callback) => (value) => {
      clearTimeout(timer)
      callback(value)
    }
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    Promise.resolve(fn(store))
      .then((value) => {
        result = value
      })
      .catch(done(reject))
    tx.oncomplete = () => done(resolve)(result)
    tx.onerror = () => done(reject)(tx.error || new Error('Local storage failed'))
    tx.onabort = () => done(reject)(tx.error || new Error('Local storage aborted'))
  })
}

async function getRecord(storeName, key) {
  try {
    return (await withStore(storeName, 'readonly', (store) => requestToPromise(store.get(key)))) || null
  } catch {
    return null
  }
}

async function putRecord(storeName, value) {
  try {
    await withStore(storeName, 'readwrite', (store) => requestToPromise(store.put(value)))
    return true
  } catch {
    return false
  }
}

async function deleteRecord(storeName, key) {
  try {
    await withStore(storeName, 'readwrite', (store) => requestToPromise(store.delete(key)))
  } catch {
    // best effort
  }
}

async function getAllForUser(storeName, userId) {
  try {
    const all = (await withStore(storeName, 'readonly', (store) => requestToPromise(store.getAll()))) || []
    return all.filter((record) => record.userId === String(userId))
  } catch {
    return []
  }
}

const userKey = (userId, suffix) => `${userId}:${suffix}`

// ── Summary lists ──────────────────────────────────────────────────────
export async function getCachedSummaryList(userId, scope) {
  return (await getRecord(SUMMARY_STORE, userKey(userId, scope)))?.notes || null
}

export async function setCachedSummaryList(userId, scope, notes, seq = null) {
  return putRecord(SUMMARY_STORE, {
    id: userKey(userId, scope),
    userId: String(userId),
    scope,
    notes,
    seq,
    cachedAt: Date.now(),
  })
}

export async function getCachedSummaryRecord(userId, scope) {
  return getRecord(SUMMARY_STORE, userKey(userId, scope))
}

// ── Encrypted note bodies ──────────────────────────────────────────────
export async function getCachedNote(userId, noteId) {
  return (await getRecord(BODY_STORE, userKey(userId, noteId)))?.note || null
}

export async function setCachedNote(userId, note) {
  return putRecord(BODY_STORE, {
    id: userKey(userId, note.id),
    userId: String(userId),
    noteId: String(note.id),
    note,
    revision: note.revision ?? null,
    cachedAt: Date.now(),
  })
}

export async function deleteCachedNote(userId, noteId) {
  await deleteRecord(BODY_STORE, userKey(userId, noteId))
}

// ── Encrypted search text ──────────────────────────────────────────────
export async function getCachedSearchEntry(userId, noteId) {
  return getRecord(SEARCH_STORE, userKey(userId, noteId))
}

export async function setCachedSearchEntry(userId, noteId, encryptedSearchText, revision) {
  return putRecord(SEARCH_STORE, {
    id: userKey(userId, noteId),
    userId: String(userId),
    noteId: String(noteId),
    encryptedSearchText,
    revision: revision ?? null,
    cachedAt: Date.now(),
  })
}

export async function deleteCachedSearchEntry(userId, noteId) {
  await deleteRecord(SEARCH_STORE, userKey(userId, noteId))
}

// ── Outbox (pending encrypted saves) ───────────────────────────────────
export async function getOutboxEntries(userId) {
  return getAllForUser(OUTBOX_STORE, userId)
}

export async function putOutboxEntry(userId, entry) {
  return putRecord(OUTBOX_STORE, { ...entry, id: userKey(userId, entry.noteId), userId: String(userId) })
}

export async function deleteOutboxEntry(userId, noteId) {
  await deleteRecord(OUTBOX_STORE, userKey(userId, noteId))
}

// ── Meta (sync position, high-water marks, device settings) ─────────────
export async function getMeta(userId, key) {
  return (await getRecord(META_STORE, userKey(userId, key)))?.value ?? null
}

export async function setMeta(userId, key, value) {
  return putRecord(META_STORE, { id: userKey(userId, key), userId: String(userId), key, value })
}

// CRYPTO-5: the highest revision of each note this device has seen. A server
// answering with a lower one is rolling the note back.
export async function getRevisionHighWater(userId) {
  return (await getMeta(userId, 'revision-high-water')) || {}
}

export async function setRevisionHighWater(userId, marks) {
  return setMeta(userId, 'revision-high-water', marks)
}

/**
 * Removes this user's data from the device (logout, account deletion,
 * SEC-11). Unsent encrypted drafts are kept unless `includeOutbox` is set,
 * so logging out can never destroy an edit that has not reached the server.
 */
export async function clearUserData(userId, { includeOutbox = false } = {}) {
  const stores = includeOutbox ? ALL_STORES : ALL_STORES.filter((name) => name !== OUTBOX_STORE)
  for (const storeName of stores) {
    const records = await getAllForUser(storeName, userId)
    for (const record of records) {
      await deleteRecord(storeName, record.id)
    }
  }
}

export async function countOutboxEntries(userId) {
  return (await getOutboxEntries(userId)).length
}
