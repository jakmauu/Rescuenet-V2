import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const app = await readFile(new URL('app.mjs', root), 'utf8');
const worker = await readFile(new URL('service-worker.js', root), 'utf8');

test('PWA screens and four primary navigation tabs are present with unique IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
  for (const id of ['splash-screen','onboarding-screen','home-screen','map-screen','status-screen','profile-screen','sos-button','identity-card','bottom-nav']) {
    assert.ok(ids.includes(id), `missing UI contract element #${id}`);
  }
  for (const tab of ['home','map','status','profile']) assert.match(html, new RegExp(`data-screen="${tab}"`));
  assert.match(app, /document\.querySelectorAll\('\.bottom-nav button'\)/);
  assert.match(html, /id="home-screen"[^>]*class="screen"[^>]*>/);
  assert.match(html, /id="splash-screen"[^>]*hidden/);
  assert.ok(app.lastIndexOf('openInitialScreen();') < app.lastIndexOf('void checkConnection();'),
    'the first screen must render before the network check starts');
  assert.match(app, /QUEUED_LOCAL:'Menunggu dikirim'/);
  assert.match(app, /FIELD_ACCEPTED:'Diterima Field Node'/);
});

test('service worker caches the scheduler dependency and does not cache API responses', () => {
  assert.match(worker, /location-scheduler\.mjs/);
  assert.ok(worker.includes('if (/\\/api(?:\\/|$)/.test(url.pathname))'));
  assert.match(worker, /fetch\(request\)/);
});
