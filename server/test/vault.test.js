import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEncryptedNote,
  createTestApp,
  loginAgent,
  saveEncrypted,
  signupUser,
  uploadBlob,
} from './helpers/app.js';
import { docWithText, encryptBytes, encryptJson, keyFingerprint, makeAccount, TEST_KDF_PARAMS } from './helpers/e2ee.js';

let t;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

function rotationBody(oldAccount, newAccount) {
  return {
    currentAuthSecret: oldAccount.authSecret,
    newKeyId: newAccount.keyId,
    authSalt: newAccount.salt,
    kdfParams: TEST_KDF_PARAMS,
    authVerifier: newAccount.authSecret,
    wrappedVaultKey: encryptBytes(newAccount.kek, newAccount.vaultKey, { context: 'vault-key:password', keyId: newAccount.keyId }),
    recoveryVerifier: newAccount.recoveryVerifier,
    wrappedVaultKeyRecovery: encryptBytes(newAccount.recoveryWrappingKey, newAccount.vaultKey, {
      context: 'vault-key:recovery',
      keyId: newAccount.keyId,
    }),
    keyring: {
      [oldAccount.keyId]: encryptBytes(newAccount.vaultKey, oldAccount.vaultKey, {
        context: `vault-keyring:${oldAccount.keyId}`,
        keyId: newAccount.keyId,
      }),
    },
  };
}

describe('key ids', () => {
  it('registers the fingerprint once and refuses a different one', async () => {
    const { agent, account, user } = await signupUser(t.app);
    await t.pool.query('UPDATE users SET vault_key_id = NULL WHERE id = $1', [user.id]);
    expect((await agent.post('/api/vault/key-id').send({ keyId: account.keyId })).status).toBe(200);
    expect((await agent.post('/api/vault/key-id').send({ keyId: account.keyId })).status).toBe(200);
    const other = await agent.post('/api/vault/key-id').send({ keyId: keyFingerprint(crypto.randomBytes(32)) });
    expect(other.status).toBe(409);
  });
});

describe('CRYPTO-1: vault key rotation', () => {
  it('switches keys atomically, keeps old data readable, and completes only after re-encryption', async () => {
    const { agent, account, email, user } = await signupUser(t.app);
    const otherDevice = await loginAgent(t.app, email, account);
    const note = await createEncryptedNote(agent, account, 'before rotation');
    const blob = (await uploadBlob(agent, crypto.randomBytes(30), { keyId: account.keyId })).body.blob;
    await saveEncrypted(agent, account, note, 'with image', { blobIds: [blob.id] });

    const next = makeAccount();
    const start = await agent.post('/api/vault/rotation/start').send(rotationBody(account, next));
    expect(start.status).toBe(200);
    expect(start.body.vaultBootstrap.vaultKeyId).toBe(next.keyId);
    expect(Object.keys(start.body.vaultBootstrap.keyring)).toEqual([account.keyId]);
    // Devices holding the old key are signed out.
    expect((await otherDevice.get('/api/notes')).status).toBe(401);

    // Writing with the retired key is refused (and kept as a conflict).
    const current = (await agent.get(`/api/notes/${note.id}`)).body.note;
    const stale = await saveEncrypted(agent, account, current, 'old key write');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('KEY_ROTATED');

    let status = (await agent.get('/api/vault/status')).body;
    expect(status.complete).toBe(false);
    expect(status.pending.notes).toBe(1);
    expect(status.pending.blobs).toBe(1);
    expect((await agent.post('/api/vault/rotation/complete')).status).toBe(409);

    // Re-encrypt everything under the new key: blob copy, note, revisions, profile.
    const newBlob = await agent
      .post('/api/blobs')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Blob-Version', '3')
      .set('X-Blob-Key-Id', next.keyId)
      .set('X-Blob-Replaces', String(blob.id))
      .send(crypto.randomBytes(30));
    expect(newBlob.status).toBe(201);
    const saved = await agent.put(`/api/notes/${note.id}`).send({
      baseRevision: current.revision,
      encryptedContent: next.noteContent(note.id, docWithText('with image'), current.revision + 1),
      encryptedSummary: next.noteSummary(note.id, { title: 'with image', preview: '' }),
      blobIds: [newBlob.body.blob.id],
      reason: 'reencrypt',
    });
    expect(saved.status).toBe(200);

    const pendingRevisions = (await agent.get('/api/vault/pending').query({ type: 'revisions' })).body.items;
    for (const rev of pendingRevisions) {
      const res = await agent.put(`/api/notes/${rev.note_id}/revisions/${rev.id}`).send({
        encryptedContent: next.noteContent(rev.note_id, docWithText('history')),
        encryptedSummary: next.noteSummary(rev.note_id, { title: 'history', preview: '' }),
        blobIds: [newBlob.body.blob.id],
      });
      expect(res.status).toBe(200);
    }
    const profile = await agent.put('/api/users/profile').send({
      encryptedProfile: encryptJson(next.vaultKey, { first_name: 'T' }, { context: 'profile', keyId: next.keyId }),
      profileBlobId: null,
    });
    expect(profile.status).toBe(200);

    status = (await agent.get('/api/vault/status')).body;
    expect(status.pending).toMatchObject({ notes: 0, revisions: 0, blobs: 0, profile: false });
    expect(status.complete).toBe(true);

    const done = await agent.post('/api/vault/rotation/complete');
    expect(done.status).toBe(200);
    expect(done.body.vaultBootstrap.keyring).toEqual({});
    expect(done.body.vaultBootstrap.minEnvelopeVersion).toBe(3);
    const row = (await t.pool.query('SELECT min_envelope_version, rotation_started_at FROM users WHERE id = $1', [user.id])).rows[0];
    expect(row).toEqual({ min_envelope_version: 3, rotation_started_at: null });
  });

  it('requires the current password and the old key in the keyring', async () => {
    const { agent, account } = await signupUser(t.app);
    const next = makeAccount();
    const wrongPassword = await agent
      .post('/api/vault/rotation/start')
      .send({ ...rotationBody(account, next), currentAuthSecret: makeAccount().authSecret });
    expect(wrongPassword.status).toBe(401);
    const noKeyring = await agent.post('/api/vault/rotation/start').send({ ...rotationBody(account, next), keyring: {} });
    expect(noKeyring.status).toBe(400);
  });
});

describe('CRYPTO-5: envelope version floor', () => {
  it('refuses unauthenticated-context (v2) writes once the account requires v3', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'v3 only');
    await t.pool.query('UPDATE users SET min_envelope_version = 3 WHERE id = $1', [user.id]);
    const res = await agent.put(`/api/notes/${note.id}`).send({
      baseRevision: note.revision,
      encryptedContent: encryptJson(account.vaultKey, docWithText('downgrade'), {
        context: `note-content:${note.id}`,
        version: 2,
      }),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLIENT_OUTDATED');
  });

  it('counts v1/v2 records as pending in the upgrade status', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'x');
    await t.pool.query('UPDATE notes SET encrypted_content = $2 WHERE id = $1', [
      note.id,
      JSON.stringify(encryptJson(account.vaultKey, docWithText('x'), { context: `note-content:${note.id}`, version: 2 })),
    ]);
    const status = (await agent.get('/api/vault/status')).body;
    expect(status.pending.notes).toBe(1);
    void user;
  });
});
