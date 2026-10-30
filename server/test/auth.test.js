import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_JWT_SECRET,
  createEncryptedNote,
  createTestApp,
  insertLegacyUser,
  loginAgent,
  randomEmail,
  signupUser,
} from './helpers/app.js';
import { encryptBytes, makeAccount, randomVerifier, TEST_KDF_PARAMS } from './helpers/e2ee.js';
import { loadConfig } from '../config.js';

let t;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

function rekeyBody(account, currentAuthSecret = account.authSecret) {
  const next = makeAccount({ vaultKey: account.vaultKey });
  return {
    next,
    body: {
      currentAuthSecret,
      authSalt: next.salt,
      kdfParams: TEST_KDF_PARAMS,
      authVerifier: next.authSecret,
      wrappedVaultKey: encryptBytes(next.kek, account.vaultKey, { context: 'vault-key:password', keyId: account.keyId }),
    },
  };
}

describe('SEC-9: prelogin does not reveal whether an account exists', () => {
  it('returns identically shaped responses for real and unknown accounts', async () => {
    const { email } = await signupUser(t.app);
    const real = await request(t.app).post('/api/auth/prelogin').send({ email });
    const unknown = await request(t.app).post('/api/auth/prelogin').send({ email: randomEmail('ghost') });

    expect(real.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(Object.keys(real.body)).toEqual(Object.keys(unknown.body));
    expect(Object.keys(real.body.kdfParams)).toEqual(Object.keys(unknown.body.kdfParams));
    expect(Object.keys(real.body.kdfParams)).toEqual(['algorithm', 'time', 'mem', 'hashLen', 'parallelism']);
  });

  it('returns a stable decoy per unknown email', async () => {
    const email = randomEmail('ghost');
    const a = await request(t.app).post('/api/auth/prelogin').send({ email });
    const b = await request(t.app).post('/api/auth/prelogin').send({ email: email.toUpperCase() });
    expect(a.body.salt).toBe(b.body.salt);
  });

  it('treats a salt-less encrypted account like an unknown one (no 400)', async () => {
    const { email, user } = await signupUser(t.app);
    await t.pool.query('UPDATE users SET auth_salt = NULL WHERE id = $1', [user.id]);
    const res = await request(t.app).post('/api/auth/prelogin').send({ email });
    expect(res.status).toBe(200);
    expect(res.body.authMode).toBe('e2ee');
  });

  it('normalizes email case: no duplicate accounts, case-insensitive login', async () => {
    const email = randomEmail('Case');
    const account = makeAccount();
    const first = await request(t.app).post('/api/auth/signup').send(account.signupBody(email.toUpperCase()));
    expect(first.status).toBe(201);
    expect(first.body.user.email).toBe(email.toLowerCase());

    const second = await request(t.app).post('/api/auth/signup').send(makeAccount().signupBody(email.toLowerCase()));
    expect(second.status).toBe(409);

    const login = await request(t.app)
      .post('/api/auth/login')
      .send({ email: email.toLowerCase(), authSecret: account.authSecret });
    expect(login.status).toBe(200);
  });
});

describe('SEC-10: signup validation', () => {
  it('rejects accounts that could never log in', async () => {
    const account = makeAccount();
    const base = account.signupBody(randomEmail());
    const invalid = [
      { ...base, kdfParams: {} },
      { ...base, kdfParams: { ...TEST_KDF_PARAMS, mem: 1024 } },
      { ...base, wrappedVaultKey: {} },
      { ...base, wrappedVaultKeyRecovery: base.wrappedVaultKey },
      { ...base, encryptedProfile: { version: 2 } },
      { ...base, email: 'not-an-email' },
      { ...base, authVerifier: 'short' },
      {},
    ];
    for (const body of invalid) {
      const res = await request(t.app).post('/api/auth/signup').send(body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
    }
  });

  it('concurrent signups for one email yield one 201 and one 409, never a 500', async () => {
    const email = randomEmail('race');
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => request(t.app).post('/api/auth/signup').send(makeAccount().signupBody(email)))
    );
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
  });
});

describe('SEC-4: sessions are revocable', () => {
  it('a cookie no longer works after logout', async () => {
    const { agent } = await signupUser(t.app);
    const cookie = (await agent.get('/api/auth/me')).request.cookies;
    expect((await agent.post('/api/auth/logout')).status).toBe(200);

    const replay = await request(t.app).get('/api/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SESSION_EXPIRED');
  });

  it('a password change signs out other sessions and keeps the recovery key', async () => {
    const { agent, account, email, user } = await signupUser(t.app);
    const other = await loginAgent(t.app, email, account);
    const recoveryBefore = (await t.pool.query('SELECT recovery_verifier_hash, wrapped_vault_key_recovery FROM users WHERE id = $1', [user.id])).rows[0];

    const { body, next } = rekeyBody(account);
    const res = await agent.post('/api/auth/rekey').send(body);
    expect(res.status).toBe(200);

    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/notes')).status).toBe(401);

    // CRYPTO-4: the recovery key is untouched by a password change.
    const recoveryAfter = (await t.pool.query('SELECT recovery_verifier_hash, wrapped_vault_key_recovery FROM users WHERE id = $1', [user.id])).rows[0];
    expect(recoveryAfter).toEqual(recoveryBefore);

    // Old password no longer works, new one does.
    expect((await request(t.app).post('/api/auth/login').send({ email, authSecret: account.authSecret })).status).toBe(401);
    expect((await request(t.app).post('/api/auth/login').send({ email, authSecret: next.authSecret })).status).toBe(200);
  });

  it('rejects a password change with the wrong current password', async () => {
    const { agent, account } = await signupUser(t.app);
    const { body } = rekeyBody(account, randomVerifier());
    const res = await agent.post('/api/auth/rekey').send(body);
    expect(res.status).toBe(401);
  });

  it('recovery signs out every existing session', async () => {
    const { agent, account, email } = await signupUser(t.app);
    const begin = await request(t.app)
      .post('/api/auth/recover/begin')
      .send({ email, recoveryVerifier: account.recoveryVerifier });
    expect(begin.status).toBe(200);
    expect(begin.body.wrappedVaultKeyRecovery).toBeDefined();

    const next = makeAccount({ vaultKey: account.vaultKey });
    const recovered = request.agent(t.app);
    const res = await recovered.post('/api/auth/recover').send({
      email,
      recoveryVerifier: account.recoveryVerifier,
      authSalt: next.salt,
      kdfParams: TEST_KDF_PARAMS,
      authVerifier: next.authSecret,
      wrappedVaultKey: encryptBytes(next.kek, account.vaultKey, { context: 'vault-key:password', keyId: account.keyId }),
    });
    expect(res.status).toBe(200);
    expect((await agent.get('/api/notes')).status).toBe(401);
    expect((await recovered.get('/api/notes')).status).toBe(200);
  });

  it('rejects a wrong recovery key without revealing account existence', async () => {
    const { email } = await signupUser(t.app);
    const wrong = await request(t.app).post('/api/auth/recover/begin').send({ email, recoveryVerifier: randomVerifier() });
    const unknown = await request(t.app)
      .post('/api/auth/recover/begin')
      .send({ email: randomEmail('ghost'), recoveryVerifier: randomVerifier() });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('"sign out other sessions" revokes everything but the current session', async () => {
    const { agent, account, email } = await signupUser(t.app);
    const other = await loginAgent(t.app, email, account);
    const list = await agent.get('/api/auth/sessions');
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.filter((s) => s.current)).toHaveLength(1);

    expect((await agent.post('/api/auth/sessions/revoke-others')).body.revoked).toBe(1);
    expect((await other.get('/api/notes')).status).toBe(401);
    expect((await agent.get('/api/notes')).status).toBe(200);
  });

  it('can revoke one specific session', async () => {
    const { agent, account, email } = await signupUser(t.app);
    const other = await loginAgent(t.app, email, account);
    const sessions = (await agent.get('/api/auth/sessions')).body.sessions;
    const target = sessions.find((s) => !s.current);
    expect((await agent.delete(`/api/auth/sessions/${target.id}`)).status).toBe(200);
    expect((await other.get('/api/notes')).status).toBe(401);
  });

  it('expired sessions are rejected and active ones slide forward', async () => {
    const { agent, user } = await signupUser(t.app);
    await t.pool.query(`UPDATE sessions SET last_seen_at = NOW() - INTERVAL '2 hours' WHERE user_id = $1`, [user.id]);
    const before = (await t.pool.query('SELECT expires_at FROM sessions WHERE user_id = $1', [user.id])).rows[0].expires_at;
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.join(';')).toMatch(/token=/);
    const after = (await t.pool.query('SELECT expires_at FROM sessions WHERE user_id = $1', [user.id])).rows[0].expires_at;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());

    await t.pool.query(`UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [user.id]);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('pre-2.0 JWT cookies during the upgrade', () => {
  it('converts a valid JWT into a revocable session', async () => {
    const { user } = await signupUser(t.app);
    const legacyToken = jwt.sign({ id: user.id, email: user.email }, TEST_JWT_SECRET, { expiresIn: '7d' });

    const first = await request(t.app).get('/api/notes').set('Cookie', `token=${legacyToken}`);
    expect(first.status).toBe(200);
    const newCookie = first.headers['set-cookie'].find((c) => c.startsWith('token='));
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toContain(legacyToken);

    // Logging out with the converted session also kills the JWT itself.
    const sessionCookie = newCookie.split(';')[0];
    expect((await request(t.app).post('/api/auth/logout').set('Cookie', sessionCookie)).status).toBe(200);
    const replay = await request(t.app).get('/api/notes').set('Cookie', `token=${legacyToken}`);
    expect(replay.status).toBe(401);
  });

  it('refuses JWTs issued before "sign out everywhere" and forged ones', async () => {
    const { agent, user } = await signupUser(t.app);
    const legacyToken = jwt.sign({ id: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) - 60 }, TEST_JWT_SECRET, {
      expiresIn: '7d',
    });
    await agent.post('/api/auth/sessions/revoke-others');
    expect((await request(t.app).get('/api/notes').set('Cookie', `token=${legacyToken}`)).status).toBe(401);

    const forged = jwt.sign({ id: user.id }, 'some-other-secret', { expiresIn: '7d' });
    expect((await request(t.app).get('/api/notes').set('Cookie', `token=${forged}`)).status).toBe(401);
  });
});

describe('verifier hashing', () => {
  it('upgrades a pre-2.0 Argon2 verifier hash to HMAC on login', async () => {
    const { email, account, user } = await signupUser(t.app);
    const oldHash = await argon2.hash(account.authSecret, { type: argon2.argon2id, timeCost: 2, memoryCost: 19456 });
    await t.pool.query('UPDATE users SET auth_verifier_hash = $2 WHERE id = $1', [user.id, oldHash]);

    expect((await request(t.app).post('/api/auth/login').send({ email, authSecret: account.authSecret })).status).toBe(200);
    const stored = (await t.pool.query('SELECT auth_verifier_hash FROM users WHERE id = $1', [user.id])).rows[0];
    expect(stored.auth_verifier_hash.startsWith('hmac-sha256$v1$')).toBe(true);
    expect((await request(t.app).post('/api/auth/login').send({ email, authSecret: account.authSecret })).status).toBe(200);
    expect((await request(t.app).post('/api/auth/login').send({ email, authSecret: randomVerifier() })).status).toBe(401);
  });

  it('never stores the raw auth secret', async () => {
    const { account, user } = await signupUser(t.app);
    const row = (await t.pool.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
    expect(JSON.stringify(row)).not.toContain(account.authSecret);
    expect(JSON.stringify(row)).not.toContain(account.recoveryVerifier);
  });
});

describe('CRYPTO-2 / CRYPTO-4: regenerating the recovery key', () => {
  it('requires the current password and replaces the recovery key', async () => {
    const { agent, account, email } = await signupUser(t.app);
    const newRecovery = makeAccount({ vaultKey: account.vaultKey });
    const body = {
      currentAuthSecret: account.authSecret,
      recoveryVerifier: newRecovery.recoveryVerifier,
      wrappedVaultKeyRecovery: encryptBytes(newRecovery.recoveryWrappingKey, account.vaultKey, {
        context: 'vault-key:recovery',
        keyId: account.keyId,
      }),
    };
    expect((await agent.post('/api/auth/recovery-key').send({ ...body, currentAuthSecret: randomVerifier() })).status).toBe(401);
    const res = await agent.post('/api/auth/recovery-key').send(body);
    expect(res.status).toBe(200);
    expect(res.body.recoveryKeyUpdatedAt).toBeTruthy();

    const oldKey = await request(t.app).post('/api/auth/recover/begin').send({ email, recoveryVerifier: account.recoveryVerifier });
    expect(oldKey.status).toBe(401);
    const newKey = await request(t.app).post('/api/auth/recover/begin').send({ email, recoveryVerifier: newRecovery.recoveryVerifier });
    expect(newKey.status).toBe(200);
  });
});

describe('legacy login', () => {
  it('logs a legacy account in and flags the required migration', async () => {
    const { email, password } = await insertLegacyUser(t.pool);
    const res = await request(t.app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.user.auth_mode).toBe('legacy');
    expect(res.body.migrationRequired).toBe(true);
    const wrong = await request(t.app).post('/api/auth/login').send({ email, password: 'nope' });
    expect(wrong.status).toBe(401);
  });
});

describe('me', () => {
  it('returns the vault bootstrap without the recovery-wrapped key', async () => {
    const { agent, account } = await signupUser(t.app);
    await createEncryptedNote(agent, account, 'x');
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.vaultBootstrap.wrappedVaultKey).toBeDefined();
    expect(res.body.vaultBootstrap.wrappedVaultKeyRecovery).toBeUndefined();
    expect(res.body.vaultBootstrap.vaultKeyId).toBe(account.keyId);
  });
});

describe('OPS-1 / SEC-7: deployment defaults', () => {
  let secureApp;
  beforeAll(async () => {
    secureApp = await createTestApp({ env: { COOKIE_SECURE: 'true', SIGNUP_MODE: 'closed' } });
  });
  afterAll(async () => {
    await secureApp.close();
  });

  it('SIGNUP_MODE=closed refuses registrations', async () => {
    const signup = await request(secureApp.app).post('/api/auth/signup').send(makeAccount().signupBody(randomEmail()));
    expect(signup.status).toBe(403);
    expect(signup.body.code).toBe('SIGNUP_DISABLED');
  });

  it('defaults COOKIE_SECURE to true', () => {
    expect(secureApp.config.cookie.secure).toBe('true');
    expect(loadConfig({ JWT_SECRET: 'x'.repeat(40) }).cookie.secure).toBe('true');
  });

  it('marks the session cookie Secure, HttpOnly and SameSite=Lax', async () => {
    const open = await createTestApp({ env: { COOKIE_SECURE: 'true' } });
    try {
      const res = await request(open.app).post('/api/auth/signup').send(makeAccount().signupBody(randomEmail()));
      expect(res.status).toBe(201);
      const cookie = res.headers['set-cookie'].find((c) => c.startsWith('token='));
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    } finally {
      await open.close();
    }
  });

  it('invite mode requires the configured code', async () => {
    const invite = await createTestApp({ env: { SIGNUP_MODE: 'invite', SIGNUP_INVITE_CODE: 'let-me-in-please' } });
    try {
      const without = await request(invite.app).post('/api/auth/signup').send(makeAccount().signupBody(randomEmail()));
      expect(without.status).toBe(403);
      const withCode = await request(invite.app)
        .post('/api/auth/signup')
        .send(makeAccount().signupBody(randomEmail(), { inviteCode: 'let-me-in-please' }));
      expect(withCode.status).toBe(201);
    } finally {
      await invite.close();
    }
  });
});

describe('SEC-5: abuse controls', () => {
  it('rate-limits login attempts per IP and per account', async () => {
    const limited = await createTestApp({
      env: { RATE_LIMITS: 'true', RATE_LIMIT_LOGIN_IP: '5', RATE_LIMIT_LOGIN_ACCOUNT: '3' },
    });
    try {
      const { email } = await signupUser(limited.app);
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await request(limited.app).post('/api/auth/login').send({ email, authSecret: randomVerifier() })).status);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses[3]).toBe(429);

      for (let i = 0; i < 3; i += 1) {
        await request(limited.app).post('/api/auth/login').send({ email: randomEmail(), authSecret: randomVerifier() });
      }
      const ipLimited = await request(limited.app)
        .post('/api/auth/login')
        .send({ email: randomEmail(), authSecret: randomVerifier() });
      expect(ipLimited.status).toBe(429);
      expect(ipLimited.body.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });

  it('rejects oversized unauthenticated bodies before parsing them', async () => {
    const big = 'x'.repeat(t.config.limits.authBodyBytes + 1024);
    const res = await request(t.app)
      .post('/api/auth/prelogin')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@example.com', padding: big }));
    expect(res.status).toBe(413);
  });

  it('login does not spend server-side Argon2 time', async () => {
    const { email } = await signupUser(t.app);
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 50 }, () => request(t.app).post('/api/auth/login').send({ email, authSecret: randomVerifier() }))
    );
    // 50 failed logins used to cost ~50 Argon2id(19 MiB) hashes; HMAC is
    // effectively free, so this is dominated by HTTP + database overhead.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
