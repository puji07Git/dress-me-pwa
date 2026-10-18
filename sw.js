/* Offline shell for Dress Me. Assets are cached as they are requested, so the app
   keeps working with no connection after the first visit. Wardrobe data lives in
   IndexedDB and never goes through here. */

const CACHE = 'dress-me-v3';
// Answers from the AI, kept here until the page takes them. Not the shell's
// cache, so the clean-up on activate leaves it alone.
const AI = 'dress-me-ai';
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== AI).map((k) => caches.delete(k))))
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

/* ------------------------------------------------- AI requests, backgrounded

   The page is frozen when the app goes to the background or the screen goes
   off, and a request it had in flight — a lookbook is two of them, a minute or
   two each — went with it: «quan tens l'app en segon pla segueixi funcionant».
   The service worker is not frozen with the page. So the page hands it the
   request, the worker makes it and keeps the answer in a cache under the
   request's id, tells the page, and, when nobody is looking, says so in a
   notification. The page takes the answer from the cache when it wakes,
   whether or not it heard the message.

   The deadline is kept here, because a frozen page's timers do not run. */

const inFlight = new Map();

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'ai-abort') {
    inFlight.get(data.id)?.abort();
    return;
  }
  if (data.type !== 'ai-fetch') return;
  event.waitUntil(runAi(data));
});

async function runAi({ id, url, init, deadline, notify }) {
  const controller = new AbortController();
  inFlight.set(id, controller);
  const timer = setTimeout(() => controller.abort('deadline'), deadline || 240000);
  const key = BASE + '__ai/' + id;
  let stored;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    stored = new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'x-ai-outcome': 'answered' },
    });
  } catch (err) {
    const why = controller.signal.aborted
      ? controller.signal.reason === 'deadline' ? 'deadline' : 'aborted'
      : 'network';
    stored = new Response(String((err && err.message) || err), { status: 599, headers: { 'x-ai-outcome': why } });
  } finally {
    clearTimeout(timer);
    inFlight.delete(id);
  }
  const outcome = stored.headers.get('x-ai-outcome');
  if (outcome !== 'aborted') {
    const cache = await caches.open(AI);
    await cache.put(key, stored);
  }
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: 'ai-done', id });
  const someoneLooking = clients.some((c) => c.visibilityState === 'visible');
  if (notify && !someoneLooking && outcome === 'answered' && self.registration.showNotification) {
    try {
      await self.registration.showNotification('Dress Me', {
        body: notify,
        tag: 'dress-me-ai',
        icon: BASE + 'icons/icon-192.png',
        badge: BASE + 'icons/icon-192.png',
      });
    } catch {
      /* no permission: the answer is waiting all the same */
    }
  }
}

// Tapping the notification brings the app back rather than opening another.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => 'focus' in c);
      return open ? open.focus() : self.clients.openWindow(BASE);
    }),
  );
});
