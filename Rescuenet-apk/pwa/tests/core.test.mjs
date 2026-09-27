import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverSos, getBrowserLocation, makeSosPacket, NodeApiError, probeNode } from '../core.mjs';

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

test('Field Node hanya lolos verifikasi dengan status API aktual dan ready', async () => {
  const data = await probeNode(async () => response(status));
  assert.equal(data.node_id, 1);
  await assert.rejects(probeNode(async () => response({ ...status, status: 'degraded' })), /belum kompatibel|tidak siap/);
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
