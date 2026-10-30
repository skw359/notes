# Notes

[![CI](https://github.com/skw359/notes/actions/workflows/ci.yml/badge.svg)](https://github.com/skw359/notes/actions/workflows/ci.yml)

A self-hosted notes app with end-to-end encryption.

- Client: React, Vite, TipTap editor
- Server: Node.js (20.19+), Express 5, PostgreSQL (tested on 18)
- Encryption: AES-256-GCM; keys derived from the password with Argon2id

## Security model

What the encryption covers, and what it does not:

| Encrypted in the browser (server stores ciphertext only) | Visible to the server (and to anyone who obtains a database dump) |
|---|---|
| Note bodies, note titles/previews, the search index cached on devices | Account email address, KDF salt and parameters |
| Attachments and images (chunked, authenticated) | Number of notes, their sizes, created/updated/trashed times, revision numbers |
| Profile name and profile picture | Number and sizes of attachments, which note references which attachment |
| Version history snapshots and conflict copies | Sessions: sign-in times, IP address, browser user agent |

- **Keys.** Each account has a random vault key. The browser wraps it with a
  key derived from your password (Argon2id, 64 MiB, 3 passes by default) and
  separately with a recovery key shown once at signup. The server stores only
  the wrapped copies and a verifier it cannot turn back into your password.
  Lose both your password and your recovery key and your notes cannot be
  recovered by anyone.
- **Integrity.** Every ciphertext is bound to the account key, the note and
  field it belongs to and, for note bodies, the revision, so the server cannot
  swap, move or silently replay records; devices also warn when the server
  serves an older revision than they have already seen.
- **Web-delivered code.** The page that does the encryption is served by the
  same server. Someone who controls the server (or the connection, without
  HTTPS) can ship a modified page that captures your password the next time
  you unlock. End-to-end encryption here protects stored data, backups and
  database dumps; it does not protect you from the operator of the server
  you log in to. Serve the app only over HTTPS (see below).
- **The server can still lose or delete data.** Encryption is not a backup.
  Back up the database and the storage directory (see
  [docs/OPERATIONS.md](docs/OPERATIONS.md)).
- **Accounts from version 1.x** that never enabled encryption keep plaintext
  on the server until their owner signs in and completes the upgrade screen.

Details: [docs/CRYPTOGRAPHY.md](docs/CRYPTOGRAPHY.md).

## Install

Requirements: Node.js 20.19 or newer, PostgreSQL (13 or newer should work;
tests and CI use 18), and HTTPS in front of the app (browsers only allow the Web Crypto API on `https://` pages
and on `http://localhost`).

1. Create a database and a least-privilege role (as a PostgreSQL superuser):

   ```
   psql -U postgres -v app_password="'choose-a-strong-password'" -f server/scripts/create-app-role.sql
   psql -U postgres -c "CREATE DATABASE notes_app OWNER notes_app"
   ```

2. Configure the server:

   ```
   cp server/.env.example server/.env
   ```

   Set `JWT_SECRET` (`openssl rand -hex 32`), `DB_USER=notes_app` and
   `DB_PASSWORD`. Every other setting is optional and documented in
   `server/.env.example`.

3. Install and build:

   ```
   cd server && npm ci
   cd ../client && npm ci && npm run build
   ```

4. Start: `cd server && npm start`. The server applies pending database
   migrations on start, then serves the built client and the API on port 3004
   (`PORT`).

### HTTPS and a reverse proxy

Run the app behind a TLS-terminating proxy on the same machine, listen on
loopback only, and tell the server about the proxy:

```
# server/.env
HOST=127.0.0.1
TRUST_PROXY=loopback
```

Caddy (obtains certificates automatically):

```
notes.example.com {
    reverse_proxy 127.0.0.1:3004
}
```

nginx:

```
server {
    listen 443 ssl;
    server_name notes.example.com;
    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;
    client_max_body_size 30m;   # at least MAX_BLOB_BYTES

    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Settings that depend on how the app is reached:

- `COOKIE_SECURE` (default `true`): the session cookie is only sent over
  HTTPS. Chrome and Firefox also accept it on `http://localhost`; Safari does
  not, so use `COOKIE_SECURE=false` for plain-HTTP development in Safari.
- `TRUST_PROXY`: without it, every request behind a proxy appears to come
  from the proxy's address, so rate limits and the session list see one IP.
- `HSTS_MAX_AGE` (default 180 days): browsers that load the app over HTTPS
  then refuse plain HTTP for that **host name on every port** for that long.
  If other plain-HTTP services share the host name, give the app its own
  name or set `HSTS_MAX_AGE=0`.
- `SIGNUP_MODE`: `open` (default), `invite` (requires `SIGNUP_INVITE_CODE`)
  or `closed`.

## Using it

- **Saving.** Edits are encrypted and kept in an outbox on the device until
  the server confirms them. The status next to the note shows Saving, Saved,
  Offline, Sign in again or a conflict; nothing is discarded silently.
- **Conflicts and history.** Editing an outdated copy of a note produces a
  visible conflict with "keep mine", "keep theirs" and "keep both". Earlier
  versions are kept as encrypted snapshots under History.
- **Trash.** Deleted notes stay in the trash for 30 days.
- **Settings.** Change password (the recovery key keeps working; accounts
  created with older, weaker key-derivation settings are upgraded to the
  current ones), create a new recovery key, replace the vault key, upgrade
  old encrypted records to the current format, list and sign out devices,
  auto-lock, and delete the account (requires the password).
- **Importing.** Settings → Import reads a folder of Markdown or HTML notes,
  including an Apple Notes export with images, encrypts everything in the
  browser and uploads it. The server never sees the imported text.
- **Version 1.x accounts** are asked to choose a new password once; the
  browser then encrypts every note, the trash and the uploaded files.

## Operations

[docs/OPERATIONS.md](docs/OPERATIONS.md) covers upgrading from 1.x, backup and
restore, storage checks, maintenance jobs, the operator scripts and clearing
the plaintext left over from 1.x.

## Development

```
cd server && npm run dev        # API on :3004
cd client && npm run dev        # http://localhost:5173, proxies /api to :3004
```

Tests use a disposable PostgreSQL server and create and drop their own
databases on it. Never point `TEST_DATABASE_URL` at a real deployment.

```
export TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres
cd server && npm test                         # API, migrations, storage, security
cd client && npm test                         # crypto, store and account flows against the real server
cd client && npm run build && npm run test:e2e   # browser tests (Playwright, Chromium)
```

CI runs all three plus lint, a production dependency audit and a boot test.
