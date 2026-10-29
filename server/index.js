import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import blobsRoutes from './routes/blobs.js';
import notesRoutes from './routes/notes.js';
import uploadsRoutes from './routes/uploads.js';
import usersRoutes from './routes/users.js';
import { ensureSchema } from './schema.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3004;

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));

// The vault key lives in browser memory, so script injection is key
// exfiltration; the CSP restricts execution to our own bundle
// ('wasm-unsafe-eval' is required by the bundled argon2 WASM, blob:/data:
// images by decrypted attachments, and the font hosts by index.html).
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' blob: data:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/blobs', blobsRoutes);
app.use('/api/legacy-uploads', uploadsRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/users', usersRoutes);

// Serve built frontend
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

async function start() {
  await ensureSchema();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
