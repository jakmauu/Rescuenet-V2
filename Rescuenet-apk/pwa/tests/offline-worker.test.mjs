import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const workerSource = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
const appRoot = 'https://jakmauu.github.io/Rescuenet-V2/';

test('service worker menyimpan app shell di path GitHub Pages dan membuka beranda tanpa internet', async () => {
  const listeners = new Map();
  const entries = new Map();
  const cachesByName = new Map();
  let networkRequests = 0;
  const cache = {
    async addAll(requests) {
      for (const request of requests) {
        assert.equal(request.cache, 'reload', 'install must fetch the newest shell files');
        assert.ok(request.url.startsWith(appRoot), `asset escaped the Pages subpath: ${request.url}`);
        entries.set(request.url, { url: request.url, cached: true });
      }
    },
    async match(request) { return entries.get(typeof request === 'string' ? request : request.url); },
    async put(request, response) { entries.set(request.url, response); },
  };
  const cacheStorage = {
    async open(name) { cachesByName.set(name, cache); return cache; },
    async keys() { return [...cachesByName.keys()]; },
    async delete(name) { return cachesByName.delete(name); },
  };
  class FakeRequest {
    constructor(url, options = {}) { this.url = url.href || String(url); this.cache = options.cache; }
  }
  const self = {
    location: { href: `${appRoot}service-worker.js`, origin: 'https://jakmauu.github.io' },
    addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {},
    clients: { async claim() {} },
  };
  runInNewContext(workerSource, {
    self, caches: cacheStorage, Request: FakeRequest, URL,
    fetch: async () => { networkRequests += 1; throw new Error('offline'); },
  });

  let install;
  listeners.get('install')({ waitUntil(promise) { install = promise; } });
  await install;
  for (const path of ['index.html', 'app.mjs', 'core.mjs', 'location-scheduler.mjs', 'styles.css', 'manifest.webmanifest', 'assets/rescuenet-logo.png']) {
    assert.ok(entries.has(`${appRoot}${path}`), `missing offline shell asset ${path}`);
  }

  let navigation;
  listeners.get('fetch')({
    request: { method: 'GET', mode: 'navigate', url: appRoot },
    respondWith(promise) { navigation = promise; },
  });
  assert.deepEqual(await navigation, { url: `${appRoot}index.html`, cached: true });
  assert.equal(networkRequests, 0, 'offline startup must not wait for GitHub Pages');

  let intercepted = false;
  listeners.get('fetch')({
    request: { method: 'GET', mode: 'cors', url: 'https://192.168.4.1/api/status' },
    respondWith() { intercepted = true; },
  });
  assert.equal(intercepted, false, 'Field Node API must bypass the app shell cache');
});
