import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { deleteFileIfExists, resolveLegacyUploadPath } from '../utils/blobStore.js';
import { extractLegacyFilenamesFromContent } from '../utils/legacy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const uniqueName = `${req.user.id}-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') {
      cb(null, true);
    } else {
      cb(new Error('Only JPG files are allowed'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = Router();

router.use(authenticateToken);

function maybeHandleLegacyUpload(req, res, next) {
  if (!req.is('multipart/form-data')) {
    return next();
  }

  return upload.single('profile_picture')(req, res, next);
}

async function getUserRecord(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

router.put('/profile', maybeHandleLegacyUpload, async (req, res) => {
  try {
    const user = await getUserRecord(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.auth_mode === 'e2ee') {
      const { encryptedProfile, previousProfilePictureBlobId } = req.body;
      if (!encryptedProfile) {
        return res.status(400).json({ error: 'Encrypted profile is required' });
      }

      await pool.query(
        `
          UPDATE users
          SET encrypted_profile = $1, updated_at = NOW()
          WHERE id = $2
        `,
        [JSON.stringify(encryptedProfile), req.user.id]
      );

      if (previousProfilePictureBlobId) {
        const blobResult = await pool.query(
          'SELECT id, storage_path FROM blobs WHERE id = $1 AND user_id = $2',
          [previousProfilePictureBlobId, req.user.id]
        );

        if (blobResult.rows.length > 0) {
          await deleteFileIfExists(blobResult.rows[0].storage_path);
          await pool.query('DELETE FROM blobs WHERE id = $1 AND user_id = $2', [
            previousProfilePictureBlobId,
            req.user.id,
          ]);
        }
      }

      return res.json({ ok: true });
    }

    const { first_name, last_name } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (first_name) {
      updates.push(`first_name = $${paramIndex++}`);
      values.push(first_name);
    }
    if (last_name) {
      updates.push(`last_name = $${paramIndex++}`);
      values.push(last_name);
    }
    if (req.file) {
      updates.push(`profile_picture = $${paramIndex++}`);
      values.push(req.file.filename);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, email, first_name, last_name, profile_picture, created_at`,
      values
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/account', async (req, res) => {
  try {
    const legacyFiles = new Set();
    const noteResult = await pool.query('SELECT content FROM notes WHERE user_id = $1', [req.user.id]);
    for (const row of noteResult.rows) {
      for (const filename of extractLegacyFilenamesFromContent(row.content)) {
        legacyFiles.add(filename);
      }
    }

    const user = await getUserRecord(req.user.id);
    if (user?.profile_picture) {
      legacyFiles.add(user.profile_picture);
    }

    const blobResult = await pool.query('SELECT storage_path FROM blobs WHERE user_id = $1', [req.user.id]);
    await Promise.all(blobResult.rows.map((blob) => deleteFileIfExists(blob.storage_path)));
    await Promise.all(
      [...legacyFiles].map((filename) => deleteFileIfExists(resolveLegacyUploadPath(filename)))
    );

    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    res.clearCookie('token');
    res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('Account delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
