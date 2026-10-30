import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyStorage } from '../lib/verifyStorage.js';
import { createTestApp, signupUser, uploadBlob } from './helpers/app.js';

let t;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe('OPS-2: verify-storage', () => {
  it('reports consistency, missing files, orphans and repairs from the deleted-files area', async () => {
    const { agent, account } = await signupUser(t.app);
    const blob = (await uploadBlob(agent, crypto.randomBytes(40), { keyId: account.keyId })).body.blob;
    const key = (await t.pool.query('SELECT storage_key FROM blobs WHERE id = $1', [blob.id])).rows[0].storage_key;

    let report = await verifyStorage({ pool: t.pool, storage: t.ctx.storage });
    expect(report.problems).toBe(0);

    // A garbage collector moved the file aside after the dump this database
    // was restored from was taken: verify finds it, repair brings it back.
    await t.ctx.storage.moveToDeleted(key);
    report = await verifyStorage({ pool: t.pool, storage: t.ctx.storage });
    expect(report.missing.map((item) => item.id)).toEqual([blob.id]);
    report = await verifyStorage({ pool: t.pool, storage: t.ctx.storage, repair: true });
    expect(report.restored).toEqual([blob.id]);
    expect((await verifyStorage({ pool: t.pool, storage: t.ctx.storage })).problems).toBe(0);

    await fsp.writeFile(path.join(t.config.storage.blobsDir, 'u999-orphan.bin'), 'x');
    report = await verifyStorage({ pool: t.pool, storage: t.ctx.storage });
    expect(report.orphans.map((item) => item.key)).toContain('u999-orphan.bin');
    expect(report.problems).toBe(0);

    await fsp.writeFile(t.ctx.storage.resolve(key), 'truncated');
    report = await verifyStorage({ pool: t.pool, storage: t.ctx.storage });
    expect(report.sizeMismatch.map((item) => item.id)).toEqual([blob.id]);
  });
});

describe('blob storage keys', () => {
  it('refuses keys that could escape the storage directory', () => {
    for (const bad of ['../x.bin', '..\\x.bin', '/etc/passwd', 'a/b.bin', '', '.hidden']) {
      expect(() => t.ctx.storage.resolve(bad)).toThrow();
    }
    expect(t.ctx.storage.resolve('u1-abc.bin')).toBe(path.join(t.config.storage.blobsDir, 'u1-abc.bin'));
  });
});
