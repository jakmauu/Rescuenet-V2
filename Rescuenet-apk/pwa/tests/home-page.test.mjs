import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeApiReadiness, probeNode } from '../core.mjs';
import { renderConnectionCard } from '../components/connection-card.mjs';
import { renderHome } from '../pages/home.mjs';

const homeElements = () => ({
  'welcome-user': { textContent: '' },
  'sos-button': { disabled: false },
  'sos-button-label': { textContent: '' },
});

const connectionElements = () => Object.fromEntries([
  'connection-title', 'home-connection-title', 'connection-help', 'home-connection-help',
  'api-state', 'home-api-state', 'mesh-state', 'home-mesh-state', 'status-api', 'status-mesh',
].map(id => [id, { textContent: '' }]).concat(
  ['check-button', 'home-check-button'].map(id => [id, { disabled: false, textContent: '' }]),
));

test('beranda aman dirender tanpa profil dan SOS tetap nonaktif', () => {
  const elements = homeElements();
  renderHome({ elements, profile: () => null, state: { sendingSosId: null, nodeReady: false } });
  assert.match(elements['welcome-user'].textContent, /Siapkan identitas/);
  assert.equal(elements['sos-button'].disabled, true);
  assert.equal(elements['sos-button-label'].textContent, 'SIMPAN SOS');
});

test('beranda mengikuti perubahan state SOS dan kesiapan Field Node', () => {
  const elements = homeElements();
  const profile = () => ({ name: 'Relawan Uji' });
  const state = { sendingSosId: null, nodeReady: false };
  renderHome({ elements, profile, state });
  assert.match(elements['welcome-user'].textContent, /Halo, Relawan Uji/);
  assert.equal(elements['sos-button'].disabled, false);
  assert.equal(elements['sos-button-label'].textContent, 'SIMPAN SOS');

  state.nodeReady = true;
  renderHome({ elements, profile, state });
  assert.equal(elements['sos-button-label'].textContent, 'KIRIM SOS');

  state.sendingSosId = 'sos-test';
  renderHome({ elements, profile, state });
  assert.equal(elements['sos-button'].disabled, true);
  assert.match(elements['sos-button-label'].textContent, /MENGIRIM/);
});

test('Field Node ID berasal dari respons API; kesiapan API terpisah dari Mesh/Gateway', async () => {
  const status = {
    service: 'rescuenet-field-node', api_version: 1, node_id: 2, device: 'field_node',
    status: 'ready', mobile_protocol: 1, mobile_tx_enabled: true,
    mesh_started: false, mesh_synchronized: false, gateway_found: false, route_count: 0,
  };
  const info = await probeNode(async () => new Response(JSON.stringify(status), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(nodeApiReadiness(info), 'FIELD_CONNECTED');

  const elements = connectionElements();
  renderConnectionCard({
    elements,
    state: { checking: false, nodeReady: true, nodeDetails: info, connectionError: '' },
    statusLabel: () => 'Terhubung ke Field Node',
    meshText: data => data.gateway_found ? 'Gateway ditemukan' : 'Gateway belum ditemukan',
  });
  assert.equal(elements['connection-title'].textContent, 'Terhubung ke Field Node 2');
  assert.equal(elements['api-state'].textContent, 'Terhubung');
  assert.equal(elements['mesh-state'].textContent, 'Gateway belum ditemukan');

  const degraded = { ...info, status: 'degraded', mobile_tx_enabled: false };
  assert.equal(nodeApiReadiness(degraded), 'FIELD_API_NOT_READY');
  renderConnectionCard({
    elements,
    state: { checking: false, nodeReady: false, nodeDetails: degraded, connectionError: '' },
    statusLabel: () => 'Terhubung · pengiriman belum siap',
    meshText: () => 'Mesh belum siap',
  });
  assert.equal(elements['connection-title'].textContent, 'Terhubung ke Field Node 2');
  assert.equal(elements['api-state'].textContent, 'Terhubung');
  assert.match(elements['connection-help'].textContent, /API dapat diakses/);
  assert.equal(elements['mesh-state'].textContent, 'Mesh belum siap');
});

test('alamat Field Node alternatif dipakai dan respons gagal/portal tidak dianggap terhubung', async () => {
  let requestedUrl;
  const status = {
    service: 'rescuenet-field-node', api_version: 1, node_id: 2, device: 'field_node',
    status: 'ready', mobile_protocol: 1, mobile_tx_enabled: true,
  };
  await probeNode(async url => {
    requestedUrl = url;
    return new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } });
  }, 500, 'https://192.168.4.2');
  assert.equal(requestedUrl, 'https://192.168.4.2/api/status');

  await assert.rejects(probeNode(async () => { throw new TypeError('fetch failed'); }), error => error.code === 'NETWORK'
    && /Safari tidak memberi rincian/.test(error.message));
  await assert.rejects(probeNode(async () => new Response('<html>Captive portal</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  })), error => error.code === 'INCOMPATIBLE' && /portal\/HTML/.test(error.message));
  await assert.rejects(probeNode(async () => new Response('{bad json', {
    status: 200, headers: { 'content-type': 'application/json' },
  })), error => error.code === 'INCOMPATIBLE' && /JSON Field Node tidak valid/.test(error.message));
});

test('renderer mempertahankan error yang jelas untuk elemen wajib yang hilang', () => {
  assert.throws(() => renderHome({ elements: {}, profile: () => null, state: { sendingSosId: null, nodeReady: false } }),
    /Elemen wajib Beranda tidak ditemukan: #welcome-user/);
});
