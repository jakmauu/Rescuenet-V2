import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RescueNetApi } from '../src/services/RescueNetApi';
import { makeSos } from '../src/utils/location';

const sos = makeSos({ user_id: 'USR-test', name: 'Test' }, null, 'request-123');
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
test('local POST includes stable idempotency key without any internet check', async () => {
  let called = false;
  const api = new RescueNetApi(async (url, options) => {
    called = true;
    assert.equal(url, 'http://192.168.4.1/api/sos');
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options?.headers).get('Idempotency-Key'), sos.request_id);
    assert.deepEqual(JSON.parse(String(options?.body)), sos);
    return json({ service: 'rescuenet-field-node', accepted: true, request_id: sos.request_id });
  });
  await api.send('sos', sos);
  assert.ok(called);
});
test('legacy HTML/captive portal cannot acknowledge SOS', async () => {
  const api = new RescueNetApi(async () => new Response('<html>Portal</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(api.send('sos', sos), /bukan JSON/);
});
test('rejects wrong id, false accepted, unrelated JSON and missing service marker', async () => {
  for (const response of [null, [], {}, { accepted: true, request_id: sos.request_id },
    { service: 'rescuenet-field-node', accepted: false, request_id: sos.request_id },
    { service: 'rescuenet-field-node', accepted: true, request_id: 'wrong' }]) {
    await assert.rejects(new RescueNetApi(async () => json(response)).send('sos', sos), /mengonfirmasi/);
  }
});
test('invalid JSON and non-2xx responses stay failures', async () => {
  await assert.rejects(new RescueNetApi(async () => new Response('{', { headers: { 'Content-Type': 'application/json' } })).send('sos', sos), /tidak valid/);
  for (const status of [302, 404, 500]) await assert.rejects(new RescueNetApi(async () => json({}, status)).send('sos', sos), /HTTP/);
});
test('timeout aborts transport and returns an actionable failure', async () => {
  let aborted = false;
  const api = new RescueNetApi((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }), 10);
  await assert.rejects(api.send('sos', sos), /waktu permintaan habis/);
  assert.ok(aborted);
});
test('node probe validates service, version, and numeric node identity', async () => {
  const valid = { service: 'rescuenet-field-node', api_version: 1, node_id: 2 };
  assert.deepEqual(await new RescueNetApi(async () => json(valid)).probe(), valid);
  for (const response of [{ ...valid, api_version: 2 }, { ...valid, node_id: 0 }, { ...valid, node_id: '2' }]) {
    await assert.rejects(new RescueNetApi(async () => json(response)).probe(), /kompatibel/);
  }
});
