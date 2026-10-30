import crypto from 'crypto';
import request from 'supertest';
import { randomEmail } from './testApp.js';
import { docWithText, makeAccount } from './e2ee.js';

export { TEST_JWT_SECRET, createTestApp, insertLegacyNote, insertLegacyUser, randomEmail } from './testApp.js';

export async function signupUser(app, { email = randomEmail(), account = makeAccount() } = {}) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/signup').send(account.signupBody(email));
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { agent, account, email, user: res.body.user, response: res.body };
}

export async function loginAgent(app, email, account) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, authSecret: account.authSecret });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

// Creates a note the way the client does: POST an empty row, then the first
// save with id-bound ciphertext. Returns the saved note (revision 1).
export async function createEncryptedNote(agent, account, text = 'hello', { blobIds = [] } = {}) {
  const created = await agent.post('/api/notes').send({});
  if (created.status !== 201) {
    throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = created.body.note.id;
  const saved = await agent.put(`/api/notes/${id}`).send({
    baseRevision: 0,
    encryptedContent: account.noteContent(id, docWithText(text), 1),
    encryptedSummary: account.noteSummary(id, { title: text, preview: '' }),
    blobIds,
  });
  if (saved.status !== 200) {
    throw new Error(`first save failed: ${saved.status} ${JSON.stringify(saved.body)}`);
  }
  return saved.body.note;
}

export async function saveEncrypted(agent, account, note, text, { baseRevision = note.revision, blobIds = [], ...extra } = {}) {
  return agent.put(`/api/notes/${note.id}`).send({
    baseRevision,
    encryptedContent: account.noteContent(note.id, docWithText(text), baseRevision + 1),
    encryptedSummary: account.noteSummary(note.id, { title: text, preview: '' }),
    blobIds,
    ...extra,
  });
}

export async function uploadBlob(agent, bytes, { version = 3, keyId, iv } = {}) {
  let req = agent
    .post('/api/blobs')
    .set('Content-Type', 'application/octet-stream')
    .set('X-Blob-Version', String(version));
  if (version === 3) {
    req = req.set('X-Blob-Key-Id', keyId);
  } else {
    req = req.set('X-Blob-IV', iv || crypto.randomBytes(12).toString('base64'));
  }
  return req.send(Buffer.from(bytes));
}
