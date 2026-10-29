# Notes

[![CI](https://github.com/skw359/notes/actions/workflows/ci.yml/badge.svg)](https://github.com/skw359/notes/actions/workflows/ci.yml)

A self-hosted notes app with end-to-end encryption. Notes, attachments, and profile data are encrypted in the browser before they reach the server, so the server only stores ciphertext.

## Stack

- Client: React, Vite, TipTap editor
- Server: Node.js, Express
- Database: PostgreSQL
- Encryption: AES-256-GCM, with keys derived from your password using Argon2id

## How encryption works

Each account has a random vault key. The browser wraps it twice, once with a key derived from your password and once with a recovery key shown at signup. The server stores only the wrapped copies. If you lose both your password and your recovery key, your notes cannot be recovered.

## Setup

Requirements: Node.js 20+ and PostgreSQL.

1. Create the database:

   ```
   psql -U postgres -f server/init.sql
   ```

2. Configure the server:

   ```
   cp server/.env.example server/.env
   ```

   Set `JWT_SECRET` (for example, `openssl rand -hex 32`) and `DB_PASSWORD`.

3. Install dependencies:

   ```
   cd server && npm install
   cd ../client && npm install
   ```

## Running

Development (two terminals):

```
cd server && npm run dev
cd client && npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to the server on port 3004.

Production:

```
cd client && npm run build
cd ../server && npm start
```

The server serves the built client from `client/dist` on port 3004, or on `PORT` if you set it.

## Importing Apple Notes

`server/import-script.js` imports an Apple Notes export (HTML files with `images/` and `attachments/` folders). It does a dry run by default:

```
cd server
node import-script.js --user-id 1 --source /path/to/export
node import-script.js --user-id 1 --source /path/to/export --execute --confirm-replace REPLACE_USER_1
```

`--execute` replaces all existing notes for that user. The import writes plaintext notes, so run it against an account that has not been migrated to encryption yet. The notes are encrypted the next time that account logs in.
