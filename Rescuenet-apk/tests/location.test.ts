import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreshLocation, makeSos, shouldQueueLocation, distanceMeters } from '../src/utils/location';
import type { PhoneLocation } from '../src/models';

const now = 1789551200000;
const user = { user_id: 'USR-test', name: 'Test User' };
const fix: PhoneLocation = { lat: -6.36, lon: 106.82, accuracy: 6.8, timestamp: now };
test('SOS without GPS never needs tracking or waits for a fix', () => {
  assert.deepEqual(makeSos(user, null, 'sos-1', now), { ...user, request_id: 'sos-1', sos: true, has_gps: false, timestamp: now / 1000 });
});
test('SOS uses fresh phone fix and separate seconds-based fix/event timestamps', () => {
  const sos = makeSos(user, { ...fix, timestamp: now - 30000 }, 'sos-2', now);
  assert.equal(sos.has_gps, true);
  assert.equal(sos.gps_timestamp, now / 1000 - 30);
  assert.equal(sos.timestamp, now / 1000);
  if (sos.has_gps) assert.equal(sos.accuracy, 6.8);
});
test('stale, invalid and future GPS excluded, but equator coordinates valid', () => {
  for (const location of [{ ...fix, timestamp: now - 120001 }, { ...fix, lat: NaN },
    { ...fix, lon: 181 }, { ...fix, accuracy: -1 }, { ...fix, timestamp: now + 5001 }]) {
    const sos = makeSos(user, location, 'sos', now);
    assert.equal(sos.has_gps, false);
    assert.equal('lat' in sos, false);
  }
  assert.equal(isFreshLocation({ ...fix, lat: 0, lon: 0, accuracy: null }, now), true);
});
test('tracking keeps 30s cadence and throttles movement to at least 15s', () => {
  assert.equal(shouldQueueLocation(null, fix), true);
  assert.equal(shouldQueueLocation(fix, { ...fix, timestamp: now + 29999 }), false);
  assert.equal(shouldQueueLocation(fix, { ...fix, timestamp: now + 30000 }), true);
  const moved = { ...fix, lat: fix.lat + 0.001 };
  assert.ok(distanceMeters(fix, moved) > 25);
  assert.equal(shouldQueueLocation(fix, { ...moved, timestamp: now + 14999 }), false);
  assert.equal(shouldQueueLocation(fix, { ...moved, timestamp: now + 15000 }), true);
  assert.equal(shouldQueueLocation(fix, { ...moved, timestamp: now - 1 }), false);
});
