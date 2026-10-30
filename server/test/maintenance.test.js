import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../services/maintenance.js';
import { createEncryptedNote, createTestApp, signupUser, uploadBlob } from './helpers/app.js';

let t;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

const run = () => runMaintenance({ pool: t.pool, storage: t.ctx.storage, config: t.config, log: { error() {} } });

describe('scheduled maintenance (PERF-1, DATA-9, DATA-4, SEC-7)', () => {
  it('purges only trash older than the retention period and records tombstones', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const old = await createEncryptedNote(agent, account, 'old trash');
    const recent = await createEncryptedNote(agent, account, 'recent trash');
    const active = await createEncryptedNote(agent, account, 'active');
    await agent.put(`/api/notes/${old.id}/trash`);
    await agent.put(`/api/notes/${recent.id}/trash`);
    await t.pool.query("UPDATE notes SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = $1", [old.id]);

    const result = await run();
    expect(result.purgedTrash).toBeGreaterThanOrEqual(1);
    const remaining = (await t.pool.query('SELECT id FROM notes WHERE user_id = $1', [user.id])).rows.map((r) => r.id);
    expect(remaining.sort()).toEqual([recent.id, active.id].sort());
    expect((await t.pool.query('SELECT 1 FROM deleted_notes WHERE note_id = $1', [old.id])).rows).toHaveLength(1);
  });

  it('removes abandoned pending notes but keeps ones holding a conflict', async () => {
    const { agent, account } = await signupUser(t.app);
    const abandoned = (await agent.post('/api/notes').send({})).body.note;
    const withConflict = (await agent.post('/api/notes').send({})).body.note;
    await t.pool.query(
      `INSERT INTO note_revisions (note_id, user_id, kind, reason, revision, encrypted_content)
       SELECT id, user_id, 'conflict', 'test', 0, $2 FROM notes WHERE id = $1`,
      [withConflict.id, JSON.stringify(account.noteContent(withConflict.id, { type: 'doc' }, 1))]
    );
    await t.pool.query("UPDATE notes SET created_at = NOW() - INTERVAL '2 days' WHERE id = ANY($1::int[])", [
      [abandoned.id, withConflict.id],
    ]);

    await run();
    expect((await t.pool.query('SELECT 1 FROM notes WHERE id = $1', [abandoned.id])).rows).toHaveLength(0);
    expect((await t.pool.query('SELECT 1 FROM notes WHERE id = $1', [withConflict.id])).rows).toHaveLength(1);
  });

  it('sweeps deleted blob files after their retention period', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(10), { keyId: account.keyId })).body.blob;
    const key = (await t.pool.query('SELECT storage_key FROM blobs WHERE id = $1', [blob.id])).rows[0].storage_key;
    await t.ctx.storage.moveToDeleted(key);
    const deletedDir = t.config.storage.deletedBlobsDir;
    const [entry] = (await fsp.readdir(deletedDir)).filter((name) => name.endsWith(key));
    const backdated = `${Date.now() - 8 * 24 * 60 * 60 * 1000}-${key}`;
    await fsp.rename(path.join(deletedDir, entry), path.join(deletedDir, backdated));

    const result = await run();
    expect(result.sweptDeletedFiles).toBeGreaterThanOrEqual(1);
    expect(await fsp.readdir(deletedDir)).not.toContain(backdated);
  });

  it('removes long-expired sessions', async () => {
    const { user } = await signupUser(t.app);
    await t.pool.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '40 days' WHERE user_id = $1", [user.id]);
    await run();
    expect((await t.pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id])).rows).toHaveLength(0);
  });

  it('skips when another run holds the lock', async () => {
    const holder = await t.pool.connect();
    await holder.query('SELECT pg_advisory_lock(7303, 0)');
    try {
      expect(await run()).toEqual({ skipped: true });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(7303, 0)');
      holder.release();
    }
  });
});
