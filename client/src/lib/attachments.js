// Encrypted attachments: raw bytes in and out (no base64 round trip, PERF-2).
export async function uploadAttachment({ api, vault, bytes, mimeType, name, replaces }) {
  const plaintext = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const sealed = await vault.encryptBlob(plaintext)
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Blob-Version': String(sealed.version),
    'X-Blob-Key-Id': sealed.keyId,
  }
  if (replaces) {
    headers['X-Blob-Replaces'] = String(replaces)
  }
  const result = await api.request('/api/blobs', { method: 'POST', body: sealed.data, headers })
  return {
    blobId: String(result.blob.id),
    blobUuid: sealed.blobUuid,
    blobVersion: sealed.version,
    keyId: sealed.keyId,
    mimeType: mimeType || 'application/octet-stream',
    name: name || null,
    size: plaintext.length,
  }
}

export async function uploadFile({ api, vault, file }) {
  return uploadAttachment({
    api,
    vault,
    bytes: new Uint8Array(await file.arrayBuffer()),
    mimeType: file.type || 'application/octet-stream',
    name: file.name,
  })
}

export async function fetchAttachmentBytes({ api, vault, reference, signal }) {
  const response = await api.request(`/api/blobs/${reference.blobId}`, { raw: true, signal })
  const data = new Uint8Array(await response.arrayBuffer())
  return vault.decryptBlob(data, reference, {
    version: response.headers.get('x-blob-version'),
    iv: response.headers.get('x-blob-iv'),
    keyId: response.headers.get('x-blob-key-id'),
  })
}

// Decrypted attachments as object URLs, revoked when no longer needed. The
// owner hands in the current vault with setVault() (null when locked).
export function createAttachmentResolver({ api }) {
  const urls = new Map()
  let vault = null

  function setVault(next) {
    vault = next
  }

  async function resolve(reference, signal) {
    const key = String(reference.blobId)
    if (urls.has(key)) {
      return urls.get(key)
    }
    if (!vault) {
      throw new Error('Vault is locked')
    }
    const bytes = await fetchAttachmentBytes({ api, vault, reference, signal })
    const url = URL.createObjectURL(new Blob([bytes], { type: reference.mimeType || 'application/octet-stream' }))
    urls.set(key, url)
    return url
  }

  function remember(blobId, bytes, mimeType) {
    const key = String(blobId)
    if (!urls.has(key)) {
      urls.set(key, URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' })))
    }
    return urls.get(key)
  }

  function revoke(blobId) {
    const key = String(blobId)
    const url = urls.get(key)
    if (url) {
      URL.revokeObjectURL(url)
    }
    urls.delete(key)
  }

  function clear() {
    for (const url of urls.values()) {
      URL.revokeObjectURL(url)
    }
    urls.clear()
  }

  async function download(reference) {
    const url = await resolve(reference)
    const link = document.createElement('a')
    link.href = url
    link.download = reference.name || 'attachment'
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  return { setVault, resolve, remember, revoke, clear, download }
}
