const CACHE_NAME = 'rescuenet-pwa-v9';
const APP_SHELL = [
  './', './index.html', './styles.css', './app.mjs', './core.mjs', './location-scheduler.mjs',
  './manifest.webmanifest', './icon.svg', './assets/rescuenet-logo.png',
];

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE_NAME)
    .then(cache => cache.addAll(APP_SHELL.map(path => new Request(new URL(path, self.location.href), { cache: 'reload' }))))
    .then(() => self.skipWaiting()),
));

self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('rescuenet-pwa-') && key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()),
));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API calls must always reach the device/server; never replay or cache an API success.
  if (/\/api(?:\/|$)/.test(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }

  const shellUrl = new URL('./', self.location.href);
  if (!url.pathname.startsWith(shellUrl.pathname)) return;
  const isNavigation = request.mode === 'navigate';
  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const key = isNavigation ? new URL('./index.html', self.location.href).href : request;
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && APP_SHELL.some(path => new URL(path, self.location.href).href === url.href)) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (isNavigation) {
        const fallback = await cache.match(new URL('./index.html', self.location.href).href);
        if (fallback) return fallback;
      }
      throw error;
    }
  }));
});
