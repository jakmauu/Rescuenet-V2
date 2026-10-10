import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverLocation, deliverSos, getBrowserLocation, isPendingLocationStale, locationAgeMs, locationRetryDelayMs, makeLocationPacket, makeSosPacket, nodeApiReadiness, normalizeNodeOrigin, normalizeProfile, NodeApiError, probeNode, shouldQueueLocation } from '../core.mjs';

const status = {
  service: 'rescuenet-field-node', api_version: 1, node_id: 1, device: 'field_node',
  status: 'ready', mobile_protocol: 1, mobile_tx_enabled: true,
};
const response = (body, statusCode = 200, contentType = 'application/json') => new Response(JSON.stringify(body), { status: statusCode, headers: { 'content-type': contentType } });
const user = { user_id: 'USR-test', name: 'Riko Dharmawan' };
const location = { lat: -6.2088, lon: 106.8456, accuracy: 6.8, timestamp: 1_000_000 };

test('belum terhubung: probe menolak respons gagal, tidak membuat permintaan SOS', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); throw new TypeError('offline'); };
  await assert.rejects(probeNode(fetcher), error => error instanceof NodeApiError && error.code === 'NETWORK');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/status$/);
  assert.equal(calls.some(call => call.url.endsWith('/api/sos')), false);
});

test('status request mendukung timeout dan pembatalan oleh pemanggil', async () => {
  const never = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(probeNode(never, 5), error => error.code === 'TIMEOUT');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeNode((_url,{signal})=>{if(signal.aborted)throw signal.reason;return response(status);}, 1000, 'http://192.168.4.1', controller.signal), error => error.code === 'CANCELLED');
});

test('API Field Node diverifikasi terpisah dari kesiapan mesh/mobile TX', async () => {
  const data = await probeNode(async () => response(status));
  assert.equal(data.node_id, 1);
  assert.equal(nodeApiReadiness(data), 'FIELD_CONNECTED');
  const degraded = await probeNode(async () => response({ ...status, status: 'degraded', mobile_tx_enabled: false, gateway_found: false }));
  assert.equal(nodeApiReadiness(degraded), 'FIELD_API_NOT_READY');
  const missingTxFlag = await probeNode(async () => response({ ...status, mobile_tx_enabled: undefined }));
  assert.equal(nodeApiReadiness(missingTxFlag), 'FIELD_API_NOT_READY');
  await assert.rejects(probeNode(async () => response({ ...status, api_version: 99 })), /belum kompatibel/);
  await assert.rejects(probeNode(async () => response(status, 200, 'text/html')), /bukan JSON/);
});

test('koneksi terputus setelah status terverifikasi: tidak ada POST SOS', async () => {
  let calls = 0;
  await probeNode(async () => { calls += 1; return response(status); });
  await assert.rejects(deliverSos({ request_id: 'sos-1' }, async () => { calls += 1; throw new TypeError('network lost'); }), error => error.code === 'NETWORK');
  assert.equal(calls, 2, 'connection loss on the fresh pre-SOS probe prevents POST');
});

test('izin GPS ditolak ditampilkan sebagai error izin, bukan koordinat palsu', async () => {
  const geolocation = { getCurrentPosition(_success, failure) { failure({ code: 1 }); } };
  await assert.rejects(getBrowserLocation(geolocation), error => error.code === 'GPS_DENIED' && /Izin lokasi ditolak/.test(error.message));
});

test('SOS berhasil hanya setelah ACK valid dengan request_id yang sama', async () => {
  const now = 1_000_000;
  const packet = makeSosPacket(user, location, 'req-123', now);
  assert.deepEqual(packet, {
    ...user, request_id: 'req-123', sos: true, timestamp: 1000, has_gps: true,
    lat: -6.2088, lon: 106.8456, accuracy: 6.8, gps_timestamp: 1000,
  });
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? response(status) : response({ service: 'rescuenet-field-node', accepted: true, request_id: packet.request_id, node_id: 1, state: 'queued' }, 202);
  };
  const result = await deliverSos(packet, fetcher);
  assert.equal(result.ack.request_id, 'req-123');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/status$/);
  assert.match(calls[1].url, /\/api\/sos$/);
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'req-123');
  assert.deepEqual(JSON.parse(calls[1].options.body), packet);
});

test('SOS gagal jika HTTP gagal atau ACK tidak cocok; hasil tidak dianggap terkirim', async t => {
  await t.test('HTTP 503', async () => {
    let count = 0;
    await assert.rejects(deliverSos({ request_id: 'req-503' }, async () => ++count === 1 ? response(status) : response({ accepted: false }, 503)), /HTTP 503/);
  });
  await t.test('wrong request id', async () => {
    let count = 0;
    await assert.rejects(deliverSos({ request_id: 'req-a' }, async () => ++count === 1 ? response(status) : response({ service: 'rescuenet-field-node', accepted: true, request_id: 'req-b' })), error => error.code === 'ACK');
  });
  await t.test('portal HTML', async () => {
    let count = 0;
    await assert.rejects(deliverSos({ request_id: 'req-html' }, async () => ++count === 1 ? response(status) : response('<html/>', 200, 'text/html')), error => error.code === 'INCOMPATIBLE');
  });
});

test('tanpa GPS valid mengikuti payload Android has_gps:false tanpa koordinat', () => {
  const packet = makeSosPacket(user, { ...location, timestamp: 1 }, 'req-no-gps', 1_000_000);
  assert.deepEqual(packet, { ...user, request_id: 'req-no-gps', sos: true, timestamp: 1000, has_gps: false });
});

test('tracking lokasi mengikuti interval/movement native dan payload mobile wire', async () => {
  assert.equal(shouldQueueLocation(null, location), true);
  assert.equal(shouldQueueLocation(location, { ...location, timestamp: location.timestamp + 10_000, lat: location.lat + 0.001 }), false);
  assert.equal(shouldQueueLocation(location, { ...location, timestamp: location.timestamp + 16_000, lat: location.lat + 0.001 }), true);
  assert.equal(shouldQueueLocation(location, { ...location, timestamp: location.timestamp + 30_000 }), true);
  assert.equal(shouldQueueLocation(location, { ...location, timestamp: location.timestamp + 30_000 }, 60_000), false);
  assert.equal(shouldQueueLocation(location, { ...location, timestamp: location.timestamp + 60_000 }, 60_000), true);
  const packet = makeLocationPacket(user, location, 'loc-123', location.timestamp);
  assert.deepEqual(packet, { ...user, request_id: 'loc-123', timestamp: 1000, has_gps: true,
    lat: location.lat, lon: location.lon, accuracy: location.accuracy });
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? response(status) : response({ service: 'rescuenet-field-node', accepted: true, request_id: 'loc-123', node_id: 1, state: 'queued' }, 202);
  };
  const result = await deliverLocation(packet, fetcher);
  assert.equal(result.ack.request_id, 'loc-123');
  assert.match(calls[1].url, /\/api\/location$/);
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'loc-123');
  assert.deepEqual(JSON.parse(calls[1].options.body), packet);
});

test('tracking tidak menyebut lokasi terkirim tanpa ACK Field Node yang sesuai', async () => {
  const packet = makeLocationPacket(user, location, 'loc-no-ack', location.timestamp);
  let calls = 0;
  await assert.rejects(deliverLocation(packet, async () => {
    calls += 1;
    return calls === 1 ? response(status) : response({ service: 'rescuenet-field-node', accepted: true, request_id: 'different-id' });
  }), error => error.code === 'ACK');
});

test('profil menormalisasi input, mempertahankan ID saat edit, dan tidak ikut mengubah wire mobile', () => {
  const profile = normalizeProfile({ user_id: 'stable-1', name: '  Riko   Dharmawan ', role: 'rescuer', team: 'Tim A' });
  assert.deepEqual(profile, { user_id: 'stable-1', name: 'Riko Dharmawan', role: 'rescuer', team: 'Tim A' });
  const edited = normalizeProfile({ user_id: 'new-id-must-not-win', name: 'Riko D', role: 'survivor' }, profile);
  assert.equal(edited.user_id, profile.user_id);
  assert.throws(() => normalizeProfile({ name: ' ' }), error => error.code === 'PROFILE');
  const packet = makeSosPacket(profile, null, 'sos-profile', 1_000_000);
  assert.deepEqual(Object.keys(packet).sort(), ['has_gps', 'name', 'request_id', 'sos', 'timestamp', 'user_id'].sort());
});

test('lokasi buruk/stale ditolak dan umur fix tidak menjadi negatif untuk timestamp masa depan', () => {
  assert.equal(shouldQueueLocation(null, { ...location, accuracy: 400 }), false);
  assert.throws(() => makeLocationPacket(user, { ...location, accuracy: 251 }, 'loc-poor', location.timestamp), error => error.code === 'GPS_FAILED');
  assert.equal(locationAgeMs({ timestamp: 9_000 }, 10_000), 1_000);
  assert.equal(locationAgeMs({ timestamp: 11_000 }, 10_000), 0);
});

test('origin node hanya menerima HTTP(S) origin dan menolak URL berisi kredensial/path', () => {
  assert.equal(normalizeNodeOrigin(' http://192.168.4.1/ '), 'http://192.168.4.1');
  assert.equal(normalizeNodeOrigin('https://node.local:8443'), 'https://node.local:8443');
  assert.throws(() => normalizeNodeOrigin('file:///tmp/node'), error => error.code === 'NODE_URL');
  assert.throws(() => normalizeNodeOrigin('http://user:pass@192.168.4.1'), error => error.code === 'NODE_URL');
  assert.throws(() => normalizeNodeOrigin('http://192.168.4.1/api'), error => error.code === 'NODE_URL');
});

test('pending location memakai retry backoff terbatas dan menolak fix expired/future', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(locationRetryDelayMs), [5_000, 10_000, 20_000, 40_000, 80_000]);
  assert.equal(locationRetryDelayMs(0), 0);
  assert.equal(locationRetryDelayMs(10), 120_000);
  assert.equal(isPendingLocationStale({ timestamp: 880 }, 1_000_000), false);
  assert.equal(isPendingLocationStale({ timestamp: 879 }, 1_000_000), true);
  assert.equal(isPendingLocationStale({ timestamp: 1_006 }, 1_000_000), true);
  assert.equal(isPendingLocationStale({}, 1_000_000), true);
});
