import crypto from 'crypto';

// Mirrors client/src/lib/envelope.js so server tests use real ciphertext.
export function envelopeAad(envelope) {
  if (envelope.version === 2) {
    return Buffer.from(envelope.context, 'utf8');
  }
  if (envelope.version === 3) {
    return Buffer.from(
      JSON.stringify(['notes-envelope-v3', envelope.keyId, envelope.context, envelope.revision ?? null]),
      'utf8'
    );
  }
  return null;
}

export function encryptBytes(key, plaintext, { context, version = 3, keyId, revision } = {}) {
  const iv = crypto.randomBytes(12);
  const envelope = { version, algorithm: 'AES-256-GCM' };
  if (version >= 2) {
    envelope.context = context;
  }
  if (version === 3) {
    envelope.keyId = keyId;
    if (revision !== undefined) {
      envelope.revision = revision;
    }
  }
  envelope.iv = iv.toString('base64');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const aad = envelopeAad(envelope);
  if (aad) {
    cipher.setAAD(aad);
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  envelope.ciphertext = ciphertext.toString('base64');
  return envelope;
}

export function decryptBytes(key, envelope) {
  const data = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  const aad = envelopeAad(envelope);
  if (aad) {
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

export function encryptJson(key, value, options) {
  return encryptBytes(key, Buffer.from(JSON.stringify(value), 'utf8'), options);
}

export function decryptJson(key, envelope) {
  return JSON.parse(decryptBytes(key, envelope).toString('utf8'));
}

export function keyFingerprint(key) {
  return crypto.createHmac('sha256', key).update('notes-vault-key-id-v1').digest('base64url').slice(0, 22);
}

export function randomVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

export const TEST_KDF_PARAMS = { algorithm: 'argon2id', time: 3, mem: 65536, hashLen: 32, parallelism: 1 };

// A complete client-side account: keys and everything signup sends. The
// password KEK and recovery key are random stand-ins (the server never sees
// how they were derived).
export function makeAccount({ vaultKey = crypto.randomBytes(32) } = {}) {
  const keyId = keyFingerprint(vaultKey);
  const kek = crypto.randomBytes(32);
  const recoveryWrappingKey = crypto.randomBytes(32);
  const account = {
    vaultKey,
    keyId,
    kek,
    recoveryWrappingKey,
    authSecret: randomVerifier(),
    recoveryVerifier: randomVerifier(),
    salt: crypto.randomBytes(16).toString('base64'),
  };
  account.signupBody = (email, extra = {}) => ({
    email,
    authSalt: account.salt,
    kdfParams: TEST_KDF_PARAMS,
    authVerifier: account.authSecret,
    recoveryVerifier: account.recoveryVerifier,
    wrappedVaultKey: encryptBytes(kek, vaultKey, { context: 'vault-key:password', keyId }),
    wrappedVaultKeyRecovery: encryptBytes(recoveryWrappingKey, vaultKey, { context: 'vault-key:recovery', keyId }),
    encryptedProfile: encryptJson(
      vaultKey,
      { first_name: 'Test', last_name: 'User', profile_picture_blob_id: null },
      { context: 'profile', keyId }
    ),
    vaultKeyId: keyId,
    ...extra,
  });
  account.noteContent = (noteId, value, revision) =>
    encryptJson(vaultKey, value, { context: `note-content:${noteId}`, keyId, revision });
  account.noteSummary = (noteId, value) => encryptJson(vaultKey, value, { context: `note-summary:${noteId}`, keyId });
  return account;
}

export function docWithText(text, extraNodes = []) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...extraNodes],
  };
}
