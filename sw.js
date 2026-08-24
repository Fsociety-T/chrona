/* Chrona service worker.

   Strategy: network-first for the app's own code, cache as the offline
   fallback. The obvious alternative — cache-first — is what makes a PWA
   feel broken during development: you change a file, reload, and the old
   version is served forever because the cache never expires.

   Icons and other static assets stay cache-first; they rarely change and
   are the expensive ones to refetch.

   tools/build-www.js rewrites CACHE on every build so a deploy always
   lands in a fresh cache and the old one is dropped on activate. */
var CACHE = 'chrona-v2';

var SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/config.js',
  './js/db.js',
  './js/sound.js',
  './js/store.js',
  './js/analyse.js',
  './js/sync.js',
  './js/certificate.js',
  './js/ui.js',
  './js/focus.js',
  './js/views.js',
  './js/app.js',
  './manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      // Take over straight away rather than waiting for every tab to close.
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                               .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* Anything that isn't an image is treated as code: fetch it fresh, fall
   back to the cache only when the network actually fails. */
function isStatic(url) {
  return /\.(png|jpg|jpeg|svg|ico|woff2?)$/i.test(url.pathname);
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;

  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // Supabase calls pass straight through

  if (isStatic(url)) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(e.request).then(function (hit) {
          if (hit) return hit;
          // Offline on a URL we've never seen: hand back the app shell so
          // the SPA can still boot and read its local database.
          if (e.request.mode === 'navigate') return caches.match('./index.html');
          throw new Error('offline');
        });
      })
  );
});

/* Lets the page force an immediate takeover after an update. */
self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
