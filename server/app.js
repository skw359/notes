import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { SERVER_DIR } from './config.js';
import { createBlobStorage } from './lib/blobStorage.js';
import { createVerifierHasher } from './lib/crypto.js';
import { apiNotFoundHandler, errorHandler } from './lib/errors.js';
import { createLimiters } from './lib/rateLimit.js';
import { getVerifierPepper } from './lib/serverSettings.js';
import { createSessionManager } from './lib/sessions.js';
import { createSessionMiddleware } from './middleware/auth.js';
import { sameOriginWrites, securityHeaders } from './middleware/security.js';
import { createAuthRouter } from './routes/auth.js';
import { createBlobsRouter } from './routes/blobs.js';
import { createLegacyUploadsRouter } from './routes/legacyUploads.js';
import { createNotesRouter } from './routes/notes.js';
import { createUsersRouter } from './routes/users.js';
import { createVaultRouter } from './routes/vault.js';

export const DEFAULT_CLIENT_DIST = path.join(SERVER_DIR, '..', 'client', 'dist');

// Everything a request handler needs, built once (and once per test).
export async function createContext({ config, pool, log = console, clientDist = DEFAULT_CLIENT_DIST }) {
  const storage = createBlobStorage(config.storage);
  await storage.init();
  const verifier = createVerifierHasher(await getVerifierPepper(pool));
  const sessions = createSessionManager({ pool, config });
  const { requireSession, optionalSession } = createSessionMiddleware({ sessions, config });

  return {
    config,
    pool,
    log,
    storage,
    verifier,
    sessions,
    requireSession,
    optionalSession,
    limiters: createLimiters(config),
    clientDist,
  };
}

function serveClient(app, clientDist) {
  const indexFile = path.join(clientDist, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return;
  }

  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders(res, filePath) {
        // Vite assets are content-hashed and immutable; everything else
        // (index.html above all) must be revalidated so a deploy takes
        // effect on the next load instead of leaving tabs on old code.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );
  app.get('/{*splat}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });
}

export function createApp(ctx) {
  const { config } = ctx;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders(config));
  // Same-origin by default; cross-origin API access only when configured.
  if (config.corsOrigins.length) {
    app.use('/api', cors({ origin: config.corsOrigins, credentials: true }));
  }
  app.use(cookieParser());
  app.use('/api', sameOriginWrites(config));

  // Body limits are per route: tiny for auth (unauthenticated), larger for
  // notes; blob uploads are streamed with their own limit (SEC-5).
  const defaultJson = express.json({ limit: config.limits.defaultBodyBytes });
  const notesJson = express.json({ limit: config.limits.notesBodyBytes });

  app.get('/api/health', async (req, res) => {
    await ctx.pool.query('SELECT 1');
    res.json({ ok: true });
  });
  app.use('/api/auth', createAuthRouter(ctx));
  app.use('/api/notes', notesJson, createNotesRouter(ctx));
  app.use('/api/blobs', createBlobsRouter(ctx));
  app.use('/api/users', defaultJson, createUsersRouter(ctx));
  app.use('/api/legacy-uploads', defaultJson, createLegacyUploadsRouter(ctx));
  app.use('/api/vault', createVaultRouter(ctx));
  // Unknown API routes get JSON 404s instead of the SPA's index.html (ARCH-2).
  app.use('/api', apiNotFoundHandler);

  serveClient(app, ctx.clientDist);
  app.use(errorHandler);
  return app;
}
