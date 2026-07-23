/* ===========================================================
   Prātaḥ Bhajan — Service Worker
   Strategy: Cache-first for app shell, Range-aware caching for audio.
   =========================================================== */

const CACHE_NAME = 'pratah-bhajan-v1';

// App shell — always pre-cached on install
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

// ─── Install: Pre-cache app shell ──────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ─── Activate: Clean up old caches ─────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ─── Range Request Handler for Audio ───────────
async function handleAudioRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  // Match by URL ignoring range headers in key lookup
  const cachedResponse = await cache.match(request.url);

  if (cachedResponse) {
    const rangeHeader = request.headers.get('range');
    if (!rangeHeader) {
      return cachedResponse;
    }

    // Serve partial content for range request from cached ArrayBuffer
    const arrayBuffer = await cachedResponse.arrayBuffer();
    const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);

    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : arrayBuffer.byteLength - 1;
      const chunk = arrayBuffer.slice(start, end + 1);

      return new Response(chunk, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${arrayBuffer.byteLength}`,
          'Content-Length': chunk.byteLength,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return cachedResponse;
  }

  // Not in cache — fetch from network
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const clone = response.clone();
      cache.put(request.url, clone);
    }
    return response;
  } catch (err) {
    return new Response('', { status: 503, statusText: 'Audio Unavailable Offline' });
  }
}

// ─── Fetch: Cache-first, fallback to network ───
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  // Special handling for audio files (support Range headers & offline partial content)
  if (request.url.includes('bhajan.mp3') || request.headers.has('range')) {
    event.respondWith(handleAudioRequest(request));
    return;
  }

  // Standard cache-first strategy for app shell & icons
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (!response || response.status !== 200) {
            return response;
          }

          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });

          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        });
    })
  );
});

// ─── Notification Click: Deep-link into app ────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./index.html');
      }
    })
  );
});
