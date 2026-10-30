# Cryptography

All encryption and decryption happens in the browser with the Web Crypto API
(AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, SHA-256) and Argon2id (WebAssembly in
a Web Worker). Code: `client/src/lib/envelope.js` (formats), `vault.js` (keys),
`account.js` (sign-up, sign-in, password change, recovery), `keyRotation.js`.
Known-answer tests: `client/src/lib/envelope.test.js`.

## Key hierarchy

```
password ──Argon2id(salt, params)──► master (32 B)
   master ──HKDF(salt, "notes-auth-secret-v1")──► authSecret   → sent at sign-in
   master ──HKDF(salt, "notes-key-encryption-v1")──► KEK        → never leaves the browser
recovery key (24 random bytes, shown once) ──SHA-256("notes-recovery:" ‖ key)──► recovery wrapping key
vault key (32 random bytes) ── wrapped by the KEK and, separately, by the recovery wrapping key
   └─ encrypts notes, summaries, search cache, history, profile, attachments
```

- Argon2id defaults: 64 MiB, 3 passes, parallelism 1. The client refuses
  parameters below 19 MiB / 2 passes (the 1.x defaults, still accepted so old
  vaults open) or above sane maxima, so a server cannot make the client
  derive a key with weakened or absurd settings. Changing the password
  re-derives with the current defaults.
- Keys are imported as non-extractable `CryptoKey`s and dropped on lock,
  logout and auto-lock.
- Key id: the first 22 base64url characters of
  `HMAC-SHA-256(vault key, "notes-vault-key-id-v1")`. It names the key
  without revealing it.

## What the server stores for authentication

- `auth_verifier_hash` = `"hmac-sha256$v1$" ‖ base64url(HMAC-SHA-256(pepper, authSecret))`.
  The pepper is 32 random bytes generated on first start and stored in
  `server_settings`. The authSecret is already the output of Argon2id with the
  account's parameters, so the server does not run a second slow hash on
  every sign-in (which made sign-in a cheap denial-of-service lever). 1.x
  Argon2 verifier hashes still verify and are replaced on the next sign-in.
- `recovery_verifier_hash` = the same HMAC of
  `SHA-256("notes-recovery-verifier:" ‖ recovery key)`.
- For unknown email addresses, prelogin answers with a salt derived from the
  address and `JWT_SECRET` and the default parameters, in the same canonical
  shape as a real answer. Still distinguishable: accounts that have not
  upgraded from 1.x (they must send their password once), accounts whose
  key-derivation settings differ from the defaults (until the next password
  change), and sign-up while it is open (it rejects a registered address).
  Email addresses are compared case-insensitively.

## Envelopes (records)

JSON objects `{ version, algorithm: "AES-256-GCM", context, keyId, revision?, iv, ciphertext }`
(base64 fields; 12-byte random IV; 16-byte tag at the end of `ciphertext`).

| Version | Associated data | Status |
|---|---|---|
| 1 | none | 1.x, read only |
| 2 | the `context` string | 1.x, read only |
| 3 | `JSON.stringify(["notes-envelope-v3", keyId, context, revision ?? null])` | written by 2.0 |

Contexts: `note-content:<id>`, `note-summary:<id>`, `note-search:<id>`,
`profile`, `vault-key:password`, `vault-key:recovery`,
`vault-keyring:<keyId>`. The client checks that the context matches where the
record was found, so the server cannot move a ciphertext to another note or
field; v3 also binds the key and, for note bodies, the revision the body was
saved as. A stripped `revision` field fails authentication because the
associated data then carries `null`.

## Attachments

- v3 (2.0): the file is split into 1 MiB chunks, each stored as
  `IV(12) ‖ ciphertext ‖ tag(16)` with associated data
  `JSON.stringify(["notes-blob-v3", keyId, blobUuid, index, isLast])`. The
  random `blobUuid`, the format version and the key id are recorded inside the
  encrypted note that links the file, not taken from server headers, so the
  server cannot swap, reorder, truncate or downgrade an attachment. The
  server stores the size and `application/octet-stream`; the real type and
  name live in the encrypted note.
- v1/v2 (1.x): one GCM message, IV in the blob row; v2 adds the associated
  data `"blob"`. Read only, until the account's floor is raised.

## Rollback and replay

- Each note has a server-side `revision`; v3 bodies are bound to it.
- Every device remembers the highest revision it has seen per note and shows
  a warning when the server later serves a lower one. A device that never saw
  the newer revision cannot detect the rollback, and a server can always
  withhold or delete data; backups protect against that, encryption does not.

## Rotation and format upgrade (CRYPTO-1, CRYPTO-5)

- **Replace encryption key:** the browser creates a new vault key, wraps it
  with the password and a new recovery key, and keeps the old keys in a key
  ring encrypted under the new key, so data not yet re-encrypted stays
  readable on every device. It then re-encrypts every note, summary, history
  entry, profile and attachment (attachments are uploaded again under new
  ids and links are updated). Other sessions are signed out.
- **Upgrade encryption format:** re-encrypts v1/v2 records and attachments as
  v3 with the current key.
- The server tracks what is still pending. Only when nothing is left does
  `POST /api/vault/rotation/complete` empty the key ring and raise the
  account's minimum envelope version to 3; from then on the client rejects
  v1/v2 records and attachments for that account (downgrade protection).
  Wrapped vault keys are exempt: each copy is sealed under a different key,
  and refusing an old wrapped key would only lock the owner out.
- An interrupted rotation resumes from the server's pending list.

## Recovery and password changes (CRYPTO-2, CRYPTO-4)

- Password change: re-wraps the same vault key under a new salt and KEK and
  replaces the verifier; the recovery key keeps working; other sessions are
  signed out.
- Recovery: the recovery key unwraps the vault key; the user sets a new
  password and receives a new recovery key; both are committed only after the
  new key has been confirmed (typing its last characters).
- A new recovery key is prepared, shown and confirmed before it replaces the
  old one; until then the old key keeps working.
- Upgrading a 1.x plaintext account requires a new password (at least 12
  characters): the old password was handled in plaintext by the 1.x server.

## Limits of the design

- The JavaScript that performs encryption is delivered by the server. A
  malicious or compromised server can serve code that captures the password
  or vault key when the user next unlocks. HTTPS with HSTS and a trustworthy
  host are required; there is no code signing or pinning.
- Metadata is visible to the server (see the README table).
- Plaintext sent to a 1.x server before an account upgraded may persist in
  older backups and in 1.x upload files until the operator removes them
  (`npm run residue-report`).
