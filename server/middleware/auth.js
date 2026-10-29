import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

// Load env here as well: this module can be evaluated before index.js runs
// dotenv.config(), and a missing secret must never fall back to a constant.
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Add it to server/.env, e.g.: JWT_SECRET=<output of `openssl rand -hex 32`>'
  );
}

export function authenticateToken(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export { JWT_SECRET };
