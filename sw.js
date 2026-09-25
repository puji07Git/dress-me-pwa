/* Offline shell for Dress Me. Assets are cached as they are requested, so the app
   keeps working with no connection after the first visit. Wardrobe data lives in
   IndexedDB and never goes through here. */

const CACHE = 'dress-me-v3';
// The app may be served from a subpath (GitHub Pages), so everything is relative to us.
const BASE = new URL('./', self.location).pathname;
const SHELL = BASE + 'index.html';
const PRECACHE = [BASE, SHELL, BASE + 'manifest.webmanifest', BASE + 'icons/icon-192.png', BASE + 'icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let the model CDN and Gemini go straight out

  // Anything with a query string is asking for something current — the update
  // check, for one — so it never comes from here and never goes in here.
  if (url.search) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigations: network first so a deploy is picked up, cache as the offline fallback.
  //
  // Deliberately past the HTTP cache: GitHub Pages serves the shell with ten
  // minutes of freshness, and serving a ten-minute-old index.html means serving
  // the previous build's scripts with it.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy));
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r || caches.match(BASE))),
    );
    return;
  }

  // Everything else: cache first, then fill the cache in the background.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
