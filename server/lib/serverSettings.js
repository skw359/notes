import crypto from 'crypto';

export async function getOrCreateSetting(pool, key, generate) {
  const existing = await pool.query('SELECT value FROM server_settings WHERE key = $1', [key]);
  if (existing.rows[0]) {
    return existing.rows[0].value;
  }
  await pool.query('INSERT INTO server_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
    key,
    generate(),
  ]);
  const created = await pool.query('SELECT value FROM server_settings WHERE key = $1', [key]);
  return created.rows[0].value;
}

// HMAC key for stored verifiers, generated once per instance and kept with
// the data it protects (restoring a database restores its pepper).
export async function getVerifierPepper(pool) {
  const value = await getOrCreateSetting(pool, 'verifier_pepper', () => crypto.randomBytes(32).toString('base64'));
  return Buffer.from(value, 'base64');
}
