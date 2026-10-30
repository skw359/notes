import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

function passthrough(req, res, next) {
  next();
}

function normalizedEmail(req) {
  const email = req.body?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
}

// SEC-5: per-IP and per-account limits on the unauthenticated auth endpoints,
// per-user limits on sensitive and general API calls. Behind a reverse proxy,
// set TRUST_PROXY so req.ip is the client rather than the proxy.
export function createLimiters(config) {
  const settings = config.rateLimits;
  const names = [
    'prelogin',
    'loginIp',
    'loginAccount',
    'signup',
    'recoverIp',
    'recoverAccount',
    'sensitive',
    'api',
  ];

  if (!settings.enabled) {
    return Object.fromEntries(names.map((name) => [name, passthrough]));
  }

  function make({ windowMs, limit, keyGenerator, skipSuccessfulRequests = false }) {
    return rateLimit({
      windowMs,
      limit,
      keyGenerator,
      skipSuccessfulRequests,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler(req, res, next, options) {
        res.status(options.statusCode).json({
          error: 'Too many requests. Please wait and try again.',
          code: 'RATE_LIMITED',
          retryAfterSeconds: Math.ceil(options.windowMs / 1000),
        });
      },
    });
  }

  const byIp = (req) => ipKeyGenerator(req.ip || '');
  const byAccount = (req) => `account:${normalizedEmail(req)}`;
  const byUser = (req) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip || ''));
  const windowMs = settings.windowMs;

  return {
    prelogin: make({ windowMs, limit: settings.preloginPerIp, keyGenerator: byIp }),
    loginIp: make({ windowMs, limit: settings.loginPerIp, keyGenerator: byIp }),
    // Counts failures only, so the owner is not locked out by their own logins.
    loginAccount: make({
      windowMs,
      limit: settings.loginFailuresPerAccount,
      keyGenerator: byAccount,
      skipSuccessfulRequests: true,
    }),
    signup: make({ windowMs: 60 * 60 * 1000, limit: settings.signupPerIpPerHour, keyGenerator: byIp }),
    recoverIp: make({ windowMs, limit: settings.recoverPerIp, keyGenerator: byIp }),
    recoverAccount: make({
      windowMs,
      limit: settings.recoverPerIp,
      keyGenerator: byAccount,
      skipSuccessfulRequests: true,
    }),
    sensitive: make({ windowMs, limit: settings.sensitivePerUser, keyGenerator: byUser }),
    api: make({ windowMs: 60 * 1000, limit: settings.apiPerMinute, keyGenerator: byUser }),
  };
}
