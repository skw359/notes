const DB_NAME = 'notes-persistent-cache'
const DB_VERSION = 1
const SUMMARY_STORE = 'summary_lists'
const BODY_STORE = 'note_bodies'
const SEARCH_STORE = 'note_search'

let dbPromise = null

function supportsIndexedDb() {
  return typeof indexedDB !== 'undefined'
}

function openDb() {
  if (!supportsIndexedDb()) {
    return Promise.resolve(null)
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result

        if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
          db.createObjectStore(SUMMARY_STORE, { keyPath: 'id' })
        }

        if (!db.objectStoreNames.contains(BODY_STORE)) {
          db.createObjectStore(BODY_STORE, { keyPath: 'id' })
        }

        if (!db.objectStoreNames.contains(SEARCH_STORE)) {
          db.createObjectStore(SEARCH_STORE, { keyPath: 'id' })
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Failed to open local cache'))
    }).catch((error) => {
      dbPromise = null
      throw error
    })
  }

  return dbPromise
}

function summaryKey(userId, scope) {
  return `${userId}:${scope}`
}

function noteKey(userId, noteId) {
  return `${userId}:${noteId}`
}

async function getRecord(storeName, key) {
  const db = await openDb()
  if (!db) {
    return null
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const request = store.get(key)

    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error || new Error('Failed to read local cache'))
  })
}

async function putRecord(storeName, value) {
  const db = await openDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    store.put(value)

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('Failed to write local cache'))
    tx.onabort = () => reject(tx.error || new Error('Local cache write aborted'))
  })
}

async function deleteRecord(storeName, key) {
  const db = await openDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    store.delete(key)

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('Failed to delete local cache entry'))
    tx.onabort = () => reject(tx.error || new Error('Local cache delete aborted'))
  })
}

export async function getCachedSummaryList(userId, scope) {
  const record = await getRecord(SUMMARY_STORE, summaryKey(userId, scope))
  return record?.notes || null
}

export async function setCachedSummaryList(userId, scope, notes) {
  await putRecord(SUMMARY_STORE, {
    id: summaryKey(userId, scope),
    userId: String(userId),
    scope,
    notes,
    cachedAt: Date.now(),
  })
}

export async function getCachedNote(userId, noteId) {
  const record = await getRecord(BODY_STORE, noteKey(userId, noteId))
  return record?.note || null
}

export async function setCachedNote(userId, note) {
  await putRecord(BODY_STORE, {
    id: noteKey(userId, note.id),
    userId: String(userId),
    noteId: String(note.id),
    note,
    updatedAt: note.updated_at || null,
    cachedAt: Date.now(),
  })
}

export async function deleteCachedNote(userId, noteId) {
  await deleteRecord(BODY_STORE, noteKey(userId, noteId))
}

export async function getCachedSearchEntry(userId, noteId) {
  const record = await getRecord(SEARCH_STORE, noteKey(userId, noteId))
  return record || null
}

export async function setCachedSearchEntry(userId, noteId, encryptedSearchText, updatedAt) {
  await putRecord(SEARCH_STORE, {
    id: noteKey(userId, noteId),
    userId: String(userId),
    noteId: String(noteId),
    encryptedSearchText,
    updatedAt: updatedAt || null,
    cachedAt: Date.now(),
  })
}

export async function deleteCachedSearchEntry(userId, noteId) {
  await deleteRecord(SEARCH_STORE, noteKey(userId, noteId))
}
