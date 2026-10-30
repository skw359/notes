import { unauthorized } from '../lib/errors.js';
import { clearSessionCookie, setSessionCookie } from '../lib/sessions.js';

function attachSession(req, resolved) {
  const { session } = resolved;
  req.user = { id: session.user_id, email: session.email, authMode: session.auth_mode };
  req.session = { id: session.id, createdAt: session.created_at, expiresAt: session.expires_at };
}

// Resolves the session cookie once per request and puts the user, including
// their auth mode, on the request (no extra auth_mode query per handler).
export function createSessionMiddleware({ sessions, config }) {
  async function resolveFromCookie(req, res) {
    const token = req.cookies?.[config.cookie.name];
    if (!token) {
      return { status: 'missing' };
    }

    const resolved = await sessions.resolve(token, req);
    if (!resolved) {
      clearSessionCookie(res, req, config);
      return { status: 'invalid' };
    }

    if (resolved.token !== token || resolved.renewed) {
      setSessionCookie(res, req, config, resolved.token, resolved.session.expires_at);
    }
    attachSession(req, resolved);
    return { status: 'ok' };
  }

  async function requireSession(req, res, next) {
    const { status } = await resolveFromCookie(req, res);
    if (status === 'missing') {
      throw unauthorized('Authentication required', 'AUTH_REQUIRED');
    }
    if (status === 'invalid') {
      throw unauthorized('Your session has expired. Sign in again to continue.', 'SESSION_EXPIRED');
    }
    next();
  }

  async function optionalSession(req, res, next) {
    await resolveFromCookie(req, res);
    next();
  }

  return { requireSession, optionalSession };
}
