import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backfillLegacyUploads,
  extractLegacyFilenameFromUrl,
  extractLegacyFilenamesFromContent,
  inferOwnerFromFilename,
} from '../lib/legacyUploads.js';
import { createTestApp, insertLegacyNote, insertLegacyUser, uploadBlob } from './helpers/app.js';
import { decryptJson, encryptBytes, encryptJson, makeAccount, TEST_KDF_PARAMS } from './helpers/e2ee.js';

let t;

beforeAll(async () => {
  t = await createTestApp();
  await fsp.mkdir(t.config.storage.legacyUploadsDir, { recursive: true });
});

afterAll(async () => {
  await t.close();
});

async function legacyAgent(legacy) {
  const agent = request.agent(t.app);
  const res = await agent.post('/api/auth/login').send({ email: legacy.email, password: legacy.password });
  expect(res.status).toBe(200);
  return agent;
}

async function writeLegacyFile(filename, contents, ownerId) {
  await fsp.writeFile(path.join(t.config.storage.legacyUploadsDir, filename), contents);
  if (ownerId) {
    await t.pool.query("INSERT INTO legacy_uploads (filename, user_id, source) VALUES ($1, $2, 'test')", [filename, ownerId]);
  }
}

function migrationBody(account, extra = {}) {
  return {
    authSalt: account.salt,
    kdfParams: TEST_KDF_PARAMS,
    authVerifier: account.authSecret,
    recoveryVerifier: account.recoveryVerifier,
    wrappedVaultKey: encryptBytes(account.kek, account.vaultKey, { context: 'vault-key:password', keyId: account.keyId }),
    wrappedVaultKeyRecovery: encryptBytes(account.recoveryWrappingKey, account.vaultKey, {
      context: 'vault-key:recovery',
      keyId: account.keyId,
    }),
    encryptedProfile: encryptJson(account.vaultKey, { first_name: 'Leg' }, { context: 'profile', keyId: account.keyId }),
    vaultKeyId: account.keyId,
    ...extra,
  };
}

function stagedNote(account, note, blobIds = []) {
  return {
    id: note.id,
    sourceRevision: note.revision,
    encryptedContent: encryptJson(account.vaultKey, note.content, {
      context: `note-content:${note.id}`,
      keyId: account.keyId,
    }),
    encryptedSummary: encryptJson(account.vaultKey, { title: 't' }, { context: `note-summary:${note.id}`, keyId: account.keyId }),
    blobIds,
  };
}

describe('SEC-1: legacy files are only readable by their recorded owner', () => {
  it('ignores note-text references to someone else’s file', async () => {
    const victim = await insertLegacyUser(t.pool);
    const attacker = await insertLegacyUser(t.pool);
    const filename = `${victim.user.id}-1700000000001.jpg`;
    await writeLegacyFile(filename, 'VICTIM PRIVATE PHOTO BYTES', victim.user.id);

    const agent = await legacyAgent(attacker);
    expect((await agent.get(`/api/legacy-uploads/${filename}`)).status).toBe(404);
    // Planting a reference (the old ILIKE ownership check) changes nothing.
    await insertLegacyNote(t.pool, attacker.user.id, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: filename }] }],
    });
    expect((await agent.get(`/api/legacy-uploads/${filename}`)).status).toBe(404);
    expect((await agent.get('/api/legacy-uploads/%25')).status).toBe(404);

    const owner = await legacyAgent(victim);
    const res = await owner.get(`/api/legacy-uploads/${filename}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['x-legacy-mime-type']).toBe('image/jpeg');
  });

  it('rejects traversal-shaped names', async () => {
    const owner = await insertLegacyUser(t.pool);
    const agent = await legacyAgent(owner);
    for (const name of ['..%2F.env', '..%5C.env', '.env']) {
      const res = await agent.get(`/api/legacy-uploads/${name}`);
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe('ownership backfill', () => {
  it('derives owners from trusted prefixes and leaves unprovable files unassigned', () => {
    expect(inferOwnerFromFilename('12-1700000000000.jpg')).toEqual({ userId: 12, source: 'prefix:profile' });
    expect(inferOwnerFromFilename('note-3-1772685263491.png')).toEqual({ userId: 3, source: 'prefix:note' });
    expect(inferOwnerFromFilename('imported-u7-32e80cbbed7c-file.pdf')).toEqual({ userId: 7, source: 'prefix:import' });
    expect(inferOwnerFromFilename('imported-IMG_0001.png')).toBeNull();
  });

  it('assigns prefixed files and skips unprefixed ones on a multi-user instance', async () => {
    const owner = await insertLegacyUser(t.pool);
    const named = `imported-u${owner.user.id}-abc123def456-scan.pdf`;
    const unprefixed = `imported-shared-${crypto.randomBytes(3).toString('hex')}.png`;
    await writeLegacyFile(named, 'pdf');
    await writeLegacyFile(unprefixed, 'png');

    const result = await backfillLegacyUploads({
      pool: t.pool,
      legacyUploadsDir: t.config.storage.legacyUploadsDir,
      log: { warn() {} },
    });
    expect(result.unassigned).toContain(unprefixed);
    const rows = await t.pool.query('SELECT user_id FROM legacy_uploads WHERE filename = $1', [named]);
    expect(rows.rows[0].user_id).toBe(owner.user.id);
    expect((await t.pool.query('SELECT 1 FROM legacy_uploads WHERE filename = $1', [unprefixed])).rows).toHaveLength(0);
  });
});

describe('DATA-10: malformed percent-encoding', () => {
  it('does not throw while extracting legacy filenames', () => {
    expect(extractLegacyFilenameFromUrl('/api/uploads/100%.jpg')).toBeNull();
    expect(extractLegacyFilenameFromUrl('/api/uploads/a%20b.jpg')).toBe('a b.jpg');
    expect(extractLegacyFilenameFromUrl('/api/uploads/..%2Fsecret')).toBeNull();
    const names = extractLegacyFilenamesFromContent({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: '/api/uploads/100%.jpg' } },
        { type: 'image', attrs: { src: '/api/uploads/ok.png' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'pdf', marks: [{ type: 'link', attrs: { href: '/api/uploads/doc.pdf' } }] }] },
      ],
    });
    expect([...names].sort()).toEqual(['doc.pdf', 'ok.png']);
  });
});

describe('DATA-5 / DATA-7 / CRYPTO-3: legacy -> encrypted migration', () => {
  it('migrates every note including trashed ones, keeps trash state and quarantines plaintext files', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const image = `imported-u${legacy.user.id}-aaaaaaaaaaaa-photo.png`;
    const attachment = `imported-u${legacy.user.id}-bbbbbbbbbbbb-tax.pdf`;
    await writeLegacyFile(image, 'PNG BYTES', legacy.user.id);
    await writeLegacyFile(attachment, 'PDF BYTES', legacy.user.id);
    const active = await insertLegacyNote(t.pool, legacy.user.id, {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: `/api/uploads/${image}` } },
        { type: 'paragraph', content: [{ type: 'text', text: 'tax', marks: [{ type: 'link', attrs: { href: `/api/uploads/${attachment}` } }] }] },
        { type: 'image', attrs: { src: '/api/uploads/missing-file.jpg' } },
        { type: 'image', attrs: { src: '/api/uploads/100%.jpg' } },
      ],
    });
    const trashed = await insertLegacyNote(t.pool, legacy.user.id, { type: 'doc', content: [] }, { deleted: true });

    const agent = await legacyAgent(legacy);
    const set = await agent.get('/api/auth/migration-set');
    expect(set.status).toBe(200);
    expect(set.body.notes.map((n) => n.id).sort()).toEqual([active.id, trashed.id].sort());
    expect(set.body.notes.find((n) => n.id === trashed.id).deleted_at).not.toBeNull();
    expect(set.body.files.map((f) => f.filename).sort()).toEqual([attachment, image].sort());
    expect(set.body.unavailableFiles).toContain('missing-file.jpg');

    const account = makeAccount();
    // The client re-encrypts the files as blobs before the switch.
    const imageBlob = (await uploadBlob(agent, crypto.randomBytes(20), { keyId: account.keyId })).body.blob;
    const pdfBlob = (await uploadBlob(agent, crypto.randomBytes(20), { keyId: account.keyId })).body.blob;

    const stage = await agent.post('/api/auth/migration/stage').send({
      notes: set.body.notes.map((note) => stagedNote(account, note, note.id === active.id ? [imageBlob.id, pdfBlob.id] : [])),
    });
    expect(stage.status).toBe(200);

    const migrate = await agent.post('/api/auth/migrate').send(
      migrationBody(account, {
        migratedFiles: [
          { filename: image, blobId: imageBlob.id },
          { filename: attachment, blobId: pdfBlob.id },
        ],
      })
    );
    expect(migrate.status).toBe(200);
    expect(migrate.body.user.auth_mode).toBe('e2ee');
    expect(migrate.body.quarantinedFiles).toBe(2);

    const rows = await t.pool.query('SELECT * FROM notes WHERE user_id = $1 ORDER BY id', [legacy.user.id]);
    for (const row of rows.rows) {
      expect(row.content).toBeNull();
      expect(row.encrypted_content).not.toBeNull();
    }
    expect(rows.rows.find((r) => r.id === trashed.id).deleted_at).not.toBeNull();
    expect(decryptJson(account.vaultKey, rows.rows.find((r) => r.id === active.id).encrypted_content).type).toBe('doc');

    const user = (await t.pool.query('SELECT * FROM users WHERE id = $1', [legacy.user.id])).rows[0];
    expect(user.password_hash).toBeNull();
    expect(user.first_name).toBeNull();

    // Plaintext files left the served directory (quarantined, swept later).
    const uploads = await fsp.readdir(t.config.storage.legacyUploadsDir);
    expect(uploads).not.toContain(image);
    expect(uploads).not.toContain(attachment);
    const quarantine = await fsp.readdir(t.config.storage.legacyQuarantineDir);
    expect(quarantine.some((name) => name.endsWith(attachment))).toBe(true);

    // Blob references were recorded, so GC can reason about them.
    const refs = await t.pool.query('SELECT blob_id FROM blob_refs WHERE note_id = $1 ORDER BY blob_id', [active.id]);
    expect(refs.rows.map((r) => r.blob_id)).toEqual([imageBlob.id, pdfBlob.id].sort((a, b) => a - b));

    // The account now logs in with the new verifier only.
    expect((await request(t.app).post('/api/auth/login').send({ email: legacy.email, password: legacy.password })).status).toBe(401);
    expect((await request(t.app).post('/api/auth/login').send({ email: legacy.email, authSecret: account.authSecret })).status).toBe(200);
  });

  it('refuses the switch when a note changed after staging (MIGRATION_STALE) and loses nothing', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const note = await insertLegacyNote(t.pool, legacy.user.id, { type: 'doc', content: [] });
    const agent = await legacyAgent(legacy);
    const account = makeAccount();
    await agent.post('/api/auth/migration/stage').send({ notes: [stagedNote(account, note)] });

    // Another legacy tab edits the note in between.
    const edit = await agent.put(`/api/notes/${note.id}`).send({
      baseRevision: 1,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'late edit' }] }] },
    });
    expect(edit.status).toBe(200);

    const migrate = await agent.post('/api/auth/migrate').send(migrationBody(account));
    expect(migrate.status).toBe(409);
    expect(migrate.body.code).toBe('MIGRATION_STALE');
    expect(migrate.body.stale).toEqual([note.id]);
    const row = (await t.pool.query('SELECT * FROM notes WHERE id = $1', [note.id])).rows[0];
    expect(row.content.content[0].content[0].text).toBe('late edit');
    expect((await t.pool.query('SELECT auth_mode FROM users WHERE id = $1', [legacy.user.id])).rows[0].auth_mode).toBe('legacy');
  });

  it('refuses migration when a note was never staged', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const note = await insertLegacyNote(t.pool, legacy.user.id, { type: 'doc' });
    const agent = await legacyAgent(legacy);
    const migrate = await agent.post('/api/auth/migrate').send(migrationBody(makeAccount()));
    expect(migrate.status).toBe(409);
    expect(migrate.body.missing).toEqual([note.id]);
  });

  it('DATA-7: a legacy-mode write after the switch is refused, never stored as plaintext', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const note = await insertLegacyNote(t.pool, legacy.user.id, { type: 'doc' });
    const migrating = await legacyAgent(legacy);
    const staleTab = await legacyAgent(legacy);
    const account = makeAccount();
    await migrating.post('/api/auth/migration/stage').send({ notes: [stagedNote(account, note)] });
    expect((await migrating.post('/api/auth/migrate').send(migrationBody(account))).status).toBe(200);

    // The other tab's legacy session was revoked by the migration...
    const res = await staleTab.put(`/api/notes/${note.id}`).send({ content: { type: 'doc', content: [] } });
    expect(res.status).toBe(401);
    // ...and even with a valid session, plaintext is refused.
    const fresh = request.agent(t.app);
    await fresh.post('/api/auth/login').send({ email: legacy.email, authSecret: account.authSecret });
    const plaintext = await fresh.put(`/api/notes/${note.id}`).send({ content: { type: 'doc', content: [] } });
    expect(plaintext.status).toBe(409);
    expect(plaintext.body.code).toBe('CLIENT_OUTDATED');
    const row = (await t.pool.query('SELECT content, encrypted_content FROM notes WHERE id = $1', [note.id])).rows[0];
    expect(row.content).toBeNull();
    expect(row.encrypted_content).not.toBeNull();
  });

  it('DATA-7: a legacy write racing the switch waits for it and is then refused', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const note = await insertLegacyNote(t.pool, legacy.user.id, { type: 'doc' });

    // Hold the same locks /migrate takes, flip the mode, and let a legacy
    // write arrive meanwhile.
    const blocker = await t.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(7301, $1)', [legacy.user.id]);
    await blocker.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [legacy.user.id]);
    await blocker.query(`UPDATE users SET auth_mode = 'e2ee' WHERE id = $1`, [legacy.user.id]);
    await blocker.query('UPDATE notes SET content = NULL, encrypted_content = $2 WHERE id = $1', [
      note.id,
      JSON.stringify(encryptJson(crypto.randomBytes(32), { type: 'doc' }, { context: `note-content:${note.id}`, keyId: 'abcdefghij' })),
    ]);

    const racing = t.pool.query('UPDATE notes SET content = $2 WHERE id = $1', [
      note.id,
      JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PLAINTEXT during migration' }] }] }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await blocker.query('COMMIT');
    blocker.release();

    await expect(racing).rejects.toMatchObject({ code: '23514' });
    const row = (await t.pool.query('SELECT content, encrypted_content FROM notes WHERE id = $1', [note.id])).rows[0];
    expect(row.content).toBeNull();
    expect(row.encrypted_content).not.toBeNull();
  });

  it('a second migration attempt after success reports ALREADY_MIGRATED', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const agent = await legacyAgent(legacy);
    const account = makeAccount();
    expect((await agent.post('/api/auth/migrate').send(migrationBody(account))).status).toBe(200);
    const again = await agent.post('/api/auth/migrate').send(migrationBody(makeAccount()));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_MIGRATED');
  });
});

describe('CRYPTO-3: rescuing legacy attachments for already-encrypted accounts', () => {
  it('lets the owner fetch, then quarantine, a file once re-encrypted', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const filename = `imported-u${legacy.user.id}-cccccccccccc-scan.pdf`;
    await writeLegacyFile(filename, 'PDF', legacy.user.id);
    const agent = await legacyAgent(legacy);
    const account = makeAccount();
    expect((await agent.post('/api/auth/migrate').send(migrationBody(account))).status).toBe(200);
    // Post-commit cleanup already quarantined owned files; simulate a file
    // that was restored to uploads/ by an operator for rescue.
    await t.pool.query('UPDATE legacy_uploads SET quarantined_at = NULL WHERE filename = $1', [filename]);
    await writeLegacyFile(filename, 'PDF');

    const e2ee = request.agent(t.app);
    await e2ee.post('/api/auth/login').send({ email: legacy.email, authSecret: account.authSecret });
    const list = await e2ee.get('/api/legacy-uploads');
    expect(list.body.files.map((f) => f.filename)).toContain(filename);
    expect((await e2ee.get(`/api/legacy-uploads/${filename}`)).status).toBe(200);

    const blob = (await uploadBlob(e2ee, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const done = await e2ee.post(`/api/legacy-uploads/${filename}/migrated`).send({ blobId: blob.id });
    expect(done.status).toBe(200);
    expect((await e2ee.get(`/api/legacy-uploads/${filename}`)).status).toBe(404);
  });
});
