import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createContext } from '../app.js';
import { loadConfig } from '../config.js';
import { collectGarbageBlobs } from '../services/blobs.js';
import {
  createEncryptedNote,
  createTestApp,
  loginAgent,
  saveEncrypted,
  signupUser,
  uploadBlob,
} from './helpers/app.js';

let t;

beforeAll(async () => {
  t = await createTestApp({ env: { MAX_BLOB_BYTES: String(64 * 1024), USER_STORAGE_QUOTA_BYTES: String(200 * 1024) } });
});

afterAll(async () => {
  await t.close();
});

async function blobRow(id) {
  return (await t.pool.query('SELECT * FROM blobs WHERE id = $1', [id])).rows[0];
}

async function gc() {
  return collectGarbageBlobs({ pool: t.pool, storage: t.ctx.storage, config: t.config, log: { error() {} } });
}

// Pretend time passed: the blob was uploaded long ago and (if marked) has
// been unreferenced for longer than the grace period.
async function age(blobId, { unreferencedDaysAgo } = {}) {
  await t.pool.query(
    `UPDATE blobs SET created_at = NOW() - INTERVAL '2 days',
       unreferenced_since = CASE WHEN $2::int IS NULL THEN unreferenced_since ELSE NOW() - make_interval(days => $2) END
     WHERE id = $1`,
    [blobId, unreferencedDaysAgo ?? null]
  );
}

describe('uploads (SEC-7, SEC-10, OPS-2)', () => {
  it('stores a v3 blob under a relative storage key and streams it back', async () => {
    const { agent, account } = await signupUser(t.app);
    const bytes = crypto.randomBytes(5000);
    const res = await uploadBlob(agent, bytes, { keyId: account.keyId });
    expect(res.status).toBe(201);

    const row = await blobRow(res.body.blob.id);
    expect(row.storage_key).toMatch(/^u\d+-[0-9a-f]{24}\.bin$/);
    expect(row.key_id).toBe(account.keyId);

    const download = await agent.get(`/api/blobs/${res.body.blob.id}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (chunk) => chunks.push(chunk));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(download.status).toBe(200);
    expect(download.headers['x-blob-version']).toBe('3');
    expect(download.headers['cache-control']).toContain('no-store');
    expect(Buffer.compare(download.body, bytes)).toBe(0);
  });

  it('accepts v2 uploads from pre-upgrade clients', async () => {
    const { agent } = await signupUser(t.app);
    const res = await uploadBlob(agent, crypto.randomBytes(100), { version: 2 });
    expect(res.status).toBe(201);
    expect((await blobRow(res.body.blob.id)).envelope_iv).toBeTruthy();
  });

  it('rejects oversized, empty and wrongly typed uploads without leaving rows or temp files', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const tooBig = await uploadBlob(agent, crypto.randomBytes(t.config.limits.maxBlobBytes + 10), { keyId: account.keyId });
    expect(tooBig.status).toBe(413);

    const empty = await uploadBlob(agent, Buffer.alloc(0), { keyId: account.keyId });
    expect(empty.status).toBe(400);

    const wrongType = await agent.post('/api/blobs').set('Content-Type', 'text/plain').send('hello');
    expect(wrongType.status).toBe(400);

    const missingKey = await agent
      .post('/api/blobs')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Blob-Version', '3')
      .send(Buffer.from('abc'));
    expect(missingKey.status).toBe(400);

    const rows = await t.pool.query('SELECT COUNT(*)::int AS c FROM blobs WHERE user_id = $1', [user.id]);
    expect(rows.rows[0].c).toBe(0);
    const files = await fsp.readdir(t.config.storage.blobsDir);
    expect(files.filter((name) => name.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('enforces the per-user storage quota', async () => {
    const { agent, account } = await signupUser(t.app);
    const chunk = crypto.randomBytes(60 * 1024);
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await uploadBlob(agent, chunk, { keyId: account.keyId })).status);
    }
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses[3]).toBe(413);
    const usage = await agent.get('/api/blobs/usage');
    expect(usage.body.usedBytes).toBe(3 * 60 * 1024);
    expect(usage.body.quotaBytes).toBe(200 * 1024);
  });

  it('is isolated per account', async () => {
    const owner = await signupUser(t.app);
    const blob = (await uploadBlob(owner.agent, crypto.randomBytes(10), { keyId: owner.account.keyId })).body.blob;
    const intruder = await signupUser(t.app);
    expect((await intruder.agent.get(`/api/blobs/${blob.id}`)).status).toBe(404);
    expect((await intruder.agent.delete(`/api/blobs/${blob.id}`)).status).toBe(404);

    // Referencing someone else's blob from your own note links nothing.
    const note = await createEncryptedNote(intruder.agent, intruder.account, 'mine');
    const res = await saveEncrypted(intruder.agent, intruder.account, note, 'steal', { blobIds: [blob.id] });
    expect(res.status).toBe(200);
    expect(res.body.missingBlobIds).toEqual([blob.id]);
    const refs = await t.pool.query('SELECT 1 FROM blob_refs WHERE blob_id = $1', [blob.id]);
    expect(refs.rows).toHaveLength(0);
  });

  it('keeps working after the storage directory is moved (OPS-2)', async () => {
    const { agent, account, email } = await signupUser(t.app);
    const bytes = crypto.randomBytes(300);
    const blob = (await uploadBlob(agent, bytes, { keyId: account.keyId })).body.blob;

    const movedRoot = path.join(t.root, 'restored-elsewhere');
    await fsp.cp(t.config.storage.blobsDir, path.join(movedRoot, 'blobs'), { recursive: true });
    const config = loadConfig({
      JWT_SECRET: t.config.jwtSecret,
      DATABASE_URL: t.config.db.connectionString,
      COOKIE_SECURE: 'false',
      RATE_LIMITS: 'false',
      BACKGROUND_JOBS: 'false',
      STORAGE_ROOT: movedRoot,
      LEGACY_UPLOADS_DIR: path.join(movedRoot, 'uploads'),
    });
    const ctx = await createContext({ config, pool: t.pool, log: { info() {}, warn() {}, error() {} }, clientDist: movedRoot });
    const relocated = createApp(ctx);
    const relocatedAgent = await loginAgent(relocated, email, account);
    const res = await relocatedAgent.get(`/api/blobs/${blob.id}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (chunk) => chunks.push(chunk));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, bytes)).toBe(0);
  });
});

describe('DATA-4: attachments are never deleted by an edit', () => {
  it('deletion requests are soft and refused while a note references the blob', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    await createEncryptedNote(agent, account, 'with image', { blobIds: [blob.id] });

    const refused = await agent.delete(`/api/blobs/${blob.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('BLOB_IN_USE');
    expect(await blobRow(blob.id)).toBeDefined();
  });

  it('delete -> autosave -> undo keeps the image (history and grace period)', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const note = await createEncryptedNote(agent, account, 'photo', { blobIds: [blob.id] });

    // The user deletes the image; autosave stores the note without it.
    const withoutImage = await saveEncrypted(agent, account, note, 'photo removed', { blobIds: [] });
    expect(withoutImage.status).toBe(200);
    // The snapshot of the previous version still references the blob, so a
    // GC run cannot touch it.
    await age(blob.id);
    await gc();
    expect((await blobRow(blob.id)).unreferenced_since).toBeNull();

    // Undo restores the image node; the next save references it again.
    const undone = await saveEncrypted(agent, account, withoutImage.body.note, 'photo back', { blobIds: [blob.id] });
    expect(undone.status).toBe(200);
    expect(undone.body.missingBlobIds).toEqual([]);
    expect(await blobRow(blob.id)).toBeDefined();
  });

  it('cut from one note and paste into another keeps the blob', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const source = await createEncryptedNote(agent, account, 'source', { blobIds: [blob.id] });
    const target = await createEncryptedNote(agent, account, 'target');

    await saveEncrypted(agent, account, source, 'source without image', { blobIds: [] });
    await saveEncrypted(agent, account, target, 'target with image', { blobIds: [blob.id] });
    await age(blob.id, { unreferencedDaysAgo: 365 });
    await gc();
    expect(await blobRow(blob.id)).toBeDefined();
  });

  it('collects nothing while references are unknown (notes saved by older clients)', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const orphan = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const note = await createEncryptedNote(agent, account, 'refs unknown');
    // A pre-upgrade client saves without reporting blob ids.
    await agent.put(`/api/notes/${note.id}`).send({
      baseRevision: note.revision,
      encryptedContent: account.noteContent(note.id, { type: 'doc' }, note.revision + 1),
    });
    expect((await t.pool.query('SELECT blob_refs_known FROM notes WHERE id = $1', [note.id])).rows[0].blob_refs_known).toBe(false);

    await age(orphan.id, { unreferencedDaysAgo: 365 });
    await gc();
    expect(await blobRow(orphan.id)).toBeDefined();

    const usage = await agent.get('/api/blobs/usage');
    expect(usage.body.gc.enabled).toBe(false);
    void user;
  });

  it('collects an unreferenced blob only after the grace period, and a new reference resurrects it', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    await age(blob.id);

    await gc();
    const marked = await blobRow(blob.id);
    expect(marked.unreferenced_since).not.toBeNull();

    // Within the grace period a note references it again.
    const note = await createEncryptedNote(agent, account, 'late reference', { blobIds: [blob.id] });
    expect((await blobRow(blob.id)).unreferenced_since).toBeNull();

    // Removed again and left unreferenced past the grace period: collected.
    // (Delete the note entirely so no snapshot keeps it alive.)
    await agent.put(`/api/notes/${note.id}/trash`);
    await agent.delete(`/api/notes/${note.id}`);
    await gc();
    await age(blob.id, { unreferencedDaysAgo: 31 });
    const before = await blobRow(blob.id);
    const result = await gc();
    expect(result.deleted).toBe(1);
    expect(await blobRow(blob.id)).toBeUndefined();
    // The file is kept in the deleted-files area until the final sweep.
    const deleted = await fsp.readdir(t.config.storage.deletedBlobsDir);
    expect(deleted.some((name) => name.endsWith(before.storage_key))).toBe(true);
  });

  it('a blob referenced from another device is never collected', async () => {
    const { agent, account, email } = await signupUser(t.app);
    const phone = await loginAgent(t.app, email, account);
    const blob = (await uploadBlob(phone, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const note = await createEncryptedNote(agent, account, 'shared');
    // The phone adds the image to the note.
    await saveEncrypted(phone, account, note, 'shared + image', { blobIds: [blob.id] });
    await age(blob.id, { unreferencedDaysAgo: 365 });
    await gc();
    expect(await blobRow(blob.id)).toBeDefined();
  });

  it('the profile picture reference keeps its blob alive', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const profile = account.signupBody('x@example.com').encryptedProfile;
    expect((await agent.put('/api/users/profile').send({ encryptedProfile: profile, profileBlobId: blob.id })).status).toBe(200);
    await age(blob.id, { unreferencedDaysAgo: 365 });
    await gc();
    expect(await blobRow(blob.id)).toBeDefined();
  });
});

async function profileIv(noteId) {
  const result = await t.pool.query(
    'SELECT u.encrypted_profile FROM users u JOIN notes n ON n.user_id = u.id WHERE n.id = $1',
    [noteId]
  );
  return result.rows[0].encrypted_profile?.iv ?? null;
}

describe('reference reconciliation', () => {
  it('records references for notes saved before tracking and enables GC', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const note = await createEncryptedNote(agent, account, 'x', { blobIds: [blob.id] });
    await t.pool.query('UPDATE notes SET blob_refs_known = FALSE WHERE id = $1', [note.id]);
    await t.pool.query('DELETE FROM blob_refs WHERE note_id = $1', [note.id]);
    await t.pool.query('UPDATE users SET profile_ref_known = FALSE WHERE id = (SELECT user_id FROM notes WHERE id = $1)', [note.id]);

    const stale = await agent.post('/api/blobs/refs/reconcile').send({
      notes: [{ id: note.id, revision: note.revision + 5, blobIds: [blob.id] }],
    });
    expect(stale.body.notesSkipped).toEqual([note.id]);
    expect(stale.body.gc.enabled).toBe(false);

    const unknown = await agent.get('/api/blobs/refs/unknown');
    expect(unknown.body.notes).toEqual([{ id: note.id, revision: note.revision }]);
    expect(unknown.body.profileRefKnown).toBe(false);

    const res = await agent.post('/api/blobs/refs/reconcile').send({
      notes: [{ id: note.id, revision: note.revision, blobIds: [blob.id] }],
      profile: { blobId: null, profileIv: await profileIv(note.id) },
    });
    expect(res.body.notesUpdated).toBe(1);
    expect((await agent.get('/api/blobs/refs/unknown')).body).toEqual({ notes: [], revisions: [], profileRefKnown: true });
    expect(res.body.gc.enabled).toBe(true);
    const refs = await t.pool.query('SELECT blob_id FROM blob_refs WHERE note_id = $1', [note.id]);
    expect(refs.rows.map((row) => row.blob_id)).toEqual([blob.id]);
  });
});

describe('profile picture reference reconciliation', () => {
  async function profileRow(userId) {
    return (await t.pool.query('SELECT profile_blob_id, profile_ref_known, encrypted_profile FROM users WHERE id = $1', [userId]))
      .rows[0];
  }

  it('fills in an unknown reference only from the profile version the client decrypted', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const picture = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const encryptedProfile = account.signupBody('x@example.com').encryptedProfile;
    // An older client saved a profile without telling the server the picture.
    expect((await agent.put('/api/users/profile').send({ encryptedProfile })).status).toBe(200);
    expect((await profileRow(user.id)).profile_ref_known).toBe(false);

    // A client that decrypted an earlier profile version cannot decide it.
    await agent.post('/api/blobs/refs/reconcile').send({ profile: { blobId: null, profileIv: 'AAAAAAAAAAAAAAAA' } });
    expect(await profileRow(user.id)).toMatchObject({ profile_blob_id: null, profile_ref_known: false });

    await agent.post('/api/blobs/refs/reconcile').send({ profile: { blobId: picture.id, profileIv: encryptedProfile.iv } });
    expect(await profileRow(user.id)).toMatchObject({ profile_blob_id: picture.id, profile_ref_known: true });
  });

  it('never replaces a reference the server already knows', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const picture = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const encryptedProfile = account.signupBody('x@example.com').encryptedProfile;
    await agent.put('/api/users/profile').send({ encryptedProfile, profileBlobId: picture.id });

    await agent.post('/api/blobs/refs/reconcile').send({ profile: { blobId: null, profileIv: encryptedProfile.iv } });
    expect(await profileRow(user.id)).toMatchObject({ profile_blob_id: picture.id, profile_ref_known: true });
  });
});

describe('permanent deletion cascades server-side', () => {
  it('removes references and lets the collector reclaim the blob later', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const note = await createEncryptedNote(agent, account, 'doomed', { blobIds: [blob.id] });
    await agent.put(`/api/notes/${note.id}/trash`);
    await agent.delete(`/api/notes/${note.id}`);
    expect((await t.pool.query('SELECT 1 FROM blob_refs WHERE note_id = $1', [note.id])).rows).toHaveLength(0);
    expect((await t.pool.query('SELECT 1 FROM note_revisions WHERE note_id = $1', [note.id])).rows).toHaveLength(0);
    expect(await blobRow(blob.id)).toBeDefined();
  });
});

describe('unauthenticated access', () => {
  it('requires a session for every blob endpoint', async () => {
    expect((await request(t.app).get('/api/blobs/1')).status).toBe(401);
    expect((await request(t.app).post('/api/blobs').send(Buffer.from('x'))).status).toBe(401);
  });
});
