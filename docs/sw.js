// Service worker: lets the app be installed and open without signal.
// Files with a ?v= version tag never change (a new version gets a new tag), so they come from the saved copy
// at once. Everything else (the page itself, app-version.json) is network first, so updates are never held back.
// Only this site's own files are touched: Apps Script calls go straight to the network.
var CACHE = 'rtg-heater-v2';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function save(req, res) {
  if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
  return res;
}

// Remove older versions of the same file.
function dropOld(url) {
  var path = url.split('?')[0];
  caches.open(CACHE).then(function (c) {
    c.keys().then(function (keys) {
      keys.forEach(function (k) { if (k.url.split('?')[0] === path && k.url !== url) c.delete(k); });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (/[?&]v=/.test(req.url)) {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { dropOld(req.url); return save(req, res); });
    }));
    return;
  }
  e.respondWith(fetch(req).then(function (res) { return save(req, res); }).catch(function () {
    return caches.match(req).then(function (hit) {
      return hit || (req.mode === 'navigate' ? caches.match('./') : Response.error());
    });
  }));
});
