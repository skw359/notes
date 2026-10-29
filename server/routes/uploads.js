import { Router } from 'express';
import path from 'path';
import pool from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { resolveLegacyUploadPath } from '../utils/blobStore.js';

const router = Router();

router.use(authenticateToken);

router.get('/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);

    const userResult = await pool.query('SELECT profile_picture FROM users WHERE id = $1', [req.user.id]);
    const noteResult = await pool.query(
      'SELECT id FROM notes WHERE user_id = $1 AND content::text ILIKE $2 LIMIT 1',
      [req.user.id, `%${filename}%`]
    );

    const ownsProfilePicture = userResult.rows[0]?.profile_picture === filename;
    const ownsNoteUpload = noteResult.rows.length > 0;

    if (!ownsProfilePicture && !ownsNoteUpload) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.sendFile(resolveLegacyUploadPath(filename));
  } catch (error) {
    console.error('Legacy upload read error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
