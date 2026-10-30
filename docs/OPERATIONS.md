# Operations

Commands below run in `server/` and read `server/.env`, like the server.

## Upgrading from 1.x to 2.0

2.0 replaces `init.sql`/`schema.js` with versioned migrations
(`server/migrations/*.sql`), applied automatically on start and recorded in
`schema_migrations` with a checksum. They only add tables, columns,
constraints and indexes, and convert data in place where noted; they never
delete notes, ciphertext or files.

| Migration | What it does to existing data |
|---|---|
| 001_baseline | Creates any 1.x table or column that is missing (fresh installs). |
| 002_integrity_and_sync | Timestamps become `timestamptz`; adds note revisions, sync sequence numbers, `NOT NULL`/ownership constraints and indexes. |
| 003_sessions | Server-side sessions, instance settings (verifier pepper). |
| 004_note_history | Encrypted version history and conflict copies. |
| 005_blob_lifecycle | Attachment reference tracking; absolute file paths become storage keys relative to `STORAGE_DIR`. |
| 006_legacy_uploads | Ownership table for 1.x upload files. |
| 007_vault_keys | Key ids, key ring and minimum envelope version per account. |
| 008_migration_staging | Staging area for the in-browser 1.x upgrade. |

1.x stored timestamps without a time zone, written in the database's time
zone. 002 interprets them in the database session time zone, so do not
change the PostgreSQL `TimeZone` setting before upgrading.

Steps:

1. Stop the server. Close open browser tabs of the app (1.x pages cannot save
   to 2.0; their saves are refused or kept as conflict copies, not applied).
2. Back up (next section): `pg_dump`, `STORAGE_ROOT` and `server/uploads`.
3. Update the code, then install and build:

   ```
   cd server && npm ci
   cd ../client && npm ci && npm run build
   ```

4. Optional: `npm run migrate -- --status` (in `server/`) lists pending
   migrations; `npm run migrate` applies them without starting the server.
5. Start the server. The log shows `Applied database migrations: ...` once.
6. Run `npm run verify-storage`: it must report `Storage is consistent.`
7. Sign in. Existing 1.x session cookies are converted once into revocable
   sessions, so devices stay signed in; as after any reload, the vault is
   then unlocked with the password.

Configuration defaults keep 1.x installs working (database settings, blob
directory `server/storage/blobs`, uploads `server/uploads`). New behavior to
check: `COOKIE_SECURE` defaults to `true`, HSTS is on by default, rate limits
are on, and `TRUST_PROXY` must be set behind a reverse proxy (see README).

Rollback: stop the server, restore the pre-upgrade dump and file copies,
check out the previous code. Data written after the upgrade is lost in a
rollback, so do it immediately or not at all.

## Backup and restore

A complete backup is the database plus the encrypted files. The database
alone is not enough: attachments live on disk.

```
pg_dump -Fc -d notes_app -f notes-YYYYMMDD.dump        # 1. database first
# 2. then copy the whole STORAGE_ROOT (blobs/ and deleted/) and server/uploads
```

Take the dump first, then copy the files. Uploads write the file before the
row commits, and the collector deletes rows before it moves files into
`deleted/` (kept `DELETED_FILES_RETENTION_DAYS`, default 7), so every row in
the dump has its file in the copy, in `blobs/` or in `deleted/`.

The verifier pepper and other instance secrets are stored in the database
(`server_settings`): restoring a dump restores them. `JWT_SECRET` in `.env`
is still used to convert 1.x session cookies and to derive the decoy
answers for unknown email addresses at sign-in; keep `.env` with the backup
and do not change the secret.

Restore:

```
createdb notes_app
pg_restore --no-owner -d notes_app notes-YYYYMMDD.dump
# copy STORAGE_ROOT and server/uploads back
npm run verify-storage -- --repair    # moves files a row needs back out of deleted/
npm run verify-storage                # must end with "Storage is consistent."
```

Test a restore into a scratch database and directory from time to time.

## Storage check

`npm run verify-storage` compares `blobs` rows with files (read-only):
missing files, size mismatches, rows without files, orphan files. Exit code
0 means consistent, 2 means problems. `--json` prints a report; `--repair`
only moves files back from the deleted-files area.

## Maintenance jobs

The server runs these hourly (`MAINTENANCE_INTERVAL_MINUTES`;
`BACKGROUND_JOBS=false` disables them; `npm run maintenance` runs them once
and is safe next to a running server):

- empty notes from the trash after `TRASH_RETENTION_DAYS` (30);
- remove notes that were created but never saved;
- delete history snapshots and resolved conflict copies older than
  `REVISION_MAX_AGE_DAYS` (365); unresolved conflict copies are kept (the
  per-note cap `MAX_REVISIONS_PER_NOTE` is applied when a note is saved);
- collect attachments no note, history entry or profile references, after
  `BLOB_GC_GRACE_DAYS` (30) unreferenced. Only for accounts whose references
  are fully known; a client reports references for older notes after
  sign-in, and until then nothing of that account is collected;
- delete collected files after `DELETED_FILES_RETENTION_DAYS` (7), quarantined
  1.x uploads after `LEGACY_QUARANTINE_DAYS` (30), stale upload temp files,
  expired sessions and abandoned upgrade staging data.

## Plaintext left over from 1.x

Encrypted accounts never send plaintext, but 1.x left some on disk and in
the database. `npm run residue-report` lists it without changing anything:

1. `server/uploads`: files uploaded before encryption. They are no longer
   served publicly; only the recorded owner can read them (SEC-1). When an
   account upgrades, the browser encrypts the files its notes reference and
   the server moves the originals to the quarantine area. Encrypted accounts
   can do the same later for files their notes still link to: Settings >
   Encryption > Attachments from before encryption.
2. The quarantine area (deleted automatically after 30 days).
3. Files from the removed server-side importers: `server/import-backups/`,
   `server/import-notes.sql` and export folders such as `iCloud/`.
4. Plaintext note rows inside encrypted accounts (encrypted automatically by
   the owner's next session).
5. Accounts that have not upgraded yet.

Removing any of this is the operator's decision: first sign in and check that
the notes and attachments open, keep an offline backup if you want one, then
delete. Copies in older backups remain plaintext.

Ownership of 1.x upload files (`npm run legacy-uploads`):

```
npm run legacy-uploads -- --report                  # files and recorded owners
npm run legacy-uploads -- --assign <file> <userId>  # after checking yourself
npm run legacy-uploads -- --assign-by-reference     # files linked from exactly one legacy account
```

## Database role

`server/scripts/create-app-role.sql` creates a `notes_app` role that owns
only its database (no superuser, no role or database creation) and shows how
to hand an existing database over to it. Then set `DB_USER=notes_app`.

## Other operator notes

- Signing out everywhere: Settings > Security lists sessions per device;
  a password change or recovery signs out every other session.
- Rate limits (`RATE_LIMIT_*`) are kept in memory per server process.
- Large attachments: `MAX_BLOB_BYTES` (25 MiB) per file and
  `USER_STORAGE_QUOTA_BYTES` (2 GiB) per account; a reverse proxy must allow
  request bodies at least that large.
