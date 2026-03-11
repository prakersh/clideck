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

test('first login bootstraps the admin account and sets a 7-day cookie', async () => {
  const meBefore = await get(server, '/auth/me');
  assert.equal(meBefore.status, 401);
  assert.deepEqual(await meBefore.json(), {
    authenticated: false,
    setupRequired: true,
  });

  const login = await postJson(server, '/auth/login', {
    username: 'admin',
    password: 'very-secure-password',
  });
  assert.equal(login.status, 200);

  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /cd_session=/);
  assert.match(cookieHeader, /Max-Age=604800/);
  assert.match(cookieHeader, /HttpOnly/);

  const cookie = getCookie(login);
  const me = await get(server, '/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(me.status, 200);
  const payload = await me.json();
  assert.equal(payload.authenticated, true);
  assert.equal(payload.user.username, 'admin');
});

test('logout revokes the cookie and ingress token is persisted locally', async () => {
  const login = await postJson(server, '/auth/login', {
    username: 'admin',
    password: 'very-secure-password',
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
