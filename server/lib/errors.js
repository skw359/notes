import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, code = 'BAD_REQUEST', details) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'AUTH_REQUIRED') =>
  new HttpError(401, code, message);
export const forbidden = (message, code = 'FORBIDDEN', details) => new HttpError(403, code, message, details);
export const notFound = (message = 'Not found', code = 'NOT_FOUND', details) =>
  new HttpError(404, code, message, details);
export const conflict = (message, code = 'CONFLICT', details) => new HttpError(409, code, message, details);
export const payloadTooLarge = (message, code = 'PAYLOAD_TOO_LARGE', details) =>
  new HttpError(413, code, message, details);

function summarizeZodError(error) {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

// PostgreSQL error codes that are the client's fault rather than ours.
function mapDatabaseError(error) {
  switch (error.code) {
    case '23505':
      return new HttpError(409, 'CONFLICT', 'That value is already in use');
    case '22P02':
    case '22003':
      return new HttpError(400, 'BAD_REQUEST', 'Invalid identifier or value');
    case '23514':
      // Raised by the notes write guard (plaintext for an encrypted account,
      // or erasing ciphertext): the client is out of date.
      if (error.constraint === 'notes_e2ee_no_plaintext' || error.constraint === 'notes_keep_ciphertext') {
        return new HttpError(
          409,
          'CLIENT_OUTDATED',
          'This account is end-to-end encrypted. Reload the app to continue.'
        );
      }
      return new HttpError(400, 'BAD_REQUEST', 'The request violates a data constraint');
    case '40P01':
    case '40001':
      return new HttpError(503, 'RETRY', 'The server was busy. Please retry.');
    default:
      return null;
  }
}

export function toHttpError(error) {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof ZodError) {
    return new HttpError(400, 'VALIDATION_FAILED', 'Invalid request', { issues: summarizeZodError(error) });
  }
  // body-parser errors
  if (error?.type === 'entity.too.large') {
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large', { limit: error.limit });
  }
  if (error?.type === 'entity.parse.failed') {
    return new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (error?.type === 'encoding.unsupported' || error?.type === 'charset.unsupported') {
    return new HttpError(415, 'UNSUPPORTED_ENCODING', 'Unsupported request encoding');
  }
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    return mapDatabaseError(error);
  }
  return null;
}

export function apiNotFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

// Central error handler: client errors become 4xx with a stable `code`, and
// everything else is logged and reported as a generic 500 without internals.
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    req.socket?.destroy();
    return;
  }

  const httpError = toHttpError(error);
  if (httpError) {
    if (httpError.status >= 500) {
      console.error(`[${req.method} ${req.originalUrl}]`, error);
    }
    res.status(httpError.status).json({
      error: httpError.message,
      code: httpError.code,
      ...(httpError.details || {}),
    });
    return;
  }

  console.error(`[${req.method} ${req.originalUrl}] Unhandled error:`, error);
  res.status(500).json({ error: 'Server error', code: 'INTERNAL' });
}
