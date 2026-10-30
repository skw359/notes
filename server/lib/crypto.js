import argon2 from 'argon2';
import crypto from 'crypto';

const HMAC_PREFIX = 'hmac-sha256$v1$';

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacBase64url(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

export function timingSafeEqualStrings(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) {
    // Still spend a comparison so the length mismatch is not the fast path.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verifiers (the HKDF auth secret and the recovery verifier) are 256-bit
 * values derived client-side, so a keyed HMAC is as strong as a slow hash
 * here: anyone holding the database can already attack the password through
 * wrapped_vault_key at full client-side Argon2 cost. Unlike server-side
 * Argon2 it costs microseconds, so login can no longer be used to exhaust
 * the libuv thread pool (SEC-5).
 */
export function createVerifierHasher(pepper) {
  if (!pepper || pepper.length < 32) {
    throw new Error('A verifier pepper of at least 32 bytes is required');
  }

  function hash(value) {
    return `${HMAC_PREFIX}${hmacBase64url(pepper, String(value))}`;
  }

  async function verify(storedHash, value) {
    if (typeof storedHash !== 'string' || typeof value !== 'string' || !value) {
      return { valid: false, needsUpgrade: false };
    }
    if (storedHash.startsWith(HMAC_PREFIX)) {
      return { valid: timingSafeEqualStrings(storedHash, hash(value)), needsUpgrade: false };
    }
    if (storedHash.startsWith('$argon2')) {
      // Pre-2.0 hashes. Verified once more with Argon2, then replaced.
      try {
        const valid = await argon2.verify(storedHash, value);
        return { valid, needsUpgrade: valid };
      } catch {
        return { valid: false, needsUpgrade: false };
      }
    }
    return { valid: false, needsUpgrade: false };
  }

  // Spent when no account (or no verifier) exists, so unknown accounts take
  // the same path and time as a failed comparison.
  function burn(value) {
    timingSafeEqualStrings(hash(`burn:${value || ''}`), hash('burn:'));
  }

  return { hash, verify, burn };
}
