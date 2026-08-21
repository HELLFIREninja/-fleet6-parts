/* EWS Parts Order — service worker
 * Purpose: (1) lets Chrome/Edge/Android offer "Install app", (2) lets the
 * installed app OPEN with no signal and show the last-synced view.
 *
 * Strategy, deliberately simple:
 *  - Same-origin pages & files (index.html, firebase-config.js, icons…):
 *    NETWORK FIRST, cache as fallback. Online users always get the newest
 *    build straight from GitHub Pages (the APP_BUILD forced-reload keeps
 *    working); offline users get the last copy that loaded successfully.
 *  - Versioned CDN scripts (Fuse, SheetJS, Firebase SDK): CACHE FIRST —
 *    their URLs carry the version, so a cached copy is never stale. Without
 *    these the page can't boot offline (search needs Fuse).
 *  - Everything else (Firebase realtime traffic, other fleets' REST reads,
 *    Google Fonts, YouTube…): not touched — straight to the network.
 *
 * Bump CACHE only when THIS file's logic changes; app updates don't need it.
 */
var CACHE = 'ews-parts-v1';
var SHELL = ['./index.html', './firebase-config.js', './manifest.webmanifest',
             './icon-192.png', './icon-512.png', './icon-192-maskable.png', './icon-512-maskable.png',
             './apple-touch-icon.png', './favicon.ico'];
// The page can't boot offline without these (search needs Fuse; Firebase SDK
// is optional but keeps sync behaviour identical). Versioned URLs → safe to
// keep indefinitely. Stored as opaque responses, which <script> tags accept.
var CDN_SHELL = ['https://cdnjs.cloudflare.com/ajax/libs/fuse.js/7.0.0/fuse.min.js',
                 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
                 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
                 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js'];
var CDN_CACHE_FIRST = /^https:\/\/(cdnjs\.cloudflare\.com|www\.gstatic\.com\/firebasejs)\//;
var NEVER_TOUCH = /firebaseio\.com|googleapis\.com\/identitytoolkit|youtube\.com|youtu\.be|fonts\.googleapis\.com|fonts\.gstatic\.com/;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Add one by one so a single missing file (e.g. a fork without an
      // icon yet) never blocks install.
      return Promise.all(SHELL.map(function (u) {
        // Plain requests (not cache:'reload') so the 12 MB index.html the page
        // just downloaded is reused from the HTTP cache instead of fetched twice.
        return c.add(u).catch(function () {});
      }).concat(CDN_SHELL.map(function (u) {
        return fetch(u, { mode: 'no-cors' }).then(function (r) {
          if (r && (r.ok || r.type === 'opaque')) return c.put(u, r);
        }).catch(function () {});
      })));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Cache key = the URL without its query string, so "?b=2026082102" reloads
// refresh the same entry instead of piling up copies.
function keyFor(req) { var u = new URL(req.url); u.search = ''; u.hash = ''; return u.href; }

function networkFirst(req, isNav) {
  var key = keyFor(req);
  return fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(key, copy); }).catch(function () {});
    }
    return res;
  }).catch(function () {
    return caches.match(key).then(function (hit) {
      if (hit) return hit;
      // A page load we never cached under this exact path (e.g. the bare
      // folder URL) — serve the app shell.
      if (isNav) return caches.match('./index.html');
      return Response.error();
    });
  });
}

function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = req.url;
  if (NEVER_TOUCH.test(url)) return;

  // Page loads (including the ?b=… cache-busting reloads): fresh when online,
  // last good copy when not.
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, true));
    return;
  }
  var sameOrigin = url.indexOf(self.location.origin) === 0;
  if (sameOrigin) {
    e.respondWith(networkFirst(req, false));
    return;
  }
  if (CDN_CACHE_FIRST.test(url)) {
    e.respondWith(cacheFirst(req));
  }
});
