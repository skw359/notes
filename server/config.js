import path from 'path';
import { fileURLToPath } from 'url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MIB = 1024 * 1024;

function readString(env, name, fallback = '') {
  const raw = env[name];
  return raw === undefined || raw === null || raw === '' ? fallback : String(raw).trim();
}

function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = readString(env, name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function readBool(env, name, fallback) {
  const raw = readString(env, name).toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(raw)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

function readEnum(env, name, allowed, fallback) {
  const raw = readString(env, name, fallback).toLowerCase();
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw;
}

function readList(env, name) {
  return readString(env, name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Express accepts booleans, hop counts, or named/CIDR subnets for `trust proxy`.
function readTrustProxy(env) {
  const raw = readString(env, 'TRUST_PROXY');
  if (!raw || raw === 'false') {
    return false;
  }
  if (raw === 'true') {
    return true;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function resolveDir(env, name, fallback) {
  const raw = readString(env, name);
  return raw ? path.resolve(SERVER_DIR, raw) : fallback;
}

export function loadConfig(env = process.env) {
  const jwtSecret = readString(env, 'JWT_SECRET');
  if (!jwtSecret) {
    throw new Error(
      'JWT_SECRET is not set. Add it to server/.env, e.g.: JWT_SECRET=<output of `openssl rand -hex 32`>'
    );
  }

  const signupMode = readEnum(env, 'SIGNUP_MODE', ['open', 'invite', 'closed'], 'open');
  const inviteCode = readString(env, 'SIGNUP_INVITE_CODE');
  if (signupMode === 'invite' && inviteCode.length < 8) {
    throw new Error('SIGNUP_MODE=invite requires SIGNUP_INVITE_CODE (at least 8 characters)');
  }

  const storageRoot = resolveDir(env, 'STORAGE_ROOT', path.join(SERVER_DIR, 'storage'));

  return {
    nodeEnv: readString(env, 'NODE_ENV', 'development'),
    port: readInt(env, 'PORT', 3004, { min: 1, max: 65535 }),
    host: readString(env, 'HOST'),
    db: {
      connectionString: readString(env, 'DATABASE_URL') || undefined,
      user: readString(env, 'DB_USER', 'postgres'),
      host: readString(env, 'DB_HOST', 'localhost'),
      database: readString(env, 'DB_NAME', 'notes_app'),
      password: env.DB_PASSWORD,
      port: readInt(env, 'DB_PORT', 5432, { min: 1, max: 65535 }),
      maxConnections: readInt(env, 'DB_POOL_SIZE', 10, { min: 1, max: 200 }),
    },
    jwtSecret,
    cookie: {
      name: 'token',
      // 'true' (default) always marks the session cookie Secure; 'auto' follows
      // req.secure (needs TRUST_PROXY behind a TLS proxy); 'false' is for plain
      // HTTP development only.
      secure: readEnum(env, 'COOKIE_SECURE', ['true', 'false', 'auto'], 'true'),
    },
    trustProxy: readTrustProxy(env),
    corsOrigins: readList(env, 'CORS_ORIGINS'),
    hstsMaxAgeSeconds: readInt(env, 'HSTS_MAX_AGE', 15552000, { min: 0 }),
    signup: {
      mode: signupMode,
      inviteCode,
    },
    storage: {
      // Defaults match the pre-2.0 layout so existing installs keep working.
      blobsDir: resolveDir(env, 'STORAGE_DIR', path.join(storageRoot, 'blobs')),
      deletedBlobsDir: resolveDir(env, 'DELETED_BLOBS_DIR', path.join(storageRoot, 'deleted')),
      legacyUploadsDir: resolveDir(env, 'LEGACY_UPLOADS_DIR', path.join(SERVER_DIR, 'uploads')),
      legacyQuarantineDir: resolveDir(
        env,
        'LEGACY_QUARANTINE_DIR',
        path.join(storageRoot, 'legacy-quarantine')
      ),
    },
    limits: {
      maxBlobBytes: readInt(env, 'MAX_BLOB_BYTES', 25 * MIB, { min: 1024 }),
      // 0 disables the quota.
      userQuotaBytes: readInt(env, 'USER_STORAGE_QUOTA_BYTES', 2048 * MIB, { min: 0 }),
      maxNotesPerUser: readInt(env, 'MAX_NOTES_PER_USER', 100000, { min: 1 }),
      noteMaxBytes: readInt(env, 'NOTE_MAX_BYTES', 8 * MIB, { min: 64 * 1024 }),
      notesBodyBytes: readInt(env, 'NOTES_BODY_LIMIT_BYTES', 12 * MIB, { min: 64 * 1024 }),
      authBodyBytes: readInt(env, 'AUTH_BODY_LIMIT_BYTES', 64 * 1024, { min: 4096 }),
      defaultBodyBytes: readInt(env, 'DEFAULT_BODY_LIMIT_BYTES', 256 * 1024, { min: 4096 }),
      batchMaxIds: 100,
      maxRevisionsPerNote: readInt(env, 'MAX_REVISIONS_PER_NOTE', 30, { min: 1, max: 1000 }),
    },
    sessions: {
      idleMs: readInt(env, 'SESSION_IDLE_DAYS', 14, { min: 1, max: 365 }) * DAY_MS,
      absoluteMs: readInt(env, 'SESSION_MAX_DAYS', 90, { min: 1, max: 3650 }) * DAY_MS,
      renewAfterMs: HOUR_MS,
    },
    retention: {
      trashMs: readInt(env, 'TRASH_RETENTION_DAYS', 30, { min: 1 }) * DAY_MS,
      blobGraceMs: readInt(env, 'BLOB_GC_GRACE_DAYS', 30, { min: 1 }) * DAY_MS,
      deletedFilesMs: readInt(env, 'DELETED_FILES_RETENTION_DAYS', 7, { min: 0 }) * DAY_MS,
      legacyQuarantineMs: readInt(env, 'LEGACY_QUARANTINE_DAYS', 30, { min: 0 }) * DAY_MS,
      pendingNoteMs: DAY_MS,
      revisionMaxAgeMs: readInt(env, 'REVISION_MAX_AGE_DAYS', 365, { min: 1 }) * DAY_MS,
      snapshotIntervalMs: readInt(env, 'SNAPSHOT_INTERVAL_MINUTES', 10, { min: 1 }) * MINUTE_MS,
      sessionsMs: 30 * DAY_MS,
    },
    rateLimits: {
      enabled: readBool(env, 'RATE_LIMITS', true),
      windowMs: 15 * MINUTE_MS,
      preloginPerIp: readInt(env, 'RATE_LIMIT_PRELOGIN', 60, { min: 1 }),
      loginPerIp: readInt(env, 'RATE_LIMIT_LOGIN_IP', 30, { min: 1 }),
      loginFailuresPerAccount: readInt(env, 'RATE_LIMIT_LOGIN_ACCOUNT', 20, { min: 1 }),
      signupPerIpPerHour: readInt(env, 'RATE_LIMIT_SIGNUP', 10, { min: 1 }),
      recoverPerIp: readInt(env, 'RATE_LIMIT_RECOVER', 10, { min: 1 }),
      sensitivePerUser: readInt(env, 'RATE_LIMIT_SENSITIVE', 10, { min: 1 }),
      apiPerMinute: readInt(env, 'RATE_LIMIT_API_PER_MINUTE', 1200, { min: 10 }),
    },
    jobs: {
      enabled: readBool(env, 'BACKGROUND_JOBS', true),
      intervalMs: readInt(env, 'MAINTENANCE_INTERVAL_MINUTES', 60, { min: 1 }) * MINUTE_MS,
    },
  };
}
