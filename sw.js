// Network-only worker: never serve stale app code, and clear caches left by older releases.
const CACHE_NAME = 'lumhsian-v2026-10-09-back-navigation';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith('lumhsian-') && name !== CACHE_NAME).map(name => caches.delete(name)));
  await clients.claim();
})()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(new Request(e.request, { cache: 'no-store' })));
});
