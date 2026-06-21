/* ZizGo service worker: app shell cached, live data always from network */
const CACHE = "zizgo-v37";
const SHELL = [
  "./", "index.html",
  "css/app.css", "js/app.js",
  "stations.json",
  "lines/l01.json", "lines/l02.json", "lines/l03.json",
  "geojson/l01_aller.geojson", "geojson/l01_retour.geojson",
  "geojson/l02_aller.geojson", "geojson/l02_retour.geojson",
  "geojson/l03_aller.geojson", "geojson/l03_retour.geojson",
  "assets/splash.webp", "assets/icons/zizgo-mark.svg", "assets/icons/favicon.ico",
  "manifest.webmanifest",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // live bus data + map tiles: network only (tiles rely on HTTP cache)
  if (url.hostname.endsWith("workers.dev") || url.hostname.endsWith("cartocdn.com")) return;
  // same-origin shell: stale-while-revalidate
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || fresh;
      })
    );
  }
});
