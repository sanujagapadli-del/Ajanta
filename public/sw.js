// Ajanta ERP service worker (doer audit 2026-10-27).
// Deliberately small: when there is no internet, opening the app shows a
// friendly offline page instead of the browser's error. Nothing else is
// cached — the app and every API call always come fresh from the server, so a
// deploy can never leave someone on an old version.
const CACHE = 'ajanta-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(new Request(OFFLINE_URL, { cache: 'reload' }))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return; // only page opens; API / files untouched
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE_URL)));
});
