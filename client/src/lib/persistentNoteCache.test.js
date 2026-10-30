import { describe, expect, it } from 'vitest'
import { getCachedNote, getMeta, setMeta } from './persistentNoteCache.js'

function openOldVersion() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('notes-persistent-cache', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('note_bodies', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe('local cache availability', () => {
  it('works without the cache while a tab of the old app version blocks the upgrade', async () => {
    // A 1.x tab: holds version 1 open and ignores requests to close it.
    const oldTab = await openOldVersion()

    const started = Date.now()
    expect(await getCachedNote(1, 42)).toBeNull()
    await setMeta(1, 'x', 'y')
    expect(await getMeta(1, 'x')).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)

    // Once the old tab is gone the cache is used again.
    oldTab.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await setMeta(1, 'x', 'y')
    expect(await getMeta(1, 'x')).toBe('y')
  }, 20_000)
})
