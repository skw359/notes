import { z } from 'zod';
import { badRequest } from './errors.js';

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
export const KEY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const ENVELOPE_ALGORITHM = 'AES-256-GCM';
export const MAX_DB_ID = 2147483647;

export function base64DecodedLength(value) {
  if (typeof value !== 'string' || !BASE64_RE.test(value)) {
    return -1;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function isBase64Url(value, { minLength = 1, maxLength = 512 } = {}) {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    BASE64URL_RE.test(value)
  );
}

export const idSchema = z.coerce.number().int().positive().max(MAX_DB_ID);
export const idListSchema = z.array(z.number().int().positive().max(MAX_DB_ID)).max(10000);

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Base64url of a 32-byte value (HKDF auth secret or recovery verifier).
export const verifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Expected a 32-byte base64url value');

export const saltSchema = z
  .string()
  .max(128)
  .refine((value) => {
    const length = base64DecodedLength(value);
    return length >= 16 && length <= 64;
  }, 'Expected a base64 salt of 16-64 bytes');

// Mirrors the client's downgrade guard: accounts can never be created or
// re-keyed with parameters a client would refuse to use.
export const kdfParamsSchema = z.strictObject({
  algorithm: z.literal('argon2id'),
  time: z.number().int().min(2).max(10),
  mem: z.number().int().min(19456).max(1048576),
  hashLen: z.literal(32),
  parallelism: z.number().int().min(1).max(4),
});

export const keyIdSchema = z.string().regex(KEY_ID_RE, 'Invalid key id');

const envelopeShape = z.strictObject({
  version: z.number().int(),
  algorithm: z.literal(ENVELOPE_ALGORITHM),
  context: z.string().max(256).optional(),
  keyId: keyIdSchema.optional(),
  revision: z.number().int().positive().optional(),
  iv: z.string().max(64),
  ciphertext: z.string(),
});

/**
 * Validates an encrypted envelope written by a client. The server cannot
 * check the ciphertext itself, but it can make sure the envelope is
 * well-formed and bound to the slot it is being stored in, so a stale or
 * buggy client cannot store something no client will be able to decrypt.
 */
export function parseEnvelope(
  value,
  { context, label = 'envelope', minVersion = 2, maxBytes = 1024 * 1024, exactBytes, revision, keyId } = {}
) {
  const result = envelopeShape.safeParse(value);
  if (!result.success) {
    throw badRequest(`Invalid ${label}`, 'INVALID_ENVELOPE', {
      issues: result.error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const envelope = result.data;
  if (envelope.version < minVersion || envelope.version > 3) {
    throw badRequest(`Unsupported ${label} version`, 'INVALID_ENVELOPE');
  }
  if (envelope.context !== context) {
    throw badRequest(`The ${label} is bound to a different context`, 'INVALID_ENVELOPE');
  }
  if (envelope.version === 3 && !envelope.keyId) {
    throw badRequest(`The ${label} is missing its key id`, 'INVALID_ENVELOPE');
  }
  if (envelope.version < 3 && (envelope.keyId !== undefined || envelope.revision !== undefined)) {
    throw badRequest(`Unexpected fields in ${label}`, 'INVALID_ENVELOPE');
  }
  if (base64DecodedLength(envelope.iv) !== 12) {
    throw badRequest(`The ${label} IV must be 12 bytes`, 'INVALID_ENVELOPE');
  }

  const ciphertextBytes = base64DecodedLength(envelope.ciphertext);
  if (ciphertextBytes < 16) {
    throw badRequest(`The ${label} ciphertext is malformed`, 'INVALID_ENVELOPE');
  }
  if (exactBytes !== undefined && ciphertextBytes !== exactBytes) {
    throw badRequest(`The ${label} has an unexpected length`, 'INVALID_ENVELOPE');
  }
  if (ciphertextBytes > maxBytes) {
    throw badRequest(`The ${label} is too large`, 'PAYLOAD_TOO_LARGE', { limit: maxBytes });
  }
  if (revision !== undefined && envelope.version === 3 && envelope.revision !== revision) {
    throw badRequest(`The ${label} is bound to a different revision`, 'INVALID_ENVELOPE');
  }
  if (keyId && envelope.version === 3 && envelope.keyId !== keyId) {
    throw badRequest(`The ${label} was encrypted with a retired key`, 'KEY_ROTATED');
  }

  return envelope;
}

export const CONTEXTS = {
  vaultKeyPassword: 'vault-key:password',
  vaultKeyRecovery: 'vault-key:recovery',
  profile: 'profile',
  noteContent: (noteId) => `note-content:${noteId}`,
  noteSummary: (noteId) => `note-summary:${noteId}`,
  keyring: (keyId) => `vault-keyring:${keyId}`,
};

// A wrapped vault key is the 32-byte key plus the 16-byte GCM tag.
export const WRAPPED_KEY_BYTES = 48;

export function parseWrappedKey(value, context, label) {
  return parseEnvelope(value, { context, label, exactBytes: WRAPPED_KEY_BYTES });
}

export function parseProfileEnvelope(value) {
  return parseEnvelope(value, { context: CONTEXTS.profile, label: 'encrypted profile', maxBytes: 64 * 1024 });
}

export function parseBody(schema, body) {
  return schema.parse(body ?? {});
}
