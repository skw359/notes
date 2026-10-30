import jwt from 'jsonwebtoken';
import { hmacBase64url, randomToken, sha256Hex } from './crypto.js';

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const SESSION_COLUMNS = `
  s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.absolute_expires_at,
  s.revoked_at, s.origin, u.email, u.auth_mode
`;

export function sessionCookieOptions(config, req, expiresAt) {
  const secure = config.cookie.secure === 'auto' ? Boolean(req.secure) : config.cookie.secure === 'true';
  const maxAge = expiresAt
    ? Math.max(0, new Date(expiresAt).getTime() - Date.now())
    : config.sessions.idleMs;
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge };
}

export function setSessionCookie(res, req, config, token, expiresAt) {
  res.cookie(config.cookie.name, token, sessionCookieOptions(config, req, expiresAt));
}

export function clearSessionCookie(res, req, config) {
  const { httpOnly, secure, sameSite, path } = sessionCookieOptions(config, req);
  res.clearCookie(config.cookie.name, { httpOnly, secure, sameSite, path });
}

function describeRequest(req) {
  return {
    userAgent: String(req.get?.('user-agent') || '').slice(0, 300) || null,
    ip: req.ip || null,
  };
}

export function createSessionManager({ pool, config }) {
  const { idleMs, absoluteMs, renewAfterMs } = config.sessions;

  async function create(userId, req, { origin, db = pool } = {}) {
    const token = randomToken(32);
    const id = sha256Hex(token);
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + absoluteMs);
    const expiresAt = new Date(Math.min(now + idleMs, absoluteExpiresAt.getTime()));
    const { userAgent, ip } = describeRequest(req);

    await db.query(
      `
        INSERT INTO sessions (id, user_id, expires_at, absolute_expires_at, origin, user_agent, ip)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [id, userId, expiresAt, absoluteExpiresAt, origin, userAgent, ip]
    );

    return { token, id, expiresAt };
  }

  async function findActive(id) {
    const result = await pool.query(
      `SELECT ${SESSION_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [id]
    );
    const session = result.rows[0];
    if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) {
      return null;
    }
    return session;
  }

  // Sliding expiry, written at most once per renewAfterMs per session.
  async function touch(session) {
    const now = Date.now();
    if (now - session.last_seen_at.getTime() < renewAfterMs) {
      return false;
    }

    const expiresAt = new Date(Math.min(now + idleMs, session.absolute_expires_at.getTime()));
    await pool.query(
      'UPDATE sessions SET last_seen_at = NOW(), expires_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [session.id, expiresAt]
    );
    session.last_seen_at = new Date(now);
    session.expires_at = expiresAt;
    return true;
  }

  // Pre-2.0 cookies carried a stateless 7-day JWT. Each one maps
  // deterministically onto a server-side session, so tabs that were open
  // during the upgrade keep saving, but the JWT becomes revocable: logging out
  // revokes the mapped session, so replaying the same JWT afterwards fails.
  // JWTs issued before a "sign out everywhere" are refused outright.
  async function convertLegacyJwt(token, req) {
    let claims;
    try {
      claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return null;
    }
    if (!Number.isInteger(claims?.id) || !claims.iat || !claims.exp) {
      return null;
    }

    const userResult = await pool.query('SELECT id, sessions_revoked_before FROM users WHERE id = $1', [
      claims.id,
    ]);
    const user = userResult.rows[0];
    if (!user) {
      return null;
    }

    const issuedAt = new Date(claims.iat * 1000);
    if (user.sessions_revoked_before && issuedAt <= user.sessions_revoked_before) {
      return null;
    }

    const sessionToken = hmacBase64url(config.jwtSecret, `legacy-session:${token}`);
    const id = sha256Hex(sessionToken);
    const expiresAt = new Date(claims.exp * 1000);
    const { userAgent, ip } = describeRequest(req);

    await pool.query(
      `
        INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, origin, user_agent, ip)
        VALUES ($1, $2, $3, NOW(), $4, $4, 'legacy-jwt', $5, $6)
        ON CONFLICT (id) DO NOTHING
      `,
      [id, user.id, issuedAt, expiresAt, userAgent, ip]
    );

    const session = await findActive(id);
    return session ? { token: sessionToken, session, renewed: true } : null;
  }

  async function resolve(token, req) {
    if (typeof token !== 'string') {
      return null;
    }
    if (JWT_RE.test(token)) {
      return convertLegacyJwt(token, req);
    }
    if (!SESSION_TOKEN_RE.test(token)) {
      return null;
    }

    const session = await findActive(sha256Hex(token));
    if (!session) {
      return null;
    }
    const renewed = await touch(session);
    return { token, session, renewed };
  }

  async function revoke(sessionId, { userId, db = pool } = {}) {
    const result = await db.query(
      `
        UPDATE sessions SET revoked_at = NOW()
        WHERE id = $1 AND revoked_at IS NULL AND ($2::int IS NULL OR user_id = $2)
        RETURNING id
      `,
      [sessionId, userId ?? null]
    );
    return result.rowCount > 0;
  }

  // Also refuses every pre-2.0 JWT issued so far.
  async function revokeAllForUser(userId, { exceptSessionId = null, db = pool } = {}) {
    const result = await db.query(
      `
        UPDATE sessions SET revoked_at = NOW()
        WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)
      `,
      [userId, exceptSessionId]
    );
    await db.query('UPDATE users SET sessions_revoked_before = NOW() WHERE id = $1', [userId]);
    return result.rowCount;
  }

  async function list(userId) {
    const result = await pool.query(
      `
        SELECT id, created_at, last_seen_at, expires_at, origin, user_agent, ip
        FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY last_seen_at DESC
      `,
      [userId]
    );
    return result.rows;
  }

  return { create, resolve, revoke, revokeAllForUser, list };
}
