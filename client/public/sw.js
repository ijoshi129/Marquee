/* Marquee Service Worker
 * - Caches the app shell (HTML/JS/CSS/icons) network-first → cache fallback,
 *   so the PWA opens with the most recent build when online and the last
 *   working build when offline.
 * - Caches TMDB poster images cache-first, so previously-loaded posters
 *   render offline.
 * - Never caches /api/* — those are always live.
 */

const VERSION = 'v2';
const SHELL_CACHE = `marquee-shell-${VERSION}`;
const POSTER_CACHE = `marquee-posters-${VERSION}`;
const SHELL_PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_PRECACHE).catch(() => {})
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== POSTER_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // TMDB poster: cache-first.
  if (url.hostname === 'image.tmdb.org') {
    event.respondWith(cacheFirst(req, POSTER_CACHE));
    return;
  }

  // Same-origin API: pass through, never cache.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  // Same-origin shell: network-first, fall back to cache, fall back to root HTML.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // Last resort: serve the cached root HTML so SPA navigation still works.
    const root = await cache.match('/') || await cache.match('/index.html');
    if (root) return root;
    throw err;
  }
}
