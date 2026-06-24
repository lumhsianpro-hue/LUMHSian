// Minimal service worker — no caching, just makes app installable as PWA
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  // Network only — no caching, always fresh content
  e.respondWith(fetch(e.request));
});
