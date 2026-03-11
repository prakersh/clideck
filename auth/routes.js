const {
  authenticateUser,
  clearSessionCookie,
  createInitialUser,
  getSessionCookie,
  getSessionResponse,
  hasUsers,
  issueSession,
  revokeSession,
  setSessionCookie,
} = require('./index');

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

  if (!username || username.length < 3) return { error: 'Username must be at least 3 characters.' };
  if (!password || password.length < 10) return { error: 'Password must be at least 10 characters.' };
  return { username, password };
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

  const bootstrap = !hasUsers();
  const user = bootstrap
    ? createInitialUser(validated.username, validated.password)
    : authenticateUser(validated.username, validated.password);

  if (!user) {
    return sendJson(res, 401, { error: 'Invalid username or password.', setupRequired: false });
  }

  const session = issueSession(user.id);
  setSessionCookie(res, session.token);
  sendJson(res, 200, {
    authenticated: true,
    setupRequired: false,
    bootstrap,
    user: { id: user.id, username: user.username },
  });
}

function handleLogout(req, res) {
  revokeSession(getSessionCookie(req));
  clearSessionCookie(res);
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

  setSessionCookie(res, auth.session.token);
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
