# Code review remediation tracker

Tracks the resolution of every finding in the independent code review of commit
`2d8cf78` (review dated 2026-10-29). Status values: `done`, `done (documented)`
(resolved by documentation or an explicit decision), `partial`.

## Ground rules

- The original checkout is also a live deployment (`start-services.cmd` runs
  `node index.js` in `server/`). Development happened in a separate worktree,
  never touched the live database or `client/dist`, and never restarted the
  live server.
- Tests run against a disposable PostgreSQL server (`TEST_DATABASE_URL`).
- Schema migrations are additive and idempotent; rollback is "restore the
  pre-upgrade `pg_dump`" (`docs/OPERATIONS.md`).
- Existing ciphertext (v1/v2 envelopes, v1/v2 blobs) must stay readable.

## Key design decisions

| Area | Decision |
|---|---|
| Schema | Versioned SQL migrations (`server/migrations/*.sql`) run by a small runner with a `schema_migrations` table, advisory lock and checksums. `init.sql`/`schema.js` replaced. |
| Sessions | Opaque random session token in the `token` cookie, SHA-256 stored in `sessions`. Sliding 14-day idle expiry, 90-day absolute. Pre-upgrade JWT cookies are converted once into a deterministic, revocable session (transition only). |
| Verifiers | HMAC-SHA256 with a random 32-byte pepper generated on first start and stored in `server_settings` (restored with the database) instead of server-side Argon2; existing Argon2 hashes are upgraded on the next successful login. |
| Note writes | `revision` column with conditional update; `409 REVISION_CONFLICT` returns the current note. Any rejected write (stale or missing `baseRevision`) is stored server-side as a `conflict` revision so nothing is lost, including writes from pre-upgrade tabs. |
| History | `note_revisions` stores opaque ciphertext snapshots (time/session based policy, bounded per note; unresolved conflicts are never pruned). |
| Envelopes | v3 = v2 + `keyId` (+ `revision` for note content), AAD is a canonical JSON array. v1/v2 stay readable; per-account `min_envelope_version` is raised only after a verified full upgrade/rotation. |
| Blobs | v3 chunked format (1 MiB chunks, per-chunk IV, AAD binds keyId/blobUuid/index/isLast); format and blobUuid are recorded inside the encrypted note, not trusted from headers. `storage_key` relative to `STORAGE_DIR`. Atomic temp-file writes. |
| Blob GC | `blob_refs(note_id, blob_id)` reported on every save; revisions carry their ref set. GC only for users whose refs are fully known (after client reconciliation), 30-day grace, files moved to a deleted-files area before final sweep. |
| Importers | Server-side importers removed; replaced by an in-browser importer that encrypts before upload. |

## Finding checklist

Test names refer to `server/test/*.test.js` (server), `client/src/**/*.test.js`
(client) and `client/e2e/*.e2e.js` (browser).

| ID | Status | Resolution and evidence |
|---|---|---|
| DATA-1 | done | `PUT` requires `encryptedContent` for E2EE accounts; plaintext from old tabs gets `409 CLIENT_OUTDATED`. Server "DATA-1: encrypted content can never be erased by a save". |
| DATA-2 | done | Encrypted IndexedDB outbox, retry with backoff, pause/resume on expired session, visible save state (now also during the editor debounce), upload errors surfaced. Client "saving (DATA-2)"; browser "session expiry while typing…", "offline edits…". |
| DATA-3 | done | Revisions + conditional writes; rejected writes kept as conflict revisions; conflict banner with mine/theirs/keep both. Server "DATA-3: optimistic concurrency"; client "concurrent devices (DATA-3)"; browser "two devices: … keep both". |
| DATA-4 | done | Client never deletes blobs; server reference tracking + grace-period GC + deleted-files area. Server "DATA-4: attachments are never deleted by an edit", maintenance tests; browser "deleting an image and undoing keeps the image, also after garbage collection". |
| DATA-5 | done | Upgrade covers trashed notes, tolerates missing/malformed files, stages server-side and commits atomically only after the recovery key is confirmed; abort keeps the legacy session. Server "DATA-5 / DATA-7 / CRYPTO-3"; client "legacy account upgrade"; browser "a 1.x account upgrades in the browser". |
| DATA-6 | done | Server-side importers (and their plaintext backups/SQL dump writers) removed; in-browser importer encrypts before upload and never replaces notes; plaintext residue in E2EE accounts is re-encrypted automatically. Client "in-browser import (ARCH-4)", "encrypts plaintext residue…". |
| DATA-7 | done | Legacy-mode writes take the per-user note lock and are refused after the switch. Server "DATA-7: …" (2 tests). |
| DATA-8 | done | One bad record is flagged ("Can't decrypt this note", diagnostic view) instead of emptying the list; unreadable summaries are rebuilt from readable content (revision-guarded). Server "summary repair (DATA-8)"; client 2 "DATA-8" tests; browser 2 "DATA-8" tests. |
| DATA-9 | done | Confirmation for permanent deletion, scheduled trash purge, Ctrl/Cmd+D no longer fires while typing. Server "scheduled maintenance (PERF-1, DATA-9, DATA-4, SEC-7)". |
| DATA-10 | done | Malformed percent-encoding is skipped (server and client). Server "DATA-10: malformed percent-encoding"; client legacy upgrade test with `/api/uploads/100%.jpg`. |
| SEC-1 | done | Legacy uploads served only to the recorded owner (`legacy_uploads`), never publicly; operator script for ownership. Server "SEC-1: legacy files are only readable by their recorded owner". |
| SEC-2 | done | `import-notes.js` (shell command injection) removed. |
| SEC-3 | done | `import-script.js` (path traversal) removed; the browser importer resolves media only inside the chosen folder. Client "import plan and media resolution (SEC-3 in the browser)". |
| SEC-4 | done | Revocable server-side sessions, session list, sign out others, logout/password change/recovery revoke. Server "SEC-4: sessions are revocable". |
| SEC-5 | done | Rate limits (IP and per account), no server-side Argon2, bounded bodies. Server "SEC-5: abuse controls". |
| SEC-6 | done | Deletion requires the password-derived secret and is one transaction; files are moved, not unlinked mid-request. Server "SEC-6: account deletion"; client "account deletion requires the password (SEC-6)". |
| SEC-7 | done | Streamed size-limited uploads, per-user quota, atomic temp files, GC of orphans. Server "uploads (SEC-7, SEC-10, OPS-2)". |
| SEC-8 | done | Express 4 → 5, multer (deprecated 1.x) and node-html-parser removed, TipTap/ProseMirror and the rest updated to current releases; `npm audit --omit=dev`: 0 vulnerabilities in server and client; CI audits; Dependabot configured. |
| SEC-9 | done (documented) | Canonical prelogin responses, salt-less rows get the decoy, emails case-insensitive. Remaining distinguishers (1.x accounts, non-default KDF parameters, open sign-up) documented in `docs/CRYPTOGRAPHY.md`. Server "SEC-9: …". |
| SEC-10 | done | zod validation layer; 4xx instead of 500. Server "SEC-10: …" (2 suites). |
| SEC-11 | done | helmet (CSP, HSTS, no X-Powered-By), self-hosted fonts, non-extractable keys, auto-lock, local cache cleared on logout unless the device opts in. Server "security headers (SEC-11, OPS-1)"; client vault tests. |
| CRYPTO-1 | done | Vault key rotation with key ring, resumable re-encryption, sign-out of other sessions. Server "CRYPTO-1: vault key rotation"; client "rotates the vault key, re-encrypts everything…". |
| CRYPTO-2 | done | Upgrading a 1.x account requires a new password (≥ 12 chars, checked in the browser); weak KDF settings flagged and upgraded on password change. Client "legacy account upgrade", "flags weak (floor) parameters". |
| CRYPTO-3 | done (documented) | Upgrade encrypts linked attachments too and quarantines originals; rescue for already-encrypted accounts; `residue-report` lists remaining plaintext. Deleting the live server's existing plaintext files is left to the operator. Server "CRYPTO-3: …" (2 suites). |
| CRYPTO-4 | done | Recovery key modal cannot be dismissed accidentally and needs confirmation; password change keeps the recovery key; new recovery key is two-phase. Client "a password change keeps the existing recovery key working", "regenerating the recovery key is two-phase"; browser "signup: the recovery key cannot be dismissed by accident". |
| CRYPTO-5 | done | v3 envelopes bind key and revision; blob v3 binds uuid/chunks; references from the encrypted note; envelope floor after full upgrade; rollback warning from per-device high-water marks. Client "CRYPTO-5: …", "refuses v1/v2 data once the account requires v3", "detects truncation, chunk reordering and swapping attachments". |
| PERF-1 | done | Partial indexes on `notes(user_id, updated_at)` (active), `(user_id, deleted_at)` (trash), `(user_id, sync_seq)`; purge moved from a GET into the maintenance job. Server "scheduled maintenance (PERF-1, …)". |
| PERF-2 | done | Binary attachments end to end (no base64), chunked v3 encryption, streamed downloads. Client blob round-trip tests. |
| PERF-3 | done | Summary list, delta sync by `sync_seq` with tombstones, batch body fetch, pagination, cached ciphertext. Server "listing, sync, batch and pagination (PERF-3)". |
| PERF-4 | done | Debounced saves (1 s pause / 5 s max), summary re-encrypted only when it changed, search index cached encrypted per revision. Client store tests. |
| ARCH-1 | done | Framework-free `noteStore` (+ codecs, account, attachments, vault modules); Dashboard reduced to UI. Client store/account tests. |
| ARCH-2 | done | `createApp`/`createContext`, router factories, validation and error layer, services. Server "ARCH-2: API routing". |
| ARCH-3 | done | Versioned migrations with checksums and advisory lock; verified on empty, 1.x-shaped and live-copy databases. Server "ARCH-3: schema migrations". |
| ARCH-4 | done | One in-browser importer; README rewritten. Client "in-browser import (ARCH-4)". |
| ARCH-5 | done | Link/Underline come from StarterKit 3, configured once; the duplicate `@tiptap/extension-underline` and the undeclared `@tiptap/extension-link` import are gone. |
| OPS-1 | done | `COOKIE_SECURE` default true, `TRUST_PROXY`, HSTS, configurable CORS, least-privilege role script, HTTPS error message, reverse-proxy docs. Server "OPS-1 / SEC-7: deployment defaults". |
| OPS-2 | done | Relative storage keys (absolute Windows paths of both casings migrated), `verify-storage`, backup/restore order documented. Server "OPS-2: verify-storage", "derives relative storage keys…", "keeps working after the storage directory is moved". |
| TEST-1 | done | Server 110 tests, client 55 tests, browser 9 tests; CI runs them all plus lint, audit and a boot test. |
| Other notes (§3) | done | Swallowed errors surfaced; abandoned empty notes cleaned up by maintenance; profile hint matches the 25 MB limit; Replace all no longer crosses hard breaks (client "does not match across a hard break"). |
| Other scalability notes (§4) | done | Blob downloads streamed; HMAC verifiers; per-user quotas. |
| §5.2 claims / §5.3 threat model | done (documented) | README security model and `docs/CRYPTOGRAPHY.md` state what is encrypted, what the server sees, and the limits of web-delivered E2EE; landing page wording adjusted. |

## Additional findings during remediation

- **Editor crash on "New note"** (pre-existing): TipTap's `useEditor` can hand
  out an instance it already destroyed; the autofocus effect then threw and
  React unmounted the whole app (blank page). Guarded, plus an editor error
  boundary. Found by the browser tests.
- **"Saved" shown while keystrokes were still in the 1 s debounce**: the
  status now shows "Saving…" as soon as the editor holds unsent changes.
- **Undecryptable summaries were listed as "Untitled"** and never repaired.
- **Reference reconciliation could overwrite a newer profile-picture
  reference** with a stale one (making the new picture collectable). Now only
  fills an unknown reference, from the profile version the client decrypted.
- **Wrapped keys and the envelope floor**: raising the floor would have
  locked accounts out; wrapped keys are exempt.
- The original CI workflow depended on `init.sql`; replaced.

## Progress log

- 2026-10-30: verified backup at `C:\ftp\notes-backup-20261030-pre-review-fixes`
  (files + `pg_dump`). Ephemeral PG 18 cluster for tests on port 55432
  (scratchpad). Live DB copy restored for migration checks.
- 2026-10-30: work moved to git worktree `C:\ftp\notes-remediation` (branch
  `review-remediation`); live tree restored byte-identical.
- 2026-10-30: server complete (config, migrations 001-008, sessions, HMAC
  verifiers, rate limits, validation/error layer, notes, blobs, users, legacy
  uploads, vault rotation, maintenance, operator scripts).
- 2026-10-30: client libraries, key rotation, legacy rescue, importer, UI.
- 2026-10-30: browser E2E harness (Playwright; the server runs in its own
  process with a test-only control port); 9 browser tests. Fixed the four
  issues listed above. CI rewritten, Dependabot added, docs written. Final
  migration check on a fresh restore of the live dump: all ciphertext, key
  material, verifiers and timestamps identical before/after; storage
  consistent (63/63 files).
