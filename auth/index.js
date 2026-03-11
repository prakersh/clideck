const crypto = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { DATA_DIR } = require('../paths');
const { openDb } = require('../db');
const { hashPassword, verifyPassword } = require('./password');

const COOKIE_NAME = 'cd_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REVALIDATE_MS = 60 * 1000;
const INGRESS_HEADER = 'x-clideck-ingress';
const INGRESS_TOKEN_PATH = join(DATA_DIR, 'ingress-token');
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

function envFlag(name) {
  return TRUE_VALUES.has(String(process.env[name] || '').toLowerCase());
}

function requestProtocol(req) {
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwarded) return forwarded;
  return req?.socket?.encrypted ? 'https' : 'http';
}

function isLoopbackRequest(req) {
  const host = String(req?.headers?.host || '').trim().toLowerCase();
  if (LOOPBACK_HOST_RE.test(host)) return true;
  const remote = String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return remote === '127.0.0.1' || remote === '::1';
}

function getBootstrapCredentials() {
  const username = process.env.CLIDECK_USERNAME || process.env.USERNAME || 'admin';
  const password = process.env.CLIDECK_PASSWORD || process.env.PASSWORD || 'beegu';
  const explicit = Boolean(
    process.env.CLIDECK_USERNAME
    || process.env.USERNAME
    || process.env.CLIDECK_PASSWORD
    || process.env.PASSWORD
  );
  return { username, password, explicit };
}

function getBootstrapPolicy(req) {
  const credentials = getBootstrapCredentials();
  const publicMode = envFlag('CLIDECK_PUBLIC_MODE');
  const localFallbackAllowed = !publicMode && isLoopbackRequest(req);
  return {
    ...credentials,
    publicMode,
    localFallbackAllowed,
    allowed: credentials.explicit || localFallbackAllowed,
  };
}

function shouldUseSecureCookies(req) {
  return envFlag('CLIDECK_SECURE_COOKIES') || requestProtocol(req) === 'https';
}

function parseCookie(header = '') {
  const cookies = Object.create(null);
  for (const entry of header.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getIngressToken() {
  if (existsSync(INGRESS_TOKEN_PATH)) {
    return readFileSync(INGRESS_TOKEN_PATH, 'utf8').trim();
  }
  const token = crypto.randomBytes(32).toString('base64url');
  writeFileSync(INGRESS_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

function getSessionCookie(req) {
  return parseCookie(req.headers.cookie || '')[COOKIE_NAME] || null;
}

function hasUsers() {
  const db = openDb();
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

function getUserByUsername(username) {
  const db = openDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function createInitialUser(username, password) {
  const db = openDb();
  const now = Date.now();
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO users (id, username, password_hash, created_at, updated_at, must_change_password)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(user.id, user.username, user.passwordHash, user.createdAt, user.updatedAt);

  return { id: user.id, username: user.username };
}

function authenticateUser(username, password) {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, username: user.username };
}

function cleanupExpiredSessions() {
  const db = openDb();
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(Date.now());
}

function issueSession(userId) {
  const db = openDb();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  cleanupExpiredSessions();
  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(
    crypto.randomUUID(),
    userId,
    hashToken(token),
    now,
    now,
    expiresAt
  );

  return { token, expiresAt };
}

function validateSessionToken(token, { touch = true } = {}) {
  if (!token) return null;

  const db = openDb();
  const now = Date.now();
  const row = db.prepare(`
    SELECT
      auth_sessions.id AS session_id,
      auth_sessions.user_id,
      auth_sessions.created_at,
      auth_sessions.last_seen_at,
      auth_sessions.expires_at,
      users.username
    FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ?
      AND auth_sessions.revoked_at IS NULL
      AND auth_sessions.expires_at > ?
    LIMIT 1
  `).get(hashToken(token), now);

  if (!row) return null;

  const expiresAt = now + SESSION_TTL_MS;
  if (touch) {
    db.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = ?, expires_at = ?
      WHERE id = ?
    `).run(now, expiresAt, row.session_id);
  }

  return {
    sessionId: row.session_id,
    token,
    checkedAt: now,
    expiresAt: touch ? expiresAt : row.expires_at,
    user: {
      id: row.user_id,
      username: row.username,
    },
  };
}

function validateRequest(req, options) {
  return validateSessionToken(getSessionCookie(req), options);
}

function refreshSocketAuth(ws) {
  if (!ws.auth?.token) return null;
  const now = Date.now();
  if (ws.auth.checkedAt && now - ws.auth.checkedAt < SESSION_REVALIDATE_MS) {
    return ws.auth;
  }
  const nextAuth = validateSessionToken(ws.auth.token, { touch: true });
  if (!nextAuth) return null;
  ws.auth = nextAuth;
  return ws.auth;
}

function revokeSession(token) {
  if (!token) return;
  const db = openDb();
  db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').run(Date.now(), hashToken(token));
}

function setSessionCookie(res, token, req) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    expires: new Date(Date.now() + SESSION_TTL_MS),
    secure: shouldUseSecureCookies(req),
  }));
}

function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
    secure: shouldUseSecureCookies(req),
  }));
}

function getSessionResponse(req, { touch = true } = {}) {
  const session = validateRequest(req, { touch });
  const bootstrap = getBootstrapPolicy(req);
  if (!session) {
    return {
      authenticated: false,
      setupRequired: !hasUsers(),
      bootstrap,
      session: null,
    };
  }
  return {
    authenticated: true,
    setupRequired: false,
    bootstrap,
    session,
  };
}

function isTrustedIngressRequest(req) {
  const token = req.headers[INGRESS_HEADER];
  if (!token || typeof token !== 'string') return false;
  const expected = getIngressToken();
  const provided = Buffer.from(token, 'utf8');
  const valid = Buffer.from(expected, 'utf8');
  return provided.length === valid.length && crypto.timingSafeEqual(provided, valid);
}

module.exports = {
  COOKIE_NAME,
  INGRESS_HEADER,
  SESSION_TTL_MS,
  authenticateUser,
  clearSessionCookie,
  createInitialUser,
  getBootstrapPolicy,
  getIngressToken,
  getSessionCookie,
  getSessionResponse,
  hasUsers,
  isTrustedIngressRequest,
  issueSession,
  parseCookie,
  refreshSocketAuth,
  revokeSession,
  setSessionCookie,
  shouldUseSecureCookies,
  validateRequest,
  validateSessionToken,
};
