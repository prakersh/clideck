const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, resolve } = require('path');
const { WebSocketServer } = require('ws');
const { openDb, closeDb } = require('./db');
const { handleAuthRoute } = require('./auth/routes');
const {
  getIngressToken,
  getSessionResponse,
  isTrustedIngressRequest,
  setSessionCookie,
} = require('./auth');
const { ensurePtyHelper } = require('./utils');
const sessions = require('./sessions');

const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const plugins = require('./plugin-loader');

ensurePtyHelper();
openDb();
getIngressToken();
const { onConnection, getConfig } = require('./handlers');
sessions.loadSessions();
transcript.init(sessions.broadcast, new Set(sessions.getResumable().map(s => s.id)));
telemetry.init(sessions.broadcast, sessions.getSessions);
require('./opencode-bridge').init(sessions.broadcast, sessions.getSessions);
const config = require('./config');
plugins.init(sessions.broadcast, sessions.getSessions, () => require('./handlers').getConfig(), (cfg) => config.save(cfg));

const HOST = process.env.CLIDECK_HOST || '127.0.0.1';
const PORT = Number(process.env.CLIDECK_PORT || 4000);
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const ALIASES = {
  '/xterm.css':    join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/xterm.js':     join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js'),
  '/addon-fit.js': join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
};

const PUBLIC_ROOT = join(__dirname, 'public');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function requestPath(req) {
  return (req.url || '/').split('?')[0] || '/';
}

function applySecurityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (requestPath(req) === '/' || requestPath(req) === '/login' || requestPath(req).startsWith('/auth/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
}

function configuredOrigins() {
  return String(process.env.CLIDECK_ALLOWED_ORIGINS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function allowedOriginsForRequest(req) {
  const configured = configuredOrigins();
  if (configured.length) return new Set(configured);

  const origins = new Set();
  const hostHeader = String(req.headers.host || '').trim();
  if (hostHeader) {
    origins.add(`http://${hostHeader}`);
    origins.add(`https://${hostHeader}`);
  }
  origins.add(`http://localhost:${PORT}`);
  origins.add(`http://127.0.0.1:${PORT}`);
  origins.add(`http://[::1]:${PORT}`);
  origins.add(`https://localhost:${PORT}`);
  origins.add(`https://127.0.0.1:${PORT}`);
  origins.add(`https://[::1]:${PORT}`);
  if (HOST && !['0.0.0.0', '::'].includes(HOST)) {
    origins.add(`http://${HOST}:${PORT}`);
    origins.add(`https://${HOST}:${PORT}`);
  }
  return origins;
}

function isAllowedHttpOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  return allowedOriginsForRequest(req).has(origin);
}

function isAllowedWsOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return false;
  return allowedOriginsForRequest(req).has(origin);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function serveFile(res, filePath) {
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch {
    res.writeHead(500).end();
  }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleIngest(req, res, path) {
  if (!isTrustedIngressRequest(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ingress authentication required.' }));
    return;
  }

  if (req.method === 'POST' && (path === '/v1/logs' || path === '/')) {
    try {
      req.body = await readJsonBody(req, 1e6);
    } catch (error) {
      console.log(`OTLP: failed to parse body (${error.message})`);
      req.body = null;
    }
    telemetry.handleLogs(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/opencode-events') {
    try {
      const payload = await readJsonBody(req, 1e5);
      require('./opencode-bridge').handleEvent(payload);
    } catch (error) {
      console.error('[opencode-bridge] handleEvent error:', error);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }

  console.log(`OTLP: received POST ${path} (not handled)`);
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
}

async function handleRequest(req, res) {
  const path = requestPath(req);
  applySecurityHeaders(req, res);

  if (path.startsWith('/auth/')) {
    if (!isAllowedHttpOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed.' }));
      return;
    }
    const handled = await handleAuthRoute(req, res);
    if (handled) return;
    res.writeHead(404).end();
    return;
  }

  if (req.method === 'POST') {
    await handleIngest(req, res, path);
    return;
  }

  const auth = getSessionResponse(req, { touch: true });

  if (path.startsWith('/plugins/')) {
    if (!auth.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required.' }));
      return;
    }
    const pluginFile = plugins.resolveFile(path);
    if (pluginFile) {
      serveFile(res, pluginFile);
      return;
    }
    res.writeHead(404).end();
    return;
  }

  if (path === '/' || path === '/index.html') {
    if (!auth.authenticated) {
      redirect(res, '/login');
      return;
    }
    setSessionCookie(res, auth.session.token, req);
    serveFile(res, join(PUBLIC_ROOT, 'index.html'));
    return;
  }

  if (path === '/login') {
    if (auth.authenticated) {
      redirect(res, '/');
      return;
    }
    serveFile(res, join(PUBLIC_ROOT, 'index.html'));
    return;
  }

  const filePath = ALIASES[path]
    || resolve(PUBLIC_ROOT, path.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_ROOT) && !ALIASES[path]) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end();
    return;
  }
  serveFile(res, filePath);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[server] request failed:', error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', onConnection);

server.on('upgrade', (req, socket, head) => {
  if (!isAllowedWsOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const auth = getSessionResponse(req, { touch: true });
  if (!auth.authenticated) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.auth = auth.session;
    wss.emit('connection', ws, req);
  });
});

const activity = require('./activity');
activity.start(sessions.getSessions(), sessions.broadcast);
sessions.startAutoSave(() => require('./handlers').getConfig());

// Graceful shutdown: persist sessions before exit
function onShutdown() {
  plugins.shutdown();
  activity.stop();
  sessions.shutdown(getConfig());
  closeDb();
  process.exit(0);
}
process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);

server.listen(PORT, HOST, () => {
  const v = require('./package.json').version;
  const url = `http://localhost:${PORT}`;
  console.log(`
\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;239m   ██████╗\x1b[38;5;242m██╗     \x1b[38;5;245m██╗\x1b[38;5;105m██████╗ \x1b[38;5;141m███████╗\x1b[38;5;147m ██████╗\x1b[38;5;183m██╗  ██╗\x1b[0m
\x1b[38;5;239m  ██╔════╝\x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██╔══██╗\x1b[38;5;141m██╔════╝\x1b[38;5;147m██╔════╝\x1b[38;5;183m██║ ██╔╝\x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m█████╗  \x1b[38;5;147m██║     \x1b[38;5;183m█████╔╝ \x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m██╔══╝  \x1b[38;5;147m██║     \x1b[38;5;183m██╔═██╗ \x1b[0m
\x1b[38;5;239m  ╚██████╗\x1b[38;5;242m███████╗\x1b[38;5;245m██║\x1b[38;5;105m██████╔╝\x1b[38;5;141m███████╗\x1b[38;5;147m╚██████╗\x1b[38;5;183m██║  ██╗\x1b[0m
\x1b[38;5;239m   ╚═════╝\x1b[38;5;242m╚══════╝\x1b[38;5;245m╚═╝\x1b[38;5;105m╚═════╝ \x1b[38;5;141m╚══════╝\x1b[38;5;147m ╚═════╝\x1b[38;5;183m╚═╝  ╚═╝\x1b[0m

\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;245m  v${v}\x1b[0m

\x1b[38;5;252m  ▸ Ready at \x1b[38;5;44m${url}\x1b[0m
\x1b[38;5;245m  ▸ Stop with \x1b[38;5;252mCtrl+C\x1b[38;5;245m · Restart anytime with \x1b[38;5;252mclideck\x1b[0m
`);
});
