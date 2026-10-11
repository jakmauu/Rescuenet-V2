import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const app = await readFile(new URL('app.mjs', root), 'utf8');
const worker = await readFile(new URL('service-worker.js', root), 'utf8');
const files = await Promise.all(['pages/onboarding.mjs','pages/home.mjs','pages/map.mjs','pages/status.mjs','pages/profile.mjs','components/bottom-nav.mjs','components/connection-card.mjs','components/app-header.mjs'].map(path => readFile(new URL(path, root), 'utf8')));

test('PWA screens and four primary navigation tabs are present with unique IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
  for (const id of ['splash-screen','onboarding-screen','home-screen','map-screen','status-screen','profile-screen','sos-button','identity-card','bottom-nav']) {
    assert.ok(ids.includes(id), `missing UI contract element #${id}`);
  }
  for (const tab of ['home','map','status','profile']) assert.match(html, new RegExp(`data-screen="${tab}"`));
  assert.match(app, /bindBottomNav\(byId\['bottom-nav'\], showScreen\)/);
  assert.match(html, /id="home-screen"[^>]*class="screen"[^>]*>/);
  assert.match(html, /id="splash-screen"[^>]*hidden/);
  const startup = app.slice(app.lastIndexOf('renderAll();'));
  assert.match(startup, /openInitialScreen\(\);/);
  assert.doesNotMatch(startup, /void checkConnection\(\)/,
    'opening the app must not probe Field Node automatically');
  assert.match(app, /byId\['check-button'\]\.addEventListener\('click',\(\)=>void checkConnection\(\)\)/,
    'the connection check must remain available from its button');
  const visibilityHandler = app.match(/document\.addEventListener\('visibilitychange',[\s\S]*?\n\}\);/)?.[0] || '';
  const pageshowHandler = app.match(/window\.addEventListener\('pageshow',[\s\S]*?\}\);/)?.[0] || '';
  assert.ok(visibilityHandler, 'visibility handler must remain present');
  assert.ok(pageshowHandler, 'pageshow handler must remain present');
  assert.doesNotMatch(visibilityHandler, /checkConnection/,
    'returning to the app must not trigger a connection probe');
  assert.doesNotMatch(pageshowHandler, /checkConnection/,
    'pageshow must not trigger a connection probe');
  assert.match(files[3], /QUEUED_LOCAL: 'Menunggu dikirim'/);
  assert.match(files[3], /FIELD_ACCEPTED: 'Diterima Field Node'/);
  assert.match(files[2], /maps\.apple\.com/);
  assert.match(files[4], /profile-role-input/);
  assert.match(files[6], /meshText\(state\.nodeDetails\)/);
  assert.match(files[7], /renderAppHeader/);
});

test('service worker caches the scheduler dependency and does not cache API responses', () => {
  assert.match(worker, /location-scheduler\.mjs/);
  for (const asset of ['pages/onboarding.mjs','pages/home.mjs','pages/map.mjs','pages/status.mjs','pages/profile.mjs','components/app-header.mjs','styles/pages/profile.css']) assert.ok(worker.includes(asset), `offline cache missing ${asset}`);
  assert.ok(worker.includes('if (/\\/api(?:\\/|$)/.test(url.pathname))'));
  assert.match(worker, /fetch\(request\)/);
});
