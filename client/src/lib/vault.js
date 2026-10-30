import {
  CONTEXTS,
  EnvelopeError,
  decryptBlobV3,
  decryptEnvelope,
  decryptJson,
  decryptLegacyBlob,
  encryptBlobV3,
  encryptJson,
  generateBlobUuid,
  importAesKey,
  keyFingerprint,
} from './envelope.js'

/**
 * The unlocked vault: non-extractable AES keys only (SEC-11). Raw key bytes
 * are imported once and zeroed; nothing in the page can read them back.
 * Holds the current key plus, during a rotation, previous keys from the
 * keyring so not-yet-re-encrypted data stays readable.
 */
export class Vault {
  constructor({ keys, currentKeyId, minEnvelopeVersion = 1 }) {
    this.keys = keys
    this.currentKeyId = currentKeyId
    this.minEnvelopeVersion = minEnvelopeVersion
  }

  // Opens a vault from the raw current key. `keyring` maps previous key ids to
  // envelopes wrapped under the current key. The raw buffers are zeroed.
  static async open(rawKey, { keyring = {}, minEnvelopeVersion = 1 } = {}) {
    try {
      const currentKeyId = await keyFingerprint(rawKey)
      const currentKey = await importAesKey(rawKey)
      const keys = new Map([[currentKeyId, currentKey]])

      for (const [keyId, envelope] of Object.entries(keyring || {})) {
        const raw = await decryptEnvelope(currentKey, envelope, { context: CONTEXTS.keyring(keyId) })
        try {
          if ((await keyFingerprint(raw)) !== keyId) {
            throw new EnvelopeError('KEYRING_MISMATCH', 'A previous vault key does not match its id')
          }
          keys.set(keyId, await importAesKey(raw))
        } finally {
          raw.fill(0)
        }
      }

      return new Vault({ keys, currentKeyId, minEnvelopeVersion })
    } finally {
      rawKey.fill(0)
    }
  }

  get currentKey() {
    return this.keys.get(this.currentKeyId)
  }

  keyFor(keyId) {
    return this.keys.get(keyId) || null
  }

  // Pre-v3 data carries no key id: previous keys first (that data predates
  // any rotation), then the current one.
  allKeys() {
    const previous = [...this.keys.entries()].filter(([id]) => id !== this.currentKeyId).map(([, key]) => key)
    return [...previous, this.currentKey]
  }

  get hasPreviousKeys() {
    return this.keys.size > 1
  }

  async encryptJson(value, context, { revision } = {}) {
    return encryptJson(this.currentKey, value, { context, keyId: this.currentKeyId, revision })
  }

  async decryptJson(envelope, context, { expectedRevision } = {}) {
    return decryptJson(this, envelope, { context, minVersion: this.minEnvelopeVersion, expectedRevision })
  }

  // True when an envelope should be rewritten (old format or old key).
  needsUpgrade(envelope) {
    return Boolean(envelope) && (Number(envelope.version) < 3 || envelope.keyId !== this.currentKeyId)
  }

  async encryptBlob(bytes) {
    const blobUuid = generateBlobUuid()
    const data = await encryptBlobV3(this.currentKey, this.currentKeyId, blobUuid, bytes)
    return { data, blobUuid, version: 3, keyId: this.currentKeyId }
  }

  /**
   * `reference` comes from the encrypted note (blobVersion, blobUuid, keyId),
   * not from server headers, so a server cannot downgrade a v3 attachment or
   * swap it for another one (CRYPTO-5). Only references written before v3
   * fall back to the header's IV and version.
   */
  async decryptBlob(data, reference, header = {}) {
    if (reference?.blobVersion === 3 || reference?.blobUuid) {
      const keyId = reference.keyId || header.keyId
      const key = this.keyFor(keyId)
      if (!key) {
        throw new EnvelopeError('UNKNOWN_KEY', 'This attachment was encrypted with a key this device does not have')
      }
      return decryptBlobV3(key, keyId, reference.blobUuid, data)
    }
    if (this.minEnvelopeVersion >= 3) {
      throw new EnvelopeError('DOWNGRADE', 'This attachment uses an outdated format that this account no longer accepts')
    }
    const version = Number(header.version) === 2 ? 2 : 1
    return decryptLegacyBlob(this, data, { version, iv: header.iv })
  }

  lock() {
    this.keys.clear()
    this.currentKeyId = null
  }
}
