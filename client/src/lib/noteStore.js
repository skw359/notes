import { ApiError, isRetryable } from './api.js'
import {
  EMPTY_NOTE_SUMMARY,
  blobIdsForSave,
  createEmptyNoteContent,
  createNoteSearchText,
  createNoteSummary,
  getSummarySearchText,
} from './noteContent.js'
import * as localCache from './persistentNoteCache.js'

const PAGE_SIZE = 1000
const BATCH_SIZE = 100
const BODY_CACHE_LIMIT = 20
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000]
const CONFLICT_CODES = new Set(['REVISION_CONFLICT', 'CLIENT_OUTDATED', 'NOTE_TRASHED', 'NOTE_DELETED', 'NOTE_NOT_FOUND'])

function normalizeSummary(summary) {
  return {
    title: summary?.title || EMPTY_NOTE_SUMMARY.title,
    preview: summary?.preview || EMPTY_NOTE_SUMMARY.preview,
  }
}

function timeOf(value) {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

function sortActive(list) {
  return list.sort((a, b) => b._updated - a._updated || b._created - a._created || b.id - a.id)
}

function sortTrash(list) {
  return list.sort((a, b) => b._deleted - a._deleted || b._updated - a._updated || b.id - a.id)
}

function chunk(list, size) {
  const chunks = []
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size))
  }
  return chunks
}

export function describeDecryptError(error, envelope) {
  return {
    code: error?.code || 'DECRYPT_FAILED',
    message: error?.message || 'This note could not be decrypted',
    envelopeVersion: envelope?.version ?? null,
    context: envelope?.context ?? null,
    keyId: envelope?.keyId ?? null,
  }
}

/**
 * Client-side source of truth for notes (ARCH-1). Framework-free so it can be
 * unit-tested; React subscribes through useSyncExternalStore.
 *
 * Saving: every save carries the revision it was based on. Unsent edits sit
 * in an encrypted, durable outbox (IndexedDB) until the server confirms
 * them, are retried with backoff while offline, pause while the session is
 * expired, and turn into an explicit conflict instead of overwriting newer
 * data (DATA-2, DATA-3). Nothing is dropped without a user decision.
 */
export function createNoteStore({
  api,
  codec,
  userId,
  cache = localCache,
  // () => undefined while the profile is unknown, else { blobId, profileIv }
  // (the IV of the profile envelope the blob id was read from).
  getProfileReference = () => undefined,
  now = () => Date.now(),
  timers = { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (id) => globalThis.clearTimeout(id) },
  log = console,
}) {
  const durable = Boolean(codec.durable && cache)
  const records = new Map()
  const saves = new Map()
  const bodies = new Map()
  const searchIndex = new Map()
  const summaryCache = new Map()
  const summaryRepairs = new Set()
  const refsScan = new Map()
  const listeners = new Set()
  const eventListeners = new Set()

  let highWater = {}
  let highWaterTimer = null
  let listCacheTimer = null
  let seq = 0
  let status = 'idle'
  let error = null
  let trashLoaded = false
  let sessionExpired = false
  let indexing = { running: false, indexed: 0, total: 0 }
  let refs = { checked: false, enabled: null }
  let openNoteId = null
  let syncing = null
  let stopped = false
  let version = 0
  let listDirty = true
  let lists = { notes: [], trash: [] }
  let snapshot = null

  // ── subscription ──────────────────────────────────────────────────────
  function notify({ list = false } = {}) {
    version += 1
    if (list) {
      listDirty = true
    }
    snapshot = null
    for (const listener of listeners) {
      listener()
    }
  }

  function emit(event) {
    for (const listener of eventListeners) {
      try {
        listener(event)
      } catch (listenerError) {
        log.error?.(listenerError)
      }
    }
  }

  function saveStates() {
    const states = {}
    for (const [id, slot] of saves) {
      if (slot.state && slot.state !== 'saved') {
        states[id] = { state: slot.state, error: slot.error, conflict: slot.conflict }
      }
    }
    return states
  }

  function getSnapshot() {
    if (!snapshot) {
      if (listDirty) {
        const active = []
        const trash = []
        for (const record of records.values()) {
          if (record.revision === 0 && !saves.has(record.id)) {
            continue
          }
          ;(record.deleted_at ? trash : active).push(record)
        }
        lists = { notes: sortActive(active), trash: sortTrash(trash) }
        listDirty = false
      }
      const states = saveStates()
      snapshot = Object.freeze({
        version,
        status,
        error,
        trashLoaded,
        sessionExpired,
        notes: lists.notes,
        trash: lists.trash,
        saveStates: states,
        unsavedCount: Object.values(states).filter((s) => s.state !== 'saved').length,
        // Notes whose unsaved edits need a decision, including ones that are
        // not in the visible list (e.g. trashed or deleted elsewhere).
        attention: Object.entries(states)
          .filter(([, s]) => s.state === 'conflict' || s.state === 'failed')
          .map(([id]) => Number(id)),
        search: { ...indexing },
        refs: { ...refs },
      })
    }
    return snapshot
  }

  // ── records ───────────────────────────────────────────────────────────
  function trackRevision(id, revision) {
    if (!durable || !revision) {
      return
    }
    if (!highWater[id] || revision > highWater[id]) {
      highWater[id] = revision
      timers.clearTimeout(highWaterTimer)
      highWaterTimer = timers.setTimeout(() => {
        void cache.setRevisionHighWater(userId, highWater)
      }, 1000)
    }
  }

  function setRecord(row, summaryResult) {
    const previous = records.get(row.id)
    const record = {
      id: row.id,
      revision: row.revision ?? 0,
      sync_seq: row.sync_seq ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at ?? null,
      has_conflict: Boolean(row.has_conflict),
      plaintext_residue: Boolean(row.plaintext_residue),
      encrypted_summary: row.encrypted_summary ?? null,
      content: codec.kind === 'legacy' ? row.content : undefined,
      // An unreadable summary is shown as such, not as "Untitled" (DATA-8).
      summary: summaryResult?.summary
        ? normalizeSummary(summaryResult.summary)
        : summaryResult?.error && !previous?._summaryKey
          ? { title: '', preview: '' }
          : normalizeSummary(previous?.summary),
      decryptError: summaryResult?.error || null,
      _summaryKey: summaryResult?.summary ? JSON.stringify(normalizeSummary(summaryResult.summary)) : previous?._summaryKey,
      _updated: timeOf(row.updated_at),
      _created: timeOf(row.created_at),
      _deleted: timeOf(row.deleted_at),
    }
    // CRYPTO-5: a server serving a lower revision than this device has seen
    // is rolling the note back.
    const seen = highWater[row.id]
    if (seen && record.revision && record.revision < seen) {
      record.rollback = { seen, served: record.revision }
      emit({ type: 'rollback', id: row.id, seen, served: record.revision })
    }
    records.set(row.id, record)
    trackRevision(row.id, record.revision)

    // sync_seq also moves when content changed without a revision bump
    // (out-of-band writes), so cached bodies are checked against it.
    if (previous && (previous.revision !== record.revision || previous.sync_seq !== record.sync_seq)) {
      bodies.delete(row.id)
    }
    if (previous && previous.revision !== record.revision) {
      onRemoteChange(row.id, record.revision)
    }
    return record
  }

  async function decryptSummaryFor(row) {
    if (codec.kind === 'legacy') {
      return { summary: await codec.decryptSummary(row) }
    }
    const iv = row.encrypted_summary?.iv
    const cacheKey = iv ? `${row.id}:${iv}` : null
    if (cacheKey && summaryCache.has(cacheKey)) {
      return { summary: summaryCache.get(cacheKey) }
    }
    if (!row.encrypted_summary) {
      return { summary: EMPTY_NOTE_SUMMARY }
    }
    try {
      const summary = await codec.decryptSummary(row)
      summaryCache.set(cacheKey, summary)
      return { summary }
    } catch (decryptError) {
      // DATA-8: one bad record is shown as such; it never empties the list.
      return { error: describeDecryptError(decryptError, row.encrypted_summary) }
    }
  }

  async function ingestRows(rows, { replaceScope } = {}) {
    const results = await Promise.all(rows.map(async (row) => [row, await decryptSummaryFor(row)]))
    if (replaceScope) {
      const keep = new Set(rows.map((row) => row.id))
      for (const record of [...records.values()]) {
        const inScope = replaceScope === 'trash' ? Boolean(record.deleted_at) : !record.deleted_at
        if (inScope && !keep.has(record.id) && !saves.has(record.id)) {
          records.delete(record.id)
        }
      }
    }
    for (const [row, summaryResult] of results) {
      setRecord(row, summaryResult)
      if (codec.kind === 'legacy' && row.content) {
        searchIndex.set(row.id, { revision: row.revision, text: createNoteSearchText(row.content) })
      }
    }
    notify({ list: true })
  }

  function rowFromRecord(record) {
    return {
      id: record.id,
      revision: record.revision,
      sync_seq: record.sync_seq,
      created_at: record.created_at,
      updated_at: record.updated_at,
      deleted_at: record.deleted_at,
      has_conflict: record.has_conflict,
      plaintext_residue: record.plaintext_residue,
      encrypted_summary: record.encrypted_summary,
    }
  }

  function persistListSoon() {
    if (!durable) {
      return
    }
    timers.clearTimeout(listCacheTimer)
    listCacheTimer = timers.setTimeout(() => {
      const active = [...records.values()].filter((r) => !r.deleted_at && r.revision > 0).map(rowFromRecord)
      void cache.setCachedSummaryList(userId, 'active', active, seq)
      if (trashLoaded) {
        const trash = [...records.values()].filter((r) => r.deleted_at).map(rowFromRecord)
        void cache.setCachedSummaryList(userId, 'trash', trash, seq)
      }
    }, 1500)
  }

  function removeRecord(id, reason) {
    if (!records.has(id)) {
      return
    }
    records.delete(id)
    bodies.delete(id)
    searchIndex.delete(id)
    delete highWater[id]
    if (durable) {
      void cache.deleteCachedNote(userId, id)
      void cache.deleteCachedSearchEntry(userId, id)
    }
    if (id === openNoteId) {
      emit({ type: 'note-removed', id, reason })
    }
    notify({ list: true })
  }

  function onRemoteChange(id, revision) {
    if (id !== openNoteId) {
      return
    }
    const slot = saves.get(id)
    if (slot && (slot.pending || slot.outbox || slot.inFlight || slot.conflict)) {
      // Our own pending edit wins the race to the user: its save will hit a
      // conflict and the user decides.
      return
    }
    if (slot?.lastSavedRevision === revision) {
      return
    }
    emit({ type: 'note-replaced', id, reason: 'remote' })
  }

  // ── loading and sync ──────────────────────────────────────────────────
  async function loadFullList(scope) {
    const path = scope === 'trash' ? '/api/notes/trash' : '/api/notes'
    const rows = []
    let cursor = null
    let firstSeq = null
    let pages = 0
    do {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (cursor) {
        query.set('cursor', cursor)
      }
      const page = await api.get(`${path}?${query}`)
      firstSeq ??= page.seq
      rows.push(...page.notes)
      cursor = page.nextCursor
      pages += 1
    } while (cursor && !stopped)

    await ingestRows(rows, { replaceScope: scope })
    if (scope === 'trash') {
      trashLoaded = true
    } else if (typeof firstSeq === 'number') {
      seq = Math.max(seq, firstSeq)
    }
    persistListSoon()
    // Changes made while paging are picked up by a delta sync.
    if (pages > 1) {
      await sync()
    }
    notify({ list: true })
  }

  async function start() {
    status = 'loading'
    notify()
    if (durable) {
      highWater = await cache.getRevisionHighWater(userId)
      const cached = await cache.getCachedSummaryRecord(userId, 'active')
      if (cached?.notes?.length) {
        await ingestRows(cached.notes, { replaceScope: 'active' })
        status = 'ready'
        notify()
      }
    }

    try {
      await loadFullList('active')
      error = null
    } catch (loadError) {
      // With a cached list the user can keep working; the error stays
      // visible instead of being swallowed (DATA-8).
      error = loadError.message || 'Failed to load notes'
      if (!records.size) {
        status = 'error'
        notify()
        return
      }
    }
    status = 'ready'
    notify({ list: true })

    if (durable) {
      await restoreOutbox()
    }
    void runBackgroundIndexing()
  }

  async function sync() {
    if (syncing || stopped || status === 'idle') {
      return syncing
    }
    syncing = (async () => {
      let more = true
      while (more && !stopped) {
        const result = await api.get(`/api/notes/sync?since=${seq}&limit=1000`)
        if (result.notes.length) {
          await ingestRows(result.notes)
        }
        for (const id of result.deleted) {
          removeRecord(id, 'deleted')
        }
        seq = result.seq
        more = result.hasMore
      }
      error = null
      persistListSoon()
      notify({ list: true })
    })()
      .catch((syncError) => {
        if (!(syncError instanceof ApiError) || syncError.status !== 401) {
          error = syncError.message
          notify()
        }
      })
      .finally(() => {
        syncing = null
      })
    return syncing
  }

  async function loadTrash() {
    await loadFullList('trash')
  }

  // ── note bodies ───────────────────────────────────────────────────────
  function rememberBody(id, syncSeq, content) {
    bodies.delete(id)
    bodies.set(id, { syncSeq, content })
    while (bodies.size > BODY_CACHE_LIMIT) {
      bodies.delete(bodies.keys().next().value)
    }
  }

  function indexSearch(id, revision, content) {
    const text = createNoteSearchText(content)
    const previous = searchIndex.get(id)
    searchIndex.set(id, { revision, text })
    if (durable && codec.encryptSearch && previous?.text !== text) {
      void codec
        .encryptSearch(id, text)
        .then((envelope) => cache.setCachedSearchEntry(userId, id, envelope, revision))
        .catch(() => {})
    }
  }

  async function fetchFullNote(id, { signal } = {}) {
    const record = records.get(id)
    if (durable && record && !record.plaintext_residue) {
      const cached = await cache.getCachedNote(userId, id)
      if (cached && cached.sync_seq != null && cached.sync_seq === record.sync_seq) {
        return cached
      }
    }
    const { note } = await api.get(`/api/notes/${id}`, { signal })
    if (durable) {
      void cache.setCachedNote(userId, note)
    }
    return note
  }

  async function adoptResidue(note, content) {
    const slot = slotFor(note.id)
    if (!slot.pending && !slot.outbox && !slot.inFlight) {
      slot.pending = content
      slot.lastContent = content
      slot.reason = 'edit'
      setState(note.id, 'pending')
      kick(note.id)
    }
  }

  /**
   * Returns { content, revision, local } for the editor. Unsent local edits
   * win over everything else so reopening a note never shows stale text.
   */
  async function openNote(id, { signal } = {}) {
    openNoteId = id
    const slot = saves.get(id)
    if (slot?.pending) {
      return { content: slot.pending, revision: records.get(id)?.revision ?? 0, local: true }
    }
    if (slot?.lastContent && (slot.outbox || slot.conflict)) {
      return { content: slot.lastContent, revision: records.get(id)?.revision ?? 0, local: true }
    }
    if (slot?.outbox && codec.decryptStoredContent) {
      const content = await codec.decryptStoredContent(id, slot.outbox.payload.encryptedContent)
      slot.lastContent = content
      return { content, revision: records.get(id)?.revision ?? 0, local: true }
    }

    const record = records.get(id)
    const cached = bodies.get(id)
    if (cached && record && cached.syncSeq === record.sync_seq) {
      return { content: cached.content, revision: record.revision }
    }
    if (record?.revision === 0) {
      return { content: createEmptyNoteContent(), revision: 0 }
    }

    const note = await fetchFullNote(id, { signal })
    const known = records.get(id)
    if (!known || known.revision !== note.revision || known.sync_seq !== note.sync_seq) {
      setRecord(note, await decryptSummaryFor(note))
      notify({ list: true })
    }
    let decrypted
    try {
      decrypted = await codec.decryptContent(note)
    } catch (decryptError) {
      const diagnostic = describeDecryptError(decryptError, note.encrypted_content)
      const failure = new Error(diagnostic.message)
      failure.diagnostic = diagnostic
      throw failure
    }
    const content = decrypted.content || createEmptyNoteContent()
    rememberBody(id, note.sync_seq, content)
    indexSearch(id, note.revision, content)
    if (decrypted.residue) {
      void adoptResidue(note, content)
    } else if (codec.kind === 'e2ee' && note.encrypted_content && records.get(id)?.decryptError) {
      void backfillSummary(note, content)
    }
    return { content, revision: note.revision, rollback: records.get(id)?.rollback || null }
  }

  function closeNote(id) {
    if (openNoteId === id) {
      openNoteId = null
    }
  }

  // ── saving ────────────────────────────────────────────────────────────
  function slotFor(id) {
    let slot = saves.get(id)
    if (!slot) {
      slot = {
        pending: null,
        outbox: null,
        inFlight: null,
        blocked: false,
        state: 'saved',
        error: null,
        conflict: null,
        attempt: 0,
        retryTimer: null,
        reason: 'edit',
        lastContent: null,
        lastSavedRevision: null,
      }
      saves.set(id, slot)
    }
    return slot
  }

  function setState(id, state, extra = {}) {
    const slot = slotFor(id)
    slot.state = state
    slot.error = extra.error ?? (state === 'saved' || state === 'saving' || state === 'pending' ? null : slot.error)
    if ('conflict' in extra) {
      slot.conflict = extra.conflict
    }
    notify()
  }

  async function buildEntry(id, content, baseOverride) {
    const record = records.get(id)
    const base = baseOverride ?? record?.revision ?? 0
    const summary = createNoteSummary(content)
    const summaryKey = JSON.stringify(normalizeSummary(summary))
    const slot = slotFor(id)

    // `entry` is persisted and must hold ciphertext only; `meta` (the
    // plaintext summary) stays in memory.
    const meta = { summary, summaryKey }
    if (codec.kind === 'legacy') {
      return { entry: { noteId: id, baseRevision: base, payload: { content }, createdAt: now() }, meta }
    }

    // PERF-4: the summary is only re-encrypted when it changed (or is stale).
    const summaryChanged =
      !record?.encrypted_summary || record._summaryKey !== summaryKey || codec.needsUpgrade?.(record) || record.decryptError
    const payload = {
      encryptedContent: await codec.encryptContent(id, content, base + 1),
      blobIds: blobIdsForSave(content),
      reason: slot.reason || 'edit',
    }
    if (summaryChanged) {
      payload.encryptedSummary = await codec.encryptSummary(id, summary)
    }
    return { entry: { noteId: id, baseRevision: base, payload, createdAt: now() }, meta }
  }

  async function persistPending(id) {
    const slot = saves.get(id)
    if (!slot?.pending) {
      return
    }
    const content = slot.pending
    // A conflicted note keeps the base it conflicted on, so re-encrypting it
    // (e.g. before locking) can never turn it into a silent overwrite.
    const { entry, meta } = await buildEntry(id, content, slot.conflict ? slot.conflictBase : undefined)
    if (durable) {
      await cache.putOutboxEntry(userId, entry)
    }
    slot.outbox = entry
    slot.outboxMeta = meta
    slot.lastContent = content
    if (slot.pending === content) {
      slot.pending = null
    }
  }

  async function applySaved(id, note, entry, meta) {
    const slot = slotFor(id)
    const previous = records.get(id)
    let summary = meta?.summary ? normalizeSummary(meta.summary) : null
    if (!summary && entry.payload.encryptedSummary) {
      // Restored from the outbox after a reload: the summary is encrypted.
      summary = normalizeSummary(
        (await decryptSummaryFor({ id, encrypted_summary: entry.payload.encryptedSummary })).summary
      )
    }
    summary ??= normalizeSummary(previous?.summary)
    const record = {
      ...(previous || {}),
      id,
      revision: note.revision,
      sync_seq: note.sync_seq ?? null,
      created_at: note.created_at,
      updated_at: note.updated_at,
      deleted_at: note.deleted_at ?? null,
      has_conflict: Boolean(note.has_conflict),
      plaintext_residue: false,
      encrypted_summary: entry.payload.encryptedSummary || previous?.encrypted_summary || null,
      content: codec.kind === 'legacy' ? entry.payload.content : undefined,
      summary,
      decryptError: null,
      rollback: null,
      _summaryKey: JSON.stringify(summary),
      _updated: timeOf(note.updated_at),
      _created: timeOf(note.created_at),
      _deleted: timeOf(note.deleted_at),
    }
    records.set(id, record)
    slot.lastSavedRevision = note.revision
    trackRevision(id, note.revision)
    if (slot.lastContent) {
      rememberBody(id, note.sync_seq, slot.lastContent)
      indexSearch(id, note.revision, slot.lastContent)
    }
    if (durable && entry.payload.encryptedContent) {
      void cache.setCachedNote(userId, {
        ...note,
        encrypted_content: entry.payload.encryptedContent,
        encrypted_summary: record.encrypted_summary,
      })
    }
    persistListSoon()
    notify({ list: true })
  }

  function scheduleRetry(id, delayMs) {
    const slot = slotFor(id)
    timers.clearTimeout(slot.retryTimer)
    slot.retryTimer = timers.setTimeout(() => {
      slot.retryTimer = null
      kick(id)
    }, delayMs)
  }

  function handleSaveError(id, saveError) {
    const slot = slotFor(id)
    if (!(saveError instanceof ApiError)) {
      slot.blocked = true
      setState(id, 'failed', { error: saveError?.message || 'Could not encrypt this note' })
      return
    }
    if (saveError.status === 401) {
      slot.blocked = true
      sessionExpired = true
      setState(id, 'auth', { error: 'Session expired: sign in again to keep saving' })
      return
    }
    if (isRetryable(saveError)) {
      slot.attempt += 1
      const delay = saveError.retryAfterMs ?? RETRY_DELAYS_MS[Math.min(slot.attempt - 1, RETRY_DELAYS_MS.length - 1)]
      setState(id, saveError.status === 0 ? 'offline' : 'retrying', {
        error: saveError.status === 0 ? 'Offline: changes are kept on this device' : saveError.message,
      })
      scheduleRetry(id, delay)
      return
    }
    if (saveError.code === 'KEY_ROTATED') {
      slot.blocked = true
      setState(id, 'auth', { error: 'The encryption key changed on another device. Unlock again to keep saving.' })
      emit({ type: 'key-rotated' })
      return
    }
    if (CONFLICT_CODES.has(saveError.code) || saveError.status === 409 || saveError.status === 404) {
      slot.blocked = true
      slot.conflictBase = slot.outbox?.baseRevision ?? records.get(id)?.revision ?? 0
      const serverNote = saveError.data?.note || null
      if (serverNote) {
        // Learn the server's revision; the editor is not reloaded because the
        // slot is now in conflict (see onRemoteChange).
        void decryptSummaryFor(serverNote).then((summaryResult) => {
          setRecord(serverNote, summaryResult)
          notify({ list: true })
        })
      }
      setState(id, 'conflict', {
        error: saveError.message,
        conflict: {
          code: saveError.code,
          message: saveError.message,
          serverNote,
          conflictRevisionId: saveError.data?.conflictRevisionId ?? null,
        },
      })
      emit({ type: 'conflict', id, code: saveError.code })
      return
    }
    slot.blocked = true
    setState(id, 'failed', { error: saveError.message })
  }

  async function saveOnce(id) {
    const slot = slotFor(id)
    if (slot.pending) {
      await persistPending(id)
    }
    const entry = slot.outbox
    if (!entry) {
      return
    }
    setState(id, 'saving')
    try {
      const result = await api.put(`/api/notes/${id}`, { baseRevision: entry.baseRevision, ...entry.payload })
      if (durable) {
        await cache.deleteOutboxEntry(userId, id)
      }
      const meta = slot.outbox === entry ? slot.outboxMeta : null
      if (slot.outbox === entry) {
        slot.outbox = null
        slot.outboxMeta = null
      }
      slot.attempt = 0
      slot.reason = 'edit'
      await applySaved(id, result.note, entry, meta)
      if (result.missingBlobIds?.length) {
        emit({ type: 'missing-attachments', id, blobIds: result.missingBlobIds })
      }
      setState(id, slot.pending ? 'pending' : 'saved')
    } catch (saveError) {
      handleSaveError(id, saveError)
    }
  }

  // Per-note drain loop: one request in flight per note; newer edits wait
  // and are encrypted against the revision the previous save produced.
  function kick(id) {
    const slot = saves.get(id)
    if (!slot || slot.inFlight || slot.blocked || slot.retryTimer || stopped) {
      return slot?.inFlight || null
    }
    if (!slot.pending && !slot.outbox) {
      if (slot.state !== 'saved') {
        setState(id, 'saved')
      }
      return null
    }
    slot.inFlight = saveOnce(id).finally(() => {
      slot.inFlight = null
      if (!slot.blocked && !slot.retryTimer && (slot.pending || slot.outbox)) {
        kick(id)
      }
    })
    return slot.inFlight
  }

  function updateNote(id, content) {
    const slot = slotFor(id)
    slot.pending = content
    slot.lastContent = content
    if (codec.kind === 'legacy') {
      const record = records.get(id)
      if (record) {
        record.content = content
      }
    }
    if (!slot.blocked) {
      setState(id, slot.inFlight ? 'saving' : 'pending')
      kick(id)
    } else {
      notify()
    }
  }

  // Encrypts every unsent edit into the outbox (and starts sending). Used
  // before locking the vault and when the page is hidden.
  async function flushAll({ timeoutMs = 10000 } = {}) {
    const work = [...saves.keys()].map(async (id) => {
      const slot = saves.get(id)
      if (slot.inFlight) {
        await Promise.race([slot.inFlight, new Promise((resolve) => timers.setTimeout(resolve, timeoutMs))])
      }
      if (slot.pending && !slot.inFlight) {
        if (slot.blocked) {
          await persistPending(id)
        } else {
          kick(id)
          await Promise.race([slot.inFlight, new Promise((resolve) => timers.setTimeout(resolve, timeoutMs))])
        }
      }
    })
    await Promise.all(work)
  }

  function flushNote(id) {
    return kick(id) || Promise.resolve()
  }

  // True while anything typed has not been confirmed by the server.
  function hasUnsavedChanges() {
    for (const slot of saves.values()) {
      if (slot.pending || slot.outbox || slot.inFlight) {
        return true
      }
    }
    return false
  }

  // Unsent plaintext that is not yet in the durable outbox.
  function hasVolatileChanges() {
    for (const slot of saves.values()) {
      if (slot.pending) {
        return true
      }
    }
    return false
  }

  async function restoreOutbox() {
    const entries = await cache.getOutboxEntries(userId)
    for (const entry of entries) {
      const slot = slotFor(entry.noteId)
      if (slot.outbox || slot.pending) {
        continue
      }
      slot.outbox = entry
      slot.reason = entry.payload.reason || 'edit'
      setState(entry.noteId, 'pending')
      kick(entry.noteId)
    }
  }

  function resumeAfterAuth() {
    sessionExpired = false
    for (const [id, slot] of saves) {
      if (slot.state === 'auth') {
        slot.blocked = false
        kick(id)
      }
    }
    notify()
    void sync()
  }

  function retry(id) {
    const slot = saves.get(id)
    if (!slot) {
      return
    }
    slot.blocked = false
    slot.attempt = 0
    timers.clearTimeout(slot.retryTimer)
    slot.retryTimer = null
    kick(id)
  }

  // ── creating, trashing, deleting ──────────────────────────────────────
  async function createNote({ content = createEmptyNoteContent(), reason = 'edit' } = {}) {
    const { note } =
      codec.kind === 'legacy' ? await api.post('/api/notes', { content }) : await api.post('/api/notes', {})
    setRecord(note, { summary: createNoteSummary(content) })
    if (codec.kind !== 'legacy') {
      const slot = slotFor(note.id)
      slot.pending = content
      slot.lastContent = content
      slot.reason = reason
      setState(note.id, 'pending')
      kick(note.id)
    }
    notify({ list: true })
    return records.get(note.id)
  }

  async function trashNote(id) {
    const slot = saves.get(id)
    if (slot?.inFlight || slot?.pending) {
      await kick(id)
    }
    const { note } = await api.put(`/api/notes/${id}/trash`)
    setRecord(note, await decryptSummaryFor(note))
    persistListSoon()
    notify({ list: true })
  }

  async function restoreNote(id) {
    const { note } = await api.put(`/api/notes/${id}/restore`)
    setRecord(note, await decryptSummaryFor(note))
    persistListSoon()
    notify({ list: true })
  }

  async function deleteNotePermanently(id) {
    await api.delete(`/api/notes/${id}`)
    saves.delete(id)
    if (durable) {
      await cache.deleteOutboxEntry(userId, id)
    }
    removeRecord(id, 'deleted-here')
    persistListSoon()
  }

  // ── conflicts ─────────────────────────────────────────────────────────
  async function localVersionOf(id) {
    const slot = saves.get(id)
    if (slot?.pending) {
      return slot.pending
    }
    if (slot?.lastContent) {
      return slot.lastContent
    }
    if (slot?.outbox?.payload?.encryptedContent && codec.decryptStoredContent) {
      return codec.decryptStoredContent(id, slot.outbox.payload.encryptedContent)
    }
    return slot?.outbox?.payload?.content || null
  }

  async function markConflictResolved(id, conflictRevisionId) {
    if (conflictRevisionId) {
      await api.post(`/api/notes/${id}/revisions/${conflictRevisionId}/resolve`).catch(() => {})
    }
  }

  /**
   * choice:
   *   'mine'   keep this device's version (the other one stays in history)
   *   'theirs' load the other version (this device's stays in history)
   *   'copy'   keep both: this device's version becomes a new note
   */
  async function resolveConflict(id, choice) {
    const slot = saves.get(id)
    const conflict = slot?.conflict
    if (!conflict) {
      return null
    }
    const local = await localVersionOf(id)

    if (choice === 'mine') {
      const { note } = await api.get(`/api/notes/${id}`)
      if (note.deleted_at) {
        await api.put(`/api/notes/${id}/restore`)
        note.deleted_at = null
      }
      setRecord(note, await decryptSummaryFor(note))
      if (durable) {
        await cache.deleteOutboxEntry(userId, id)
      }
      slot.outbox = null
      slot.conflict = null
      slot.blocked = false
      slot.pending = local
      slot.reason = 'conflict-resolution'
      await markConflictResolved(id, conflict.conflictRevisionId)
      setState(id, 'pending', { conflict: null })
      await kick(id)
      return null
    }

    let created = null
    if (choice === 'copy' && local) {
      created = await createNote({ content: local, reason: 'conflict-resolution' })
    }
    if (durable) {
      await cache.deleteOutboxEntry(userId, id)
    }
    slot.outbox = null
    slot.pending = null
    slot.lastContent = null
    slot.conflict = null
    slot.blocked = false
    await markConflictResolved(id, conflict.conflictRevisionId)
    bodies.delete(id)
    setState(id, 'saved', { conflict: null })

    if (conflict.code === 'NOTE_DELETED' || conflict.code === 'NOTE_NOT_FOUND') {
      removeRecord(id, 'deleted')
    } else {
      emit({ type: 'note-replaced', id, reason: 'conflict' })
    }
    return created
  }

  // ── history ───────────────────────────────────────────────────────────
  async function listRevisions(id) {
    return (await api.get(`/api/notes/${id}/revisions`)).revisions
  }

  async function loadRevision(id, revisionId) {
    const { revision } = await api.get(`/api/notes/${id}/revisions/${revisionId}`)
    const content = await codec.decryptStoredContent(id, revision.encrypted_content)
    return { ...revision, content }
  }

  async function restoreRevision(id, revisionId) {
    const { content } = await loadRevision(id, revisionId)
    const slot = slotFor(id)
    slot.pending = content
    slot.lastContent = content
    slot.reason = 'restore'
    setState(id, 'pending')
    await kick(id)
    emit({ type: 'note-replaced', id, reason: 'restore' })
  }

  // ── search and background work ────────────────────────────────────────
  function matches(record, query) {
    if (!query) {
      return true
    }
    if (getSummarySearchText(record.summary).includes(query)) {
      return true
    }
    return searchIndex.get(record.id)?.text?.includes(query) || false
  }

  // Writes a summary derived from `note`'s decrypted content: for notes saved
  // without one, and to repair one that no longer decrypts while the content
  // does (DATA-8). The server only accepts it for that same revision.
  async function backfillSummary(note, content) {
    const repairKey = `${note.id}:${note.revision}`
    if (summaryRepairs.has(repairKey)) {
      return
    }
    summaryRepairs.add(repairKey)
    try {
      const summary = createNoteSummary(content)
      const encryptedSummary = await codec.encryptSummary(note.id, summary)
      await api.patch(`/api/notes/${note.id}/summary`, { encryptedSummary, revision: note.revision })
      const record = records.get(note.id)
      if (record && record.revision === note.revision) {
        record.encrypted_summary = encryptedSummary
        record.summary = normalizeSummary(summary)
        record._summaryKey = JSON.stringify(record.summary)
        record.decryptError = null
        notify({ list: true })
      }
    } catch {
      // the placeholder summary stays; retried on a later load
    } finally {
      summaryRepairs.delete(repairKey)
    }
  }

  async function indexFetchedNote(note) {
    const record = records.get(note.id)
    if (!record || record.revision !== note.revision) {
      setRecord(note, await decryptSummaryFor(note))
    }
    const { content, residue } = await codec.decryptContent(note)
    const body = content || createEmptyNoteContent()
    if (durable) {
      void cache.setCachedNote(userId, note)
    }
    indexSearch(note.id, note.revision, body)
    refsScan.set(note.id, { revision: note.revision, blobIds: blobIdsForSave(body) })
    if (residue) {
      void adoptResidue(note, body)
    } else if (note.encrypted_content && (!note.encrypted_summary || records.get(note.id)?.decryptError)) {
      void backfillSummary(note, body)
    }
  }

  async function runBackgroundIndexing() {
    if (codec.kind !== 'e2ee' || indexing.running || stopped) {
      return
    }
    const candidates = [...records.values()].filter((record) => record.revision > 0)
    indexing = { running: true, indexed: 0, total: candidates.length }
    notify()

    const needBody = []
    for (const record of candidates) {
      if (searchIndex.get(record.id)?.revision === record.revision) {
        indexing.indexed += 1
        continue
      }
      const cached = durable ? await cache.getCachedSearchEntry(userId, record.id) : null
      if (cached && cached.revision === record.revision) {
        try {
          searchIndex.set(record.id, { revision: record.revision, text: await codec.decryptSearch(record.id, cached.encryptedSearchText) })
          indexing.indexed += 1
          continue
        } catch {
          // rebuild from the body
        }
      }
      needBody.push(record.id)
    }
    notify()

    for (const ids of chunk(needBody, BATCH_SIZE)) {
      if (stopped) {
        return
      }
      try {
        const { notes } = await api.post('/api/notes/batch', { ids })
        for (const note of notes) {
          try {
            await indexFetchedNote(note)
          } catch (indexError) {
            const record = records.get(note.id)
            if (record && !record.decryptError) {
              record.decryptError = describeDecryptError(indexError, note.encrypted_content)
            }
          }
          indexing.indexed += 1
        }
      } catch (batchError) {
        if (batchError instanceof ApiError && batchError.status === 401) {
          break
        }
        log.warn?.('Background indexing paused:', batchError.message)
        break
      }
      notify({ list: true })
    }

    indexing = { ...indexing, running: false }
    notify()
    void reconcileRefs()
  }

  // DATA-4: tell the server which attachments older notes reference so it
  // can garbage-collect safely. Until this completes nothing is collected.
  async function reconcileRefs() {
    if (codec.kind !== 'e2ee' || stopped) {
      return
    }
    try {
      const unknown = await api.get('/api/blobs/refs/unknown')
      const profileReference = getProfileReference()
      if (!unknown.notes.length && !unknown.revisions.length && (unknown.profileRefKnown || profileReference === undefined)) {
        refs = { checked: true, enabled: unknown.profileRefKnown }
        notify()
        return
      }

      const missing = unknown.notes.filter((entry) => refsScan.get(entry.id)?.revision !== entry.revision).map((e) => e.id)
      for (const ids of chunk(missing, BATCH_SIZE)) {
        const { notes } = await api.post('/api/notes/batch', { ids })
        for (const note of notes) {
          try {
            await indexFetchedNote(note)
          } catch {
            // unreadable: its references stay unknown, so GC stays off
          }
        }
      }

      const notePayload = unknown.notes
        .filter((entry) => refsScan.get(entry.id)?.revision === entry.revision)
        .map((entry) => ({ id: entry.id, revision: entry.revision, blobIds: refsScan.get(entry.id).blobIds }))

      const revisionPayload = []
      for (const entry of unknown.revisions) {
        try {
          const loaded = await loadRevision(entry.noteId, entry.id)
          revisionPayload.push({ id: entry.id, blobIds: blobIdsForSave(loaded.content) })
        } catch {
          // stays unknown
        }
      }

      let result = null
      const noteChunks = chunk(notePayload, 500)
      const rounds = Math.max(1, noteChunks.length)
      for (let i = 0; i < rounds; i += 1) {
        result = await api.post('/api/blobs/refs/reconcile', {
          notes: noteChunks[i] || [],
          revisions: i === 0 ? revisionPayload : [],
          ...(i === 0 && profileReference !== undefined && !unknown.profileRefKnown ? { profile: profileReference } : {}),
        })
      }
      refs = { checked: true, enabled: Boolean(result?.gc?.enabled) }
      notify()
    } catch {
      refs = { checked: true, enabled: null }
      notify()
    }
  }

  // ── attachments ───────────────────────────────────────────────────────
  function searchMatches(query) {
    const normalized = query.trim().toLowerCase()
    return getSnapshot().notes.filter((record) => matches(record, normalized))
  }

  function getNoteRecord(id) {
    return records.get(id) || null
  }

  function stop() {
    stopped = true
    timers.clearTimeout(highWaterTimer)
    timers.clearTimeout(listCacheTimer)
    for (const slot of saves.values()) {
      timers.clearTimeout(slot.retryTimer)
    }
    if (durable) {
      void cache.setRevisionHighWater(userId, highWater)
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    getSnapshot,
    start,
    stop,
    sync,
    loadTrash,
    openNote,
    closeNote,
    updateNote,
    flushNote,
    flushAll,
    hasUnsavedChanges,
    hasVolatileChanges,
    resumeAfterAuth,
    retry,
    createNote,
    trashNote,
    restoreNote,
    deleteNotePermanently,
    resolveConflict,
    listRevisions,
    loadRevision,
    restoreRevision,
    searchMatches,
    getNoteRecord,
    reconcileRefs,
    get codec() {
      return codec
    },
  }
}
