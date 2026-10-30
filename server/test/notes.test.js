import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEncryptedNote,
  createTestApp,
  loginAgent,
  saveEncrypted,
  signupUser,
} from './helpers/app.js';
import { decryptJson, docWithText, encryptJson } from './helpers/e2ee.js';

let t;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

async function dbNote(id) {
  const result = await t.pool.query('SELECT * FROM notes WHERE id = $1', [id]);
  return result.rows[0];
}

describe('DATA-1: encrypted content can never be erased by a save', () => {
  it('rejects a PUT without encryptedContent and keeps the ciphertext', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'precious');
    const before = await dbNote(note.id);

    const summaryOnly = await agent
      .put(`/api/notes/${note.id}`)
      .send({ baseRevision: 1, encryptedSummary: account.noteSummary(note.id, { title: 'x', preview: '' }) });
    expect(summaryOnly.status).toBe(400);

    const empty = await agent.put(`/api/notes/${note.id}`).send({});
    expect(empty.status).toBe(400);

    const after = await dbNote(note.id);
    expect(after.encrypted_content).toEqual(before.encrypted_content);
    expect(decryptJson(account.vaultKey, after.encrypted_content)).toEqual(docWithText('precious'));
  });

  it('rejects plaintext from a stale legacy-mode tab with CLIENT_OUTDATED', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'secret');

    const res = await agent.put(`/api/notes/${note.id}`).send({ content: docWithText('leaked plaintext') });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLIENT_OUTDATED');

    const row = await dbNote(note.id);
    expect(row.content).toBeNull();
    expect(row.encrypted_content).not.toBeNull();
    const created = await agent.post('/api/notes').send({ content: docWithText('plain') });
    expect(created.status).toBe(409);
  });

  it('validates envelope shape, algorithm, context binding and IV length', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'v');
    const good = account.noteContent(note.id, docWithText('next'), 2);

    const cases = [
      { ...good, context: `note-content:${note.id + 1}` },
      { ...good, algorithm: 'AES-128-CBC' },
      { ...good, iv: 'AAAA' },
      { ...good, version: 1 },
      { ...good, ciphertext: 'not base64!!' },
      { ...good, extra: true },
      'just a string',
    ];
    for (const encryptedContent of cases) {
      const res = await agent.put(`/api/notes/${note.id}`).send({ baseRevision: 1, encryptedContent });
      expect(res.status, JSON.stringify(encryptedContent).slice(0, 80)).toBe(400);
    }
    // Revision binding must match baseRevision + 1.
    const wrongRevision = await agent
      .put(`/api/notes/${note.id}`)
      .send({ baseRevision: 1, encryptedContent: account.noteContent(note.id, docWithText('x'), 5) });
    expect(wrongRevision.status).toBe(400);
    expect((await dbNote(note.id)).revision).toBe(1);
  });

  it('the database guard refuses plaintext and NULL-over-ciphertext even from direct SQL', async () => {
    const { agent, account, user } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'guarded');

    await expect(
      t.pool.query('UPDATE notes SET encrypted_content = NULL WHERE id = $1', [note.id])
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.pool.query(`UPDATE notes SET content = '{"type":"doc"}' WHERE id = $1`, [note.id])
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.pool.query(`INSERT INTO notes (user_id, content) VALUES ($1, '{"type":"doc"}')`, [user.id])
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('DATA-3: optimistic concurrency', () => {
  it('rejects a stale save, keeps the newer version and stores the rejected edit as a conflict', async () => {
    const { agent: laptop, account, email } = await signupUser(t.app);
    const phone = await loginAgent(t.app, email, account);
    const note = await createEncryptedNote(laptop, account, 'Shopping list');

    const phoneSave = await saveEncrypted(phone, account, note, 'Shopping list - milk, eggs, IMPORTANT EDIT FROM PHONE');
    expect(phoneSave.status).toBe(200);
    expect(phoneSave.body.note.revision).toBe(2);

    // The laptop still believes revision 1 is current.
    const laptopSave = await saveEncrypted(laptop, account, note, 'Shopping list!');
    expect(laptopSave.status).toBe(409);
    expect(laptopSave.body.code).toBe('REVISION_CONFLICT');
    expect(laptopSave.body.note.revision).toBe(2);
    expect(decryptJson(account.vaultKey, laptopSave.body.note.encrypted_content)).toEqual(
      docWithText('Shopping list - milk, eggs, IMPORTANT EDIT FROM PHONE')
    );

    const row = await dbNote(note.id);
    expect(decryptJson(account.vaultKey, row.encrypted_content)).toEqual(
      docWithText('Shopping list - milk, eggs, IMPORTANT EDIT FROM PHONE')
    );

    // Nothing was lost: the laptop's edit is kept as a conflict revision.
    const revisions = await laptop.get(`/api/notes/${note.id}/revisions`);
    const conflict = revisions.body.revisions.find((rev) => rev.kind === 'conflict');
    expect(conflict).toBeDefined();
    const stored = await laptop.get(`/api/notes/${note.id}/revisions/${conflict.id}`);
    expect(decryptJson(account.vaultKey, stored.body.revision.encrypted_content)).toEqual(
      docWithText('Shopping list!')
    );

    const list = await laptop.get('/api/notes');
    expect(list.body.notes.find((n) => n.id === note.id).has_conflict).toBe(true);

    // Resolving keeps it as history but clears the flag.
    const resolved = await laptop.post(`/api/notes/${note.id}/revisions/${conflict.id}/resolve`);
    expect(resolved.status).toBe(200);
    const afterResolve = await laptop.get('/api/notes');
    expect(afterResolve.body.notes.find((n) => n.id === note.id).has_conflict).toBe(false);
  });

  it('keeps writes from pre-upgrade clients (no baseRevision) as conflicts instead of applying them', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'current');

    // Pre-upgrade clients send v2 envelopes and no baseRevision.
    const v2 = (text) => encryptJson(account.vaultKey, docWithText(text), { context: `note-content:${note.id}`, version: 2 });
    const res = await agent.put(`/api/notes/${note.id}`).send({ encryptedContent: v2('old tab') });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLIENT_OUTDATED');
    expect(decryptJson(account.vaultKey, (await dbNote(note.id)).encrypted_content)).toEqual(docWithText('current'));

    // Repeated retries from the same session coalesce into one conflict row.
    await agent.put(`/api/notes/${note.id}`).send({ encryptedContent: v2('old tab 2') });
    const conflicts = await t.pool.query(
      "SELECT * FROM note_revisions WHERE note_id = $1 AND kind = 'conflict'",
      [note.id]
    );
    expect(conflicts.rows).toHaveLength(1);
    expect(decryptJson(account.vaultKey, conflicts.rows[0].encrypted_content)).toEqual(docWithText('old tab 2'));
  });

  it('accepts the first save of a freshly created note from a pre-upgrade client', async () => {
    const { agent, account } = await signupUser(t.app);
    const created = await agent.post('/api/notes').send({});
    expect(created.body.note.revision).toBe(0);
    const id = created.body.note.id;
    const res = await agent.put(`/api/notes/${id}`).send({
      encryptedContent: encryptJson(account.vaultKey, docWithText('first'), { context: `note-content:${id}`, version: 2 }),
      encryptedSummary: encryptJson(account.vaultKey, { title: 'first' }, { context: `note-summary:${id}`, version: 2 }),
    });
    expect(res.status).toBe(200);
    expect(res.body.note.revision).toBe(1);
  });

  it('refuses to save into a note trashed elsewhere, and keeps the edit', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'will be trashed');
    expect((await agent.put(`/api/notes/${note.id}/trash`)).status).toBe(200);

    const res = await saveEncrypted(agent, account, note, 'edit after trash');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTE_TRASHED');
    const conflicts = await t.pool.query("SELECT 1 FROM note_revisions WHERE note_id = $1 AND kind = 'conflict'", [note.id]);
    expect(conflicts.rows).toHaveLength(1);
  });

  it('reports a permanently deleted note distinctly', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'bye');
    await agent.put(`/api/notes/${note.id}/trash`);
    expect((await agent.delete(`/api/notes/${note.id}`)).status).toBe(200);
    const res = await saveEncrypted(agent, account, note, 'too late');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOTE_DELETED');
  });
});

describe('note history', () => {
  it('snapshots the previous version when another device writes and on restore', async () => {
    const { agent, account, email } = await signupUser(t.app);
    const other = await loginAgent(t.app, email, account);
    const note = await createEncryptedNote(agent, account, 'v1');

    let res = await saveEncrypted(agent, account, note, 'v2');
    // First edit after creation snapshots v1 (no snapshot existed yet).
    res = await saveEncrypted(other, account, res.body.note, 'v3 from other device');
    expect(res.status).toBe(200);
    res = await saveEncrypted(agent, account, res.body.note, 'v4 restored', { reason: 'restore' });
    expect(res.status).toBe(200);

    const revisions = (await agent.get(`/api/notes/${note.id}/revisions`)).body.revisions;
    const snapshots = revisions.filter((rev) => rev.kind === 'snapshot');
    const texts = [];
    for (const snapshot of snapshots) {
      const full = await agent.get(`/api/notes/${note.id}/revisions/${snapshot.id}`);
      texts.push(decryptJson(account.vaultKey, full.body.revision.encrypted_content).content[0].content[0].text);
    }
    expect(texts).toEqual(expect.arrayContaining(['v1', 'v2', 'v3 from other device']));
  });

  it('bounds the number of snapshots per note', async () => {
    const { agent, account } = await signupUser(t.app);
    let note = await createEncryptedNote(agent, account, 'start');
    for (let i = 0; i < t.config.limits.maxRevisionsPerNote + 5; i += 1) {
      const res = await saveEncrypted(agent, account, note, `step ${i}`, { reason: 'restore' });
      note = res.body.note;
    }
    const count = await t.pool.query("SELECT COUNT(*)::int AS c FROM note_revisions WHERE note_id = $1 AND kind = 'snapshot'", [note.id]);
    expect(count.rows[0].c).toBe(t.config.limits.maxRevisionsPerNote);
  });

  it('re-encryption saves keep the note position and take no snapshot', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'same text');
    const before = await dbNote(note.id);
    const res = await saveEncrypted(agent, account, note, 'same text', { reason: 'reencrypt' });
    expect(res.status).toBe(200);
    const after = await dbNote(note.id);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    const snapshots = await t.pool.query('SELECT 1 FROM note_revisions WHERE note_id = $1', [note.id]);
    expect(snapshots.rows).toHaveLength(0);
  });
});

describe('listing, sync, batch and pagination (PERF-3)', () => {
  it('lists summaries without ciphertext bodies or plaintext', async () => {
    const { agent, account } = await signupUser(t.app);
    await createEncryptedNote(agent, account, 'one');
    const res = await agent.get('/api/notes');
    expect(res.status).toBe(200);
    expect(res.body.notes[0]).not.toHaveProperty('encrypted_content');
    expect(res.body.notes[0]).not.toHaveProperty('content');
    expect(typeof res.body.seq).toBe('number');
  });

  it('hides pending (never saved) notes from lists', async () => {
    const { agent } = await signupUser(t.app);
    await agent.post('/api/notes').send({});
    expect((await agent.get('/api/notes')).body.notes).toHaveLength(0);
  });

  it('paginates with a stable cursor', async () => {
    const { agent, account } = await signupUser(t.app);
    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push((await createEncryptedNote(agent, account, `n${i}`)).id);
    }
    const seen = [];
    let cursor;
    do {
      const res = await agent.get('/api/notes').query({ limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...res.body.notes.map((n) => n.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('delta sync reports edits, trash moves and permanent deletions', async () => {
    const { agent, account } = await signupUser(t.app);
    const a = await createEncryptedNote(agent, account, 'a');
    const b = await createEncryptedNote(agent, account, 'b');
    const c = await createEncryptedNote(agent, account, 'c');
    const { seq } = (await agent.get('/api/notes')).body;

    await saveEncrypted(agent, account, a, 'a2');
    await agent.put(`/api/notes/${b.id}/trash`);
    await agent.put(`/api/notes/${c.id}/trash`);
    await agent.delete(`/api/notes/${c.id}`);

    const sync = await agent.get('/api/notes/sync').query({ since: seq });
    expect(sync.status).toBe(200);
    const byId = Object.fromEntries(sync.body.notes.map((n) => [n.id, n]));
    expect(byId[a.id].revision).toBe(2);
    expect(byId[b.id].deleted_at).not.toBeNull();
    expect(sync.body.deleted).toContain(c.id);
    expect(sync.body.seq).toBeGreaterThan(seq);

    const again = await agent.get('/api/notes/sync').query({ since: sync.body.seq });
    expect(again.body.notes).toHaveLength(0);
    expect(again.body.deleted).toHaveLength(0);
  });

  it('fetches many bodies in one batch request', async () => {
    const { agent, account } = await signupUser(t.app);
    const notes = [];
    for (let i = 0; i < 5; i += 1) {
      notes.push(await createEncryptedNote(agent, account, `body ${i}`));
    }
    const res = await agent.post('/api/notes/batch').send({ ids: [...notes.map((n) => n.id), 999999] });
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(5);
    expect(res.body.missing).toEqual([999999]);
    expect(decryptJson(account.vaultKey, res.body.notes[0].encrypted_content).type).toBe('doc');
  });

  it('GET /trash does not purge anything', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'old trash');
    await agent.put(`/api/notes/${note.id}/trash`);
    await t.pool.query("UPDATE notes SET deleted_at = NOW() - INTERVAL '60 days' WHERE id = $1", [note.id]);
    const res = await agent.get('/api/notes/trash');
    expect(res.body.notes.map((n) => n.id)).toContain(note.id);
    expect(await dbNote(note.id)).toBeDefined();
  });

  it('requires a note to be trashed before permanent deletion', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'active');
    const res = await agent.delete(`/api/notes/${note.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTE_NOT_TRASHED');
    expect(await dbNote(note.id)).toBeDefined();
  });
});

describe('tenant isolation', () => {
  it('returns 404 for every note endpoint used against another account', async () => {
    const owner = await signupUser(t.app);
    const note = await createEncryptedNote(owner.agent, owner.account, 'private');
    const intruder = await signupUser(t.app);

    const attempts = [
      intruder.agent.get(`/api/notes/${note.id}`),
      saveEncrypted(intruder.agent, intruder.account, note, 'overwrite'),
      intruder.agent.patch(`/api/notes/${note.id}/summary`).send({
        encryptedSummary: intruder.account.noteSummary(note.id, { title: 'x', preview: '' }),
      }),
      intruder.agent.put(`/api/notes/${note.id}/trash`),
      intruder.agent.put(`/api/notes/${note.id}/restore`),
      intruder.agent.delete(`/api/notes/${note.id}`),
      intruder.agent.get(`/api/notes/${note.id}/revisions`),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(404);
    }
    const batch = await intruder.agent.post('/api/notes/batch').send({ ids: [note.id] });
    expect(batch.body.notes).toHaveLength(0);

    const row = await dbNote(note.id);
    expect(decryptJson(owner.account.vaultKey, row.encrypted_content)).toEqual(docWithText('private'));
    expect(row.deleted_at).toBeNull();
  });
});

describe('SEC-10: input validation returns 4xx, not 500', () => {
  it('rejects non-numeric ids and bad bodies', async () => {
    const { agent } = await signupUser(t.app);
    expect((await agent.get('/api/notes/abc')).status).toBe(400);
    expect((await agent.get('/api/notes/sync')).status).toBe(400);
    expect((await agent.post('/api/notes/batch').send({ ids: 'nope' })).status).toBe(400);
    expect((await agent.put('/api/notes/1').send({ baseRevision: 'x' })).status).toBe(400);
    expect((await agent.get('/api/notes/99999999999')).status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(t.app).get('/api/notes');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });
});

describe('summary repair (DATA-8)', () => {
  it('replaces a summary only on the revision it was derived from, without a new revision', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'body');

    const stale = await agent.patch(`/api/notes/${note.id}/summary`).send({
      encryptedSummary: account.noteSummary(note.id, { title: 'from an older body', preview: '' }),
      revision: note.revision - 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('SUMMARY_STALE');
    expect(decryptJson(account.vaultKey, (await dbNote(note.id)).encrypted_summary)).toEqual({ title: 'body', preview: '' });

    const repaired = await agent.patch(`/api/notes/${note.id}/summary`).send({
      encryptedSummary: account.noteSummary(note.id, { title: 'repaired', preview: '' }),
      revision: note.revision,
    });
    expect(repaired.status).toBe(200);
    const row = await dbNote(note.id);
    expect(row.revision).toBe(note.revision);
    expect(decryptJson(account.vaultKey, row.encrypted_summary)).toEqual({ title: 'repaired', preview: '' });
  });
});

describe('re-encryption reaches notes in the trash', () => {
  it('accepts a reencrypt save on a trashed note and keeps it trashed; edits stay refused', async () => {
    const { agent, account } = await signupUser(t.app);
    const note = await createEncryptedNote(agent, account, 'binned');
    await agent.put(`/api/notes/${note.id}/trash`);
    const trashedAt = (await dbNote(note.id)).deleted_at;

    const edit = await agent.put(`/api/notes/${note.id}`).send({
      baseRevision: note.revision,
      encryptedContent: account.noteContent(note.id, docWithText('edited'), note.revision + 1),
    });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('NOTE_TRASHED');

    const reencrypted = await agent.put(`/api/notes/${note.id}`).send({
      baseRevision: note.revision,
      encryptedContent: account.noteContent(note.id, docWithText('binned'), note.revision + 1),
      reason: 'reencrypt',
    });
    expect(reencrypted.status).toBe(200);
    const row = await dbNote(note.id);
    expect(row.revision).toBe(note.revision + 1);
    expect(row.deleted_at).toEqual(trashedAt);
    expect(decryptJson(account.vaultKey, row.encrypted_content)).toEqual(docWithText('binned'));
  });
});
