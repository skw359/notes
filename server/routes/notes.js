import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

router.use(authenticateToken);

async function getAuthMode(userId) {
  const result = await pool.query('SELECT auth_mode FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.auth_mode || 'legacy';
}

function formatSummaryNote(note, authMode) {
  if (authMode === 'e2ee') {
    return {
      id: note.id,
      user_id: note.user_id,
      encrypted_summary: note.encrypted_summary,
      created_at: note.created_at,
      updated_at: note.updated_at,
      deleted_at: note.deleted_at,
    };
  }

  return note;
}

function formatFullNote(note, authMode) {
  if (authMode === 'e2ee') {
    return {
      id: note.id,
      user_id: note.user_id,
      encrypted_summary: note.encrypted_summary,
      encrypted_content: note.encrypted_content,
      created_at: note.created_at,
      updated_at: note.updated_at,
      deleted_at: note.deleted_at,
    };
  }

  return note;
}

function getEncryptedSummaryValue(authMode, encryptedSummary) {
  if (authMode !== 'e2ee' || typeof encryptedSummary === 'undefined') {
    return null;
  }

  return JSON.stringify(encryptedSummary);
}

router.get('/', async (req, res) => {
  try {
    const authMode = await getAuthMode(req.user.id);
    const result = await pool.query(
      `
        SELECT id, user_id, content, encrypted_summary, created_at, updated_at, deleted_at
        FROM notes
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `,
      [req.user.id]
    );

    const notes = result.rows.map((note) => formatSummaryNote(note, authMode));
    res.json({ notes });
  } catch (err) {
    console.error('Get notes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/trash', async (req, res) => {
  try {
    const authMode = await getAuthMode(req.user.id);

    await pool.query(
      `DELETE FROM notes WHERE user_id = $1 AND deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'`,
      [req.user.id]
    );

    const result = await pool.query(
      `
        SELECT id, user_id, content, encrypted_summary, created_at, updated_at, deleted_at
        FROM notes
        WHERE user_id = $1 AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC
      `,
      [req.user.id]
    );

    const notes = result.rows.map((note) => formatSummaryNote(note, authMode));
    res.json({ notes });
  } catch (err) {
    console.error('Get trash error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const authMode = await getAuthMode(req.user.id);
    const result = await pool.query(
      `
        SELECT id, user_id, content, encrypted_content, encrypted_summary, created_at, updated_at, deleted_at
        FROM notes
        WHERE id = $1 AND user_id = $2
      `,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ note: formatFullNote(result.rows[0], authMode) });
  } catch (err) {
    console.error('Get note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const authMode = await getAuthMode(req.user.id);
    const { content, encryptedContent, encryptedSummary } = req.body;

    const result = await pool.query(
      `
        INSERT INTO notes (user_id, content, encrypted_content, encrypted_summary)
        VALUES ($1, $2, $3, $4)
        RETURNING id, user_id, content, encrypted_content, encrypted_summary, created_at, updated_at, deleted_at
      `,
      [
        req.user.id,
        authMode === 'legacy' ? JSON.stringify(content || {}) : null,
        // e2ee clients may create the row first and attach id-bound
        // ciphertext via PUT; an empty object is not a valid envelope.
        authMode === 'e2ee' && encryptedContent ? JSON.stringify(encryptedContent) : null,
        getEncryptedSummaryValue(authMode, encryptedSummary),
      ]
    );

    res.status(201).json({ note: formatSummaryNote(result.rows[0], authMode) });
  } catch (err) {
    console.error('Create note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const authMode = await getAuthMode(req.user.id);
    const { content, encryptedContent, encryptedSummary } = req.body;

    const result = await pool.query(
      `
        UPDATE notes
        SET
          content = $1,
          encrypted_content = $2,
          encrypted_summary = CASE
            WHEN $3::jsonb IS NULL THEN encrypted_summary
            ELSE $3::jsonb
          END,
          updated_at = NOW()
        WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL
        RETURNING id, user_id, content, encrypted_content, encrypted_summary, created_at, updated_at, deleted_at
      `,
      [
        authMode === 'legacy' ? JSON.stringify(content || {}) : null,
        authMode === 'e2ee' && encryptedContent ? JSON.stringify(encryptedContent) : null,
        getEncryptedSummaryValue(authMode, encryptedSummary),
        id,
        req.user.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ note: formatSummaryNote(result.rows[0], authMode) });
  } catch (err) {
    console.error('Update note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/summary', async (req, res) => {
  try {
    const authMode = await getAuthMode(req.user.id);
    if (authMode !== 'e2ee') {
      return res.status(400).json({ error: 'Encrypted summaries are unavailable for legacy accounts' });
    }

    const { encryptedSummary } = req.body;
    if (!encryptedSummary) {
      return res.status(400).json({ error: 'Encrypted summary is required' });
    }

    const result = await pool.query(
      `
        UPDATE notes
        SET encrypted_summary = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id, user_id, encrypted_summary, created_at, updated_at, deleted_at
      `,
      [JSON.stringify(encryptedSummary), req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ note: formatSummaryNote(result.rows[0], authMode) });
  } catch (err) {
    console.error('Patch summary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/trash', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `
        UPDATE notes SET deleted_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id
      `,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ message: 'Note moved to trash' });
  } catch (err) {
    console.error('Trash note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const authMode = await getAuthMode(req.user.id);
    const result = await pool.query(
      `
        UPDATE notes SET deleted_at = NULL, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
        RETURNING id, user_id, content, encrypted_summary, encrypted_content, created_at, updated_at, deleted_at
      `,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ note: formatSummaryNote(result.rows[0], authMode) });
  } catch (err) {
    console.error('Restore note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ message: 'Note deleted' });
  } catch (err) {
    console.error('Delete note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
