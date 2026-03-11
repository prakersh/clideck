const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { getCookie, postJson, startServer, stopServer } = require('../helpers/server');

let server;

function openSocket(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected response ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket message')), 2000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test.before(async () => {
  server = await startServer(4102, {
    env: { USERNAME: 'owner', PASSWORD: 'swordfish' },
  });
});

test.after(async () => {
  await stopServer(server);
});

test('websocket upgrades without an allowed origin are rejected', async () => {
  await assert.rejects(
    openSocket('ws://127.0.0.1:4102'),
    /403/
  );
});

test('websocket upgrades with a bad origin are rejected before auth', async () => {
  await assert.rejects(
    openSocket('ws://127.0.0.1:4102', { Origin: 'https://evil.example' }),
    /403/
  );
});

test('authenticated websocket upgrades with an allowed origin receive bootstrap payloads', async () => {
  const login = await postJson(server, '/auth/login', {
    username: 'owner',
    password: 'swordfish',
  });
  const cookie = getCookie(login);

  const ws = await openSocket('ws://127.0.0.1:4102', {
    Cookie: cookie,
    Origin: 'http://127.0.0.1:4102',
  });
  const firstMessage = await waitForMessage(ws);
  assert.equal(firstMessage.type, 'config');
  ws.close();
});
