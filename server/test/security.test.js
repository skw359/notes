import fsp from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signupUser } from './helpers/app.js';

let t;

beforeAll(async () => {
  const dist = path.join(process.env.NOTES_TEST_TMPDIR || (await import('os')).tmpdir(), `dist-${Date.now()}`);
  await fsp.mkdir(path.join(dist, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Notes</title>');
  await fsp.writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  t = await createTestApp({ clientDist: dist });
  t.dist = dist;
});

afterAll(async () => {
  await t.close();
  await fsp.rm(t.dist, { recursive: true, force: true });
});

describe('security headers (SEC-11, OPS-1)', () => {
  it('sends a strict CSP without third-party font hosts, HSTS and no X-Powered-By', async () => {
    const res = await request(t.app).get('/');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/googleapis|gstatic/);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('caches hashed assets immutably and revalidates index.html', async () => {
    const asset = await request(t.app).get('/assets/app-abc123.js');
    expect(asset.headers['cache-control']).toContain('immutable');
    const index = await request(t.app).get('/some/client/route');
    expect(index.status).toBe(200);
    expect(index.headers['cache-control']).toBe('no-cache');
  });
});

describe('ARCH-2: API routing', () => {
  it('answers unknown API routes with JSON 404 instead of the SPA', async () => {
    for (const url of ['/api/uploads/anything.pdf', '/api/does-not-exist', '/api/notes-but-wrong']) {
      const res = await request(t.app).get(url);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });
});

describe('cross-site request protection', () => {
  it('refuses state-changing API calls from other sites', async () => {
    const { agent } = await signupUser(t.app);
    const crossSite = await agent.post('/api/notes').set('Sec-Fetch-Site', 'cross-site').send({});
    expect(crossSite.status).toBe(403);
    const sameSite = await agent.post('/api/notes').set('Sec-Fetch-Site', 'same-site').send({});
    expect(sameSite.status).toBe(403);
    const foreignOrigin = await agent.post('/api/notes').set('Origin', 'https://evil.example').send({});
    expect(foreignOrigin.status).toBe(403);
    const sameOrigin = await agent.post('/api/notes').set('Sec-Fetch-Site', 'same-origin').send({});
    expect(sameOrigin.status).toBe(201);
    // Reads are unaffected.
    expect((await agent.get('/api/notes').set('Sec-Fetch-Site', 'cross-site')).status).toBe(200);
  });
});
