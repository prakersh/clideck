const {
  authenticateUser,
  clearSessionCookie,
  createInitialUser,
  getBootstrapPolicy,
  getSessionCookie,
  getSessionResponse,
  hasUsers,
  issueSession,
  revokeSession,
  setSessionCookie,
} = require('./index');

const LOGIN_WINDOW_MS = Number(process.env.CLIDECK_LOGIN_WINDOW_MS || 10 * 60 * 1000);
const LOGIN_LOCKOUT_MS = Number(process.env.CLIDECK_LOGIN_LOCKOUT_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.CLIDECK_LOGIN_MAX_ATTEMPTS || 5);
const loginAttempts = new Map();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function validateCredentials(payload) {
  const username = typeof payload.username === 'string' ? payload.username.trim() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!username || username.length > 128) return { error: 'Username is required.' };
  if (!password) return { error: 'Password is required.' };
  return { username, password };
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || 'unknown');
}

function getThrottleKey(req, username) {
  return `${getClientIp(req)}:${String(username || '').trim().toLowerCase()}`;
}

function compactAttempts(now = Date.now()) {
  for (const [key, state] of loginAttempts.entries()) {
    state.failures = state.failures.filter(ts => now - ts <= LOGIN_WINDOW_MS);
    if (state.lockedUntil && state.lockedUntil <= now) state.lockedUntil = 0;
    if (!state.failures.length && !state.lockedUntil) loginAttempts.delete(key);
  }
}

function getAttemptState(req, username, now = Date.now()) {
  compactAttempts(now);
  const key = getThrottleKey(req, username);
  const state = loginAttempts.get(key) || { failures: [], lockedUntil: 0 };
  return { key, state };
}

function isRateLimited(req, username, now = Date.now()) {
  const { state } = getAttemptState(req, username, now);
  if (!state.lockedUntil || state.lockedUntil <= now) return null;
  return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
}

function registerFailedAttempt(req, username, now = Date.now()) {
  const { key, state } = getAttemptState(req, username, now);
  state.failures.push(now);
  state.failures = state.failures.filter(ts => now - ts <= LOGIN_WINDOW_MS);
  if (state.failures.length >= LOGIN_MAX_ATTEMPTS) {
    state.lockedUntil = now + LOGIN_LOCKOUT_MS;
    state.failures = [];
  }
  loginAttempts.set(key, state);
}

function clearFailedAttempts(req, username) {
  loginAttempts.delete(getThrottleKey(req, username));
}

async function handleLogin(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const validated = validateCredentials(payload);
  if (validated.error) return sendJson(res, 400, { error: validated.error });

  const retryAfter = isRateLimited(req, validated.username);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return sendJson(res, 429, {
      error: 'Too many login attempts. Try again later.',
      setupRequired: !hasUsers(),
    });
  }

  const bootstrap = !hasUsers();
  let user = null;
  if (bootstrap) {
    const bootstrapPolicy = getBootstrapPolicy(req);
    if (!bootstrapPolicy.allowed) {
      return sendJson(res, 503, {
        error: 'Bootstrap credentials must be configured before first public login.',
        setupRequired: true,
      });
    }
    if (
      validated.username !== bootstrapPolicy.username
      || validated.password !== bootstrapPolicy.password
    ) {
      registerFailedAttempt(req, validated.username);
      return sendJson(res, 401, {
        error: 'Invalid bootstrap credentials.',
        setupRequired: true,
      });
    }
    user = createInitialUser(bootstrapPolicy.username, bootstrapPolicy.password);
  } else {
    user = authenticateUser(validated.username, validated.password);
  }

  if (!user) {
    registerFailedAttempt(req, validated.username);
    return sendJson(res, 401, { error: 'Invalid username or password.', setupRequired: false });
  }

  clearFailedAttempts(req, validated.username);
  const session = issueSession(user.id);
  setSessionCookie(res, session.token, req);
  sendJson(res, 200, {
    authenticated: true,
    setupRequired: false,
    bootstrap,
    user: { id: user.id, username: user.username },
  });
}

function handleLogout(req, res) {
  revokeSession(getSessionCookie(req));
  clearSessionCookie(res, req);
  res.writeHead(204);
  res.end();
}

function handleMe(req, res) {
  const auth = getSessionResponse(req, { touch: true });
  if (!auth.authenticated) {
    return sendJson(res, 401, {
      authenticated: false,
      setupRequired: auth.setupRequired,
    });
  }

  setSessionCookie(res, auth.session.token, req);
  sendJson(res, 200, {
    authenticated: true,
    setupRequired: false,
    user: auth.session.user,
  });
}

async function handleAuthRoute(req, res) {
  const path = req.url.split('?')[0];

  if (req.method === 'POST' && path === '/auth/login') {
    await handleLogin(req, res);
    return true;
  }

  if (req.method === 'POST' && path === '/auth/logout') {
    handleLogout(req, res);
    return true;
  }

  if (req.method === 'GET' && path === '/auth/me') {
    handleMe(req, res);
    return true;
  }

  return false;
}

module.exports = { handleAuthRoute };
