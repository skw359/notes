import { Router } from 'express';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticateToken, JWT_SECRET } from '../middleware/auth.js';
import { extractLegacyFilenamesFromContent } from '../utils/legacy.js';
import { deleteFileIfExists, resolveLegacyUploadPath } from '../utils/blobStore.js';

const router = Router();

function setAuthCookie(res, user) {
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function buildVaultBootstrap(user) {
  return {
    salt: user.auth_salt,
    kdfParams: user.kdf_params,
    wrappedVaultKey: user.wrapped_vault_key,
    wrappedVaultKeyRecovery: user.wrapped_vault_key_recovery,
    vaultVersion: user.vault_version || 1,
  };
}

function buildE2EEAuthResponse(user) {
  return {
    user: {
      id: user.id,
      email: user.email,
      auth_mode: 'e2ee',
      created_at: user.created_at,
    },
    vaultBootstrap: buildVaultBootstrap(user),
    encryptedProfile: user.encrypted_profile,
  };
}

function buildLegacyAuthResponse(user) {
  return {
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      profile_picture: user.profile_picture,
      created_at: user.created_at,
      auth_mode: 'legacy',
    },
  };
}

async function hashVerifier(value) {
  return argon2.hash(value, {
    type: argon2.argon2id,
    timeCost: 3,
    memoryCost: 19456,
    parallelism: 1,
  });
}

async function verifyVerifier(hash, value) {
  return argon2.verify(hash, value);
}

// Verified against whenever no real hash exists, so unknown accounts cost the
// same argon2 work as failed logins and don't stand out by response time.
const dummyVerifierHashPromise = hashVerifier(crypto.randomBytes(32).toString('base64'));

async function burnVerifierCheck(value) {
  try {
    await verifyVerifier(await dummyVerifierHashPromise, value || '');
  } catch {
    // only used to equalize timing
  }
}

const DECOY_KDF_PARAMS = {
  algorithm: 'argon2id',
  time: 3,
  mem: 65536,
  hashLen: 32,
  parallelism: 1,
};

// Deterministic per-email decoy salt so probing an unknown email returns a
// stable, real-looking prelogin response instead of revealing account status.
function buildDecoySalt(email) {
  return crypto
    .createHmac('sha256', `${JWT_SECRET}:prelogin-decoy`)
    .update(String(email).trim().toLowerCase())
    .digest()
    .subarray(0, 16)
    .toString('base64');
}

router.post('/prelogin', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await pool.query(
      `
        SELECT auth_mode, auth_salt, kdf_params
        FROM users
        WHERE email = $1
      `,
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.json({
        authMode: 'e2ee',
        salt: buildDecoySalt(email),
        kdfParams: DECOY_KDF_PARAMS,
      });
    }

    if (user.auth_mode === 'e2ee') {
      // Defensive: an e2ee account should always have a salt. Without this
      // guard a NULL one would be fed into Argon2id and crash the client.
      if (!user.auth_salt) {
        return res.status(400).json({
          error: 'This account has no password set. Use your recovery key.',
        });
      }
      // Wrapped vault keys are only released after successful authentication
      // (login) or a valid recovery verifier (/recover/begin), so knowing an
      // email is not enough to obtain offline-crackable material.
      return res.json({
        authMode: 'e2ee',
        salt: user.auth_salt,
        kdfParams: user.kdf_params,
      });
    }

    return res.json({ authMode: 'legacy' });
  } catch (error) {
    console.error('Prelogin error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/signup', async (req, res) => {
  try {
    const {
      email,
      authSalt,
      kdfParams,
      authVerifier,
      recoveryVerifier,
      wrappedVaultKey,
      wrappedVaultKeyRecovery,
      encryptedProfile,
    } = req.body;

    if (
      !email ||
      !authSalt ||
      !kdfParams ||
      !authVerifier ||
      !recoveryVerifier ||
      !wrappedVaultKey ||
      !wrappedVaultKeyRecovery ||
      !encryptedProfile
    ) {
      return res.status(400).json({ error: 'Missing signup fields' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const [authVerifierHash, recoveryVerifierHash] = await Promise.all([
      hashVerifier(authVerifier),
      hashVerifier(recoveryVerifier),
    ]);

    const result = await pool.query(
      `
        INSERT INTO users (
          email,
          auth_mode,
          auth_salt,
          kdf_params,
          auth_verifier_hash,
          recovery_verifier_hash,
          wrapped_vault_key,
          wrapped_vault_key_recovery,
          encrypted_profile,
          vault_version
        )
        VALUES ($1, 'e2ee', $2, $3, $4, $5, $6, $7, $8, 1)
        RETURNING *
      `,
      [
        email,
        authSalt,
        JSON.stringify(kdfParams),
        authVerifierHash,
        recoveryVerifierHash,
        JSON.stringify(wrappedVaultKey),
        JSON.stringify(wrappedVaultKeyRecovery),
        JSON.stringify(encryptedProfile),
      ]
    );

    const user = result.rows[0];
    setAuthCookie(res, user);

    res.status(201).json(buildE2EEAuthResponse(user));
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password, authSecret } = req.body;
    if (!email || (!password && !authSecret)) {
      return res.status(400).json({ error: 'Email and credentials are required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      await burnVerifierCheck(authSecret || password);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (user.auth_mode === 'e2ee') {
      const valid = user.auth_verifier_hash
        ? await verifyVerifier(user.auth_verifier_hash, authSecret || '')
        : false;

      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      setAuthCookie(res, user);
      return res.json(buildE2EEAuthResponse(user));
    }

    const valid = user.password_hash ? await bcrypt.compare(password || '', user.password_hash) : false;
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    setAuthCookie(res, user);
    return res.json(buildLegacyAuthResponse(user));
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

router.post('/recover/begin', async (req, res) => {
  try {
    const { email, recoveryVerifier } = req.body;
    if (!email || !recoveryVerifier) {
      return res.status(400).json({ error: 'Email and recovery verifier are required' });
    }

    const result = await pool.query(
      'SELECT recovery_verifier_hash, wrapped_vault_key_recovery FROM users WHERE email = $1 AND auth_mode = $2',
      [email, 'e2ee']
    );

    const user = result.rows[0];
    if (!user?.recovery_verifier_hash) {
      await burnVerifierCheck(recoveryVerifier);
      return res.status(401).json({ error: 'Invalid recovery key' });
    }

    const valid = await verifyVerifier(user.recovery_verifier_hash, recoveryVerifier);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid recovery key' });
    }

    res.json({ wrappedVaultKeyRecovery: user.wrapped_vault_key_recovery });
  } catch (error) {
    console.error('Recover begin error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/recover', async (req, res) => {
  try {
    const {
      email,
      recoveryVerifier,
      authSalt,
      kdfParams,
      authVerifier,
      nextRecoveryVerifier,
      wrappedVaultKey,
      wrappedVaultKeyRecovery,
    } = req.body;

    if (
      !email ||
      !recoveryVerifier ||
      !authSalt ||
      !kdfParams ||
      !authVerifier ||
      !nextRecoveryVerifier ||
      !wrappedVaultKey ||
      !wrappedVaultKeyRecovery
    ) {
      return res.status(400).json({ error: 'Missing recovery fields' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND auth_mode = $2', [
      email,
      'e2ee',
    ]);

    if (result.rows.length === 0) {
      await burnVerifierCheck(recoveryVerifier);
      return res.status(401).json({ error: 'Invalid recovery key' });
    }

    const user = result.rows[0];
    const valid = user.recovery_verifier_hash
      ? await verifyVerifier(user.recovery_verifier_hash, recoveryVerifier)
      : false;

    if (!valid) {
      return res.status(401).json({ error: 'Invalid recovery key' });
    }

    const [authVerifierHash, recoveryVerifierHash] = await Promise.all([
      hashVerifier(authVerifier),
      hashVerifier(nextRecoveryVerifier),
    ]);

    const update = await pool.query(
      `
        UPDATE users
        SET
          auth_salt = $1,
          kdf_params = $2,
          auth_verifier_hash = $3,
          recovery_verifier_hash = $4,
          wrapped_vault_key = $5,
          wrapped_vault_key_recovery = $6,
          updated_at = NOW()
        WHERE id = $7
        RETURNING *
      `,
      [
        authSalt,
        JSON.stringify(kdfParams),
        authVerifierHash,
        recoveryVerifierHash,
        JSON.stringify(wrappedVaultKey),
        JSON.stringify(wrappedVaultKeyRecovery),
        user.id,
      ]
    );

    const updatedUser = update.rows[0];
    setAuthCookie(res, updatedUser);
    res.json(buildE2EEAuthResponse(updatedUser));
  } catch (error) {
    console.error('Recover error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/rekey', authenticateToken, async (req, res) => {
  try {
    const {
      currentAuthSecret,
      authSalt,
      kdfParams,
      authVerifier,
      nextRecoveryVerifier,
      wrappedVaultKey,
      wrappedVaultKeyRecovery,
    } = req.body;

    if (
      !currentAuthSecret ||
      !authSalt ||
      !kdfParams ||
      !authVerifier ||
      !nextRecoveryVerifier ||
      !wrappedVaultKey ||
      !wrappedVaultKeyRecovery
    ) {
      return res.status(400).json({ error: 'Missing rekey fields' });
    }

    const result = await pool.query('SELECT * FROM users WHERE id = $1 AND auth_mode = $2', [
      req.user.id,
      'e2ee',
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const valid = user.auth_verifier_hash
      ? await verifyVerifier(user.auth_verifier_hash, currentAuthSecret)
      : false;

    if (!valid) {
      return res.status(401).json({ error: 'Invalid current password' });
    }

    const [authVerifierHash, recoveryVerifierHash] = await Promise.all([
      hashVerifier(authVerifier),
      hashVerifier(nextRecoveryVerifier),
    ]);

    const update = await pool.query(
      `
        UPDATE users
        SET
          auth_salt = $1,
          kdf_params = $2,
          auth_verifier_hash = $3,
          recovery_verifier_hash = $4,
          wrapped_vault_key = $5,
          wrapped_vault_key_recovery = $6,
          updated_at = NOW()
        WHERE id = $7
        RETURNING *
      `,
      [
        authSalt,
        JSON.stringify(kdfParams),
        authVerifierHash,
        recoveryVerifierHash,
        JSON.stringify(wrappedVaultKey),
        JSON.stringify(wrappedVaultKeyRecovery),
        user.id,
      ]
    );

    res.json(buildE2EEAuthResponse(update.rows[0]));
  } catch (error) {
    console.error('Rekey error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/migrate', authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      authSalt,
      kdfParams,
      authVerifier,
      recoveryVerifier,
      wrappedVaultKey,
      wrappedVaultKeyRecovery,
      encryptedProfile,
      notes,
    } = req.body;

    if (
      !authSalt ||
      !kdfParams ||
      !authVerifier ||
      !recoveryVerifier ||
      !wrappedVaultKey ||
      !wrappedVaultKeyRecovery ||
      !encryptedProfile ||
      !Array.isArray(notes)
    ) {
      return res.status(400).json({ error: 'Missing migration fields' });
    }

    await client.query('BEGIN');

    const userResult = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    if (user.auth_mode === 'e2ee') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Account is already encrypted' });
    }

    const notesResult = await client.query(
      'SELECT id, content FROM notes WHERE user_id = $1 ORDER BY id ASC FOR UPDATE',
      [req.user.id]
    );
    const dbNotes = notesResult.rows;

    if (dbNotes.length !== notes.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Migration payload does not match existing notes' });
    }

    const encryptedById = new Map(
      notes.map((note) => [
        String(note.id),
        {
          encryptedContent: note.encryptedContent,
          encryptedSummary: note.encryptedSummary,
        },
      ])
    );
    const legacyFiles = new Set();

    if (user.profile_picture) {
      legacyFiles.add(user.profile_picture);
    }

    for (const note of dbNotes) {
      for (const filename of extractLegacyFilenamesFromContent(note.content)) {
        legacyFiles.add(filename);
      }

      if (!encryptedById.has(String(note.id))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Missing migrated note content' });
      }
    }

    const [authVerifierHash, recoveryVerifierHash] = await Promise.all([
      hashVerifier(authVerifier),
      hashVerifier(recoveryVerifier),
    ]);

    await client.query(
      `
        UPDATE users
        SET
          auth_mode = 'e2ee',
          password_hash = NULL,
          first_name = NULL,
          last_name = NULL,
          profile_picture = NULL,
          auth_salt = $1,
          kdf_params = $2,
          auth_verifier_hash = $3,
          recovery_verifier_hash = $4,
          wrapped_vault_key = $5,
          wrapped_vault_key_recovery = $6,
          encrypted_profile = $7,
          vault_version = 1,
          updated_at = NOW()
        WHERE id = $8
      `,
      [
        authSalt,
        JSON.stringify(kdfParams),
        authVerifierHash,
        recoveryVerifierHash,
        JSON.stringify(wrappedVaultKey),
        JSON.stringify(wrappedVaultKeyRecovery),
        JSON.stringify(encryptedProfile),
        req.user.id,
      ]
    );

    for (const note of notes) {
      const migratedNote = encryptedById.get(String(note.id));

      await client.query(
        `
          UPDATE notes
          SET
            content = NULL,
            encrypted_content = $1,
            encrypted_summary = CASE
              WHEN $2::jsonb IS NULL THEN encrypted_summary
              ELSE $2::jsonb
            END,
            updated_at = NOW()
          WHERE id = $3 AND user_id = $4
        `,
        [
          JSON.stringify(migratedNote.encryptedContent),
          typeof migratedNote.encryptedSummary === 'undefined'
            ? null
            : JSON.stringify(migratedNote.encryptedSummary),
          note.id,
          req.user.id,
        ]
      );
    }

    await client.query('COMMIT');

    await Promise.all(
      [...legacyFiles].map((filename) => deleteFileIfExists(resolveLegacyUploadPath(filename)))
    );

    const refreshed = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    res.json(buildE2EEAuthResponse(refreshed.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migrate error:', error);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    if (user.auth_mode === 'e2ee') {
      return res.json(buildE2EEAuthResponse(user));
    }

    return res.json(buildLegacyAuthResponse(user));
  } catch (error) {
    console.error('Me error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
