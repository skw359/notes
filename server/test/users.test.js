import crypto from 'crypto';
import fsp from 'fs/promises';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEncryptedNote,
  createTestApp,
  insertLegacyUser,
  signupUser,
  uploadBlob,
} from './helpers/app.js';
import { randomVerifier } from './helpers/e2ee.js';

let t;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe('SEC-6: account deletion', () => {
  it('requires the current password and a typed confirmation', async () => {
    const { agent, account, user } = await signupUser(t.app);

    expect((await agent.delete('/api/users/account')).status).toBe(400);
    expect((await agent.delete('/api/users/account').send({ confirm: 'DELETE' })).status).toBe(401);
    expect(
      (await agent.delete('/api/users/account').send({ confirm: 'yes', currentAuthSecret: account.authSecret })).status
    ).toBe(400);
    expect(
      (await agent.delete('/api/users/account').send({ confirm: 'DELETE', currentAuthSecret: randomVerifier() })).status
    ).toBe(401);

    expect((await t.pool.query('SELECT 1 FROM users WHERE id = $1', [user.id])).rows).toHaveLength(1);
  });

  it('deletes rows transactionally, then moves files aside, and ends the session', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(50), { keyId: account.keyId })).body.blob;
    await createEncryptedNote(agent, account, 'gone soon', { blobIds: [blob.id] });
    const storageKey = (await t.pool.query('SELECT storage_key FROM blobs WHERE id = $1', [blob.id])).rows[0].storage_key;

    const res = await agent.delete('/api/users/account').send({ confirm: 'DELETE', currentAuthSecret: account.authSecret });
    expect(res.status).toBe(200);

    for (const table of ['users', 'notes', 'blobs', 'sessions', 'note_revisions']) {
      const column = table === 'users' ? 'id' : 'user_id';
      const rows = await t.pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [user.id]);
      expect(rows.rows, table).toHaveLength(0);
    }
    const blobsDir = await fsp.readdir(t.config.storage.blobsDir);
    expect(blobsDir).not.toContain(storageKey);
    const deletedDir = await fsp.readdir(t.config.storage.deletedBlobsDir);
    expect(deletedDir.some((name) => name.endsWith(storageKey))).toBe(true);

    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it("never touches another account's files (SEC-1 deletion path)", async () => {
    const victim = await insertLegacyUser(t.pool);
    const attacker = await insertLegacyUser(t.pool);
    const victimFile = `${victim.user.id}-1700000000000.jpg`;
    await fsp.mkdir(t.config.storage.legacyUploadsDir, { recursive: true });
    await fsp.writeFile(`${t.config.storage.legacyUploadsDir}/${victimFile}`, 'VICTIM PRIVATE PHOTO BYTES');
    await t.pool.query("INSERT INTO legacy_uploads (filename, user_id, source) VALUES ($1, $2, 'prefix:profile')", [
      victimFile,
      victim.user.id,
    ]);
    // The attacker references the victim's file from their own note.
    await t.pool.query('INSERT INTO notes (user_id, content, revision, blob_refs_known) VALUES ($1, $2, 1, TRUE)', [
      attacker.user.id,
      JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src: `/api/uploads/${victimFile}` } }] }),
    ]);

    const agent = request.agent(t.app);
    await agent.post('/api/auth/login').send({ email: attacker.email, password: attacker.password });
    const res = await agent.delete('/api/users/account').send({ confirm: 'DELETE', password: attacker.password });
    expect(res.status).toBe(200);

    const content = await fsp.readFile(`${t.config.storage.legacyUploadsDir}/${victimFile}`, 'utf8');
    expect(content).toBe('VICTIM PRIVATE PHOTO BYTES');
  });
});

describe('profile updates', () => {
  it('stores an encrypted profile and its picture reference', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(20), { keyId: account.keyId })).body.blob;
    const encryptedProfile = account.signupBody('x@example.com').encryptedProfile;
    const res = await agent.put('/api/users/profile').send({ encryptedProfile, profileBlobId: blob.id });
    expect(res.status).toBe(200);
    const row = (await t.pool.query('SELECT profile_blob_id, profile_ref_known FROM users WHERE id = $1', [user.id])).rows[0];
    expect(row).toEqual({ profile_blob_id: blob.id, profile_ref_known: true });
  });

  it('rejects malformed encrypted profiles and multipart uploads', async () => {
    const { agent } = await signupUser(t.app);
    expect((await agent.put('/api/users/profile').send({ encryptedProfile: { version: 2 } })).status).toBe(400);
    const multipart = await agent.put('/api/users/profile').attach('profile_picture', Buffer.from('jpg'), 'x.jpg');
    expect(multipart.status).toBe(400);
    const leftovers = await fsp.readdir(t.config.storage.legacyUploadsDir).catch(() => []);
    expect(leftovers.filter((name) => name.endsWith('x.jpg'))).toHaveLength(0);
  });

  it('updates legacy names with JSON only', async () => {
    const legacy = await insertLegacyUser(t.pool);
    const agent = request.agent(t.app);
    await agent.post('/api/auth/login').send({ email: legacy.email, password: legacy.password });
    const res = await agent.put('/api/users/profile').send({ first_name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.user.first_name).toBe('New');
  });
});
