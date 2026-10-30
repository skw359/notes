import { CONTEXTS } from './envelope.js'
import { createNoteSummary, normalizeContentForStorage } from './noteContent.js'

// How the store turns server records into plaintext and back. Encrypted
// accounts go through the vault; pre-encryption (legacy) accounts exchange
// plaintext with the server until they upgrade.
export function createE2EECodec(vault) {
  return {
    kind: 'e2ee',
    vault,
    durable: true,

    async decryptSummary(note) {
      if (!note.encrypted_summary) {
        return null
      }
      return vault.decryptJson(note.encrypted_summary, CONTEXTS.noteSummary(note.id))
    },

    // Returns { content, residue }. `residue` marks plaintext a 1.x
    // importer or race left in an encrypted account (DATA-6/DATA-7); the
    // store encrypts it right away.
    async decryptContent(note) {
      if (note.encrypted_content) {
        return {
          content: await vault.decryptJson(note.encrypted_content, CONTEXTS.noteContent(note.id), {
            expectedRevision: note.revision,
          }),
          residue: false,
        }
      }
      if (note.content) {
        return { content: note.content, residue: true }
      }
      return { content: null, residue: false }
    },

    async decryptStoredContent(noteId, envelope) {
      return vault.decryptJson(envelope, CONTEXTS.noteContent(noteId))
    },

    async encryptContent(noteId, content, revision) {
      return vault.encryptJson(normalizeContentForStorage(content), CONTEXTS.noteContent(noteId), { revision })
    },

    async encryptSummary(noteId, summary) {
      return vault.encryptJson(summary, CONTEXTS.noteSummary(noteId))
    },

    async encryptSearch(noteId, text) {
      return vault.encryptJson(text, CONTEXTS.noteSearch(noteId))
    },

    async decryptSearch(noteId, envelope) {
      return vault.decryptJson(envelope, CONTEXTS.noteSearch(noteId))
    },

    needsUpgrade(note) {
      return vault.needsUpgrade(note.encrypted_content) || vault.needsUpgrade(note.encrypted_summary)
    },
  }
}

export function createLegacyCodec() {
  return {
    kind: 'legacy',
    durable: false,
    async decryptSummary(note) {
      return createNoteSummary(note.content)
    },
    async decryptContent(note) {
      return { content: note.content, residue: false }
    },
    needsUpgrade() {
      return false
    },
  }
}
