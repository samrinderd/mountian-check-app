// Keeps the app itself available without signal. Peak and terrain data are
// cached separately by the page (see src/dem.js and src/peaks.js).
const SHELL = 'mountain-check-shell-v3';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'src/app.js', 'src/geo.js', 'src/dem.js', 'src/peaks.js', 'src/visibility.js', 'src/sensors.js', 'src/render.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mountain-check-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Same-origin files: answer from cache straight away, refresh in the background.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/__peaks/')) return;
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached ?? fresh;
    }),
  );
});
