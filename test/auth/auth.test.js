const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { get, getCookie, postJson, startServer, stopServer } = require('../helpers/server');

let server;

test.before(async () => {
  server = await startServer(4101);
});

test.after(async () => {
  await stopServer(server);
});

test('root redirects unauthenticated clients to /login', async () => {
  const res = await get(server, '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('local bootstrap only accepts deterministic default credentials', async () => {
  const meBefore = await get(server, '/auth/me');
  assert.equal(meBefore.status, 401);
  assert.deepEqual(await meBefore.json(), {
    authenticated: false,
    setupRequired: true,
  });

  const rejected = await postJson(server, '/auth/login', {
    username: 'admin',
    password: 'very-secure-password',
  });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).setupRequired, true);

  const login = await postJson(server, '/auth/login', {
    username: 'admin',
    password: 'beegu',
  });
  assert.equal(login.status, 200);

  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /cd_session=/);
  assert.match(cookieHeader, /Max-Age=604800/);
  assert.match(cookieHeader, /HttpOnly/);
  assert.doesNotMatch(cookieHeader, /Secure/);

  const cookie = getCookie(login);
  const me = await get(server, '/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(me.status, 200);
  const payload = await me.json();
  assert.equal(payload.authenticated, true);
  assert.equal(payload.user.username, 'admin');
});

test('security headers and plugin auth gate are applied', async () => {
  const loginPage = await get(server, '/login');
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(loginPage.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(loginPage.headers.get('x-frame-options'), 'DENY');
  assert.equal(loginPage.headers.get('referrer-policy'), 'no-referrer');

  const pluginDenied = await get(server, '/plugins/voice-input/client.js');
  assert.equal(pluginDenied.status, 401);

  const login = await postJson(server, '/auth/login', {
    username: 'admin',
    password: 'beegu',
  });
  const cookie = getCookie(login);
  const pluginAllowed = await get(server, '/plugins/voice-input/client.js', {
    headers: { Cookie: cookie },
  });
  assert.equal(pluginAllowed.status, 200);
  assert.match(await pluginAllowed.text(), /export function init/);
});

test('logout revokes the cookie and ingress token is persisted locally', async () => {
  const login = await postJson(server, '/auth/login', {
    username: 'admin',
    password: 'beegu',
  });
  const cookie = getCookie(login);

  const logout = await fetch(`${server.baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);

  const me = await get(server, '/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(me.status, 401);

  const ingressToken = await readFile(join(server.home, '.clideck', 'ingress-token'), 'utf8');
  assert.ok(ingressToken.trim().length > 20);
});

test('ingest endpoints require the local shared secret header', async () => {
  const denied = await fetch(`${server.baseUrl}/v1/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceLogs: [] }),
  });
  assert.equal(denied.status, 401);

  const ingressToken = (await readFile(join(server.home, '.clideck', 'ingress-token'), 'utf8')).trim();
  const allowed = await fetch(`${server.baseUrl}/v1/logs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clideck-ingress': ingressToken,
    },
    body: JSON.stringify({ resourceLogs: [] }),
  });
  assert.equal(allowed.status, 200);
});

test('public mode requires explicit bootstrap credentials', async () => {
  const isolated = await startServer(4103, {
    env: { CLIDECK_PUBLIC_MODE: '1' },
  });
  try {
    const login = await postJson(isolated, '/auth/login', {
      username: 'admin',
      password: 'beegu',
    });
    assert.equal(login.status, 503);
    assert.match((await login.json()).error, /Bootstrap credentials must be configured/);
  } finally {
    await stopServer(isolated);
  }
});

test('explicit bootstrap env overrides the local fallback and secure cookies can be forced', async () => {
  const isolated = await startServer(4104, {
    env: {
      USERNAME: 'owner',
      PASSWORD: 'swordfish',
      CLIDECK_SECURE_COOKIES: '1',
    },
  });
  try {
    const denied = await postJson(isolated, '/auth/login', {
      username: 'admin',
      password: 'beegu',
    });
    assert.equal(denied.status, 401);

    const login = await postJson(isolated, '/auth/login', {
      username: 'owner',
      password: 'swordfish',
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') || '', /Secure/);
  } finally {
    await stopServer(isolated);
  }
});

test('login rate limiting temporarily locks repeated failures', async () => {
  const isolated = await startServer(4105, {
    env: {
      USERNAME: 'owner',
      PASSWORD: 'swordfish',
      CLIDECK_LOGIN_MAX_ATTEMPTS: '2',
      CLIDECK_LOGIN_LOCKOUT_MS: '300',
      CLIDECK_LOGIN_WINDOW_MS: '1000',
    },
  });
  try {
    const fail1 = await postJson(isolated, '/auth/login', {
      username: 'owner',
      password: 'wrong',
    });
    assert.equal(fail1.status, 401);

    const fail2 = await postJson(isolated, '/auth/login', {
      username: 'owner',
      password: 'wrong-again',
    });
    assert.equal(fail2.status, 401);

    const limited = await postJson(isolated, '/auth/login', {
      username: 'owner',
      password: 'swordfish',
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    await new Promise(resolve => setTimeout(resolve, 350));
    const recovered = await postJson(isolated, '/auth/login', {
      username: 'owner',
      password: 'swordfish',
    });
    assert.equal(recovered.status, 200);
  } finally {
    await stopServer(isolated);
  }
});
