const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const REPO_ROOT = join(__dirname, '..', '..');

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
      if (res.status === 200 || res.status === 302) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Server did not become ready at ${baseUrl}`);
}

async function startServer(port, options = {}) {
  const home = options.home || await mkdtemp(join(os.tmpdir(), 'clideck-auth-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLIDECK_HOST: '127.0.0.1',
      CLIDECK_PORT: String(port),
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.once('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(stdout);
      console.error(stderr);
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);

  return {
    baseUrl,
    child,
    home,
    preserveHome: !!options.home,
    logs() {
      return { stdout, stderr };
    },
  };
}

async function stopServer(server) {
  if (server.child.exitCode == null) {
    server.child.kill('SIGTERM');
    await delay(250);
    if (server.child.exitCode == null) server.child.kill('SIGKILL');
  }
  if (!server.preserveHome) await rm(server.home, { recursive: true, force: true });
}

async function postJson(server, path, body, options = {}) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body),
  });
}

async function get(server, path, options = {}) {
  return fetch(`${server.baseUrl}${path}`, {
    redirect: 'manual',
    ...options,
  });
}

function getCookie(res) {
  const header = res.headers.get('set-cookie');
  assert.ok(header, 'expected Set-Cookie header');
  return header.split(';', 1)[0];
}

module.exports = { get, getCookie, postJson, startServer, stopServer };
