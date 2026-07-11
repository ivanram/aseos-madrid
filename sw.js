/* Service worker — Aseos de Madrid
   Estrategia "network-first": si hay conexión, siempre sirve la versión
   más reciente (así las actualizaciones se ven al instante); si no hay
   conexión, tira de la copia cacheada. Mantiene la app usable offline. */
const CACHE = 'aseos-madrid-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=1.0.2',
  './themes.js?v=1.0.2',
  './app.js?v=1.0.2',
  './data/aseos.json',
  './languages/manifest.json',
  './languages/es.json',
  './icon-192.png?v=1',
  './icon-512.png',
  './manifest.webmanifest',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/leaflet-rotate@0.2.8/dist/leaflet-rotate.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Network-first: intenta red, guarda copia fresca, y si falla usa caché.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
