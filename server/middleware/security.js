import helmet from 'helmet';
import { forbidden } from '../lib/errors.js';

// The vault key lives in browser memory, so script injection is key
// exfiltration; the CSP restricts execution to our own bundle.
// 'wasm-unsafe-eval' is required by the bundled Argon2 WASM, blob:/data:
// images by decrypted attachments. Fonts are self-hosted.
export function securityHeaders(config) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'blob:', 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Web-delivered E2EE is only as trustworthy as the delivered JavaScript,
    // so HTTPS must stick. Browsers ignore this header on plain HTTP.
    strictTransportSecurity:
      config.hstsMaxAgeSeconds > 0 ? { maxAge: config.hstsMaxAgeSeconds, includeSubDomains: false } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Defense in depth against cross-site request forgery: the session cookie is
// SameSite=Lax, but a sibling subdomain counts as same-site. Browsers report
// where a request came from; state-changing API requests must come from this
// origin (or an explicitly allowed CORS origin).
export function sameOriginWrites(config) {
  const allowed = new Set(config.corsOrigins);

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      return next();
    }

    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      return next();
    }

    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite) {
      if (fetchSite === 'same-origin' || fetchSite === 'none') {
        return next();
      }
      throw forbidden('Cross-site requests are not allowed', 'CROSS_SITE_REQUEST');
    }

    // Browsers without Fetch Metadata: fall back to comparing Origin with the
    // host the request was addressed to (directly or through a proxy).
    if (origin) {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        throw forbidden('Invalid Origin header', 'CROSS_SITE_REQUEST');
      }
      const hosts = [req.get('host'), req.get('x-forwarded-host')].filter(Boolean);
      if (!hosts.includes(originHost)) {
        throw forbidden('Cross-site requests are not allowed', 'CROSS_SITE_REQUEST');
      }
    }

    next();
  };
}
