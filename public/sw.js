const CACHE_VERSION = 'clideck-static-v3';
const STATIC_CACHE = `${CACHE_VERSION}-precache`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE_URLS = [
  '/tailwind.css',
  '/xterm.css',
  '/xterm.js',
  '/addon-fit.js',
  '/manifest.webmanifest',
  '/img/clideck-logo-icon.png',
];

const BYPASS_PREFIXES = ['/auth/', '/v1/', '/plugins/'];
const BYPASS_PATHS = new Set(['/opencode-events']);
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif',
  '.ico', '.woff', '.woff2', '.ttf', '.otf', '.webmanifest', '.map',
]);

function hasStaticExtension(pathname) {
  for (const ext of STATIC_EXTENSIONS) {
    if (pathname.endsWith(ext)) return true;
  }
  return false;
}

function shouldBypass(url) {
  if (BYPASS_PATHS.has(url.pathname)) return true;
  return BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function putInCache(cacheName, request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => putInCache(RUNTIME_CACHE, request, response))
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => !key.startsWith(CACHE_VERSION))
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') return;
  if (shouldBypass(url)) {
    event.respondWith(fetch(req));
    return;
  }

  const isStaticRequest =
    req.destination === 'script' ||
    req.destination === 'style' ||
    req.destination === 'font' ||
    req.destination === 'image' ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/img/') ||
    url.pathname.startsWith('/fx/') ||
    hasStaticExtension(url.pathname);

  if (!isStaticRequest) return;

  event.respondWith(staleWhileRevalidate(req));
});
