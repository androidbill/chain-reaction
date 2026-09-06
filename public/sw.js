const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `chain-reaction-${VERSION}`;

const CORE = [
  './',
  'index.html',
  'app.js',
  'board.js',
  'render.js',
  'cards.js',
  'rules.js',
  'firebase-config.js',
  'version.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(CORE.map((url) => fetch(url, { cache: 'reload' }).then((res) => cache.put(url, res)).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        const clientsList = await self.clients.matchAll({ type: 'window' });
        for (const client of clientsList) client.postMessage({ type: 'NEW_VERSION', version: VERSION });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((cached) => cached || caches.match('index.html'))
      )
  );
});
