import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueItem } from '../src/models';
import { OutboxService } from '../src/services/OutboxService';
import { createQueueRepository, OUTBOX_SCHEMA, RECOVER_OUTBOX } from '../src/storage/SqliteQueueRepository';
import type { QueueDatabase } from '../src/storage/SqliteQueueRepository';
import { makeSos } from '../src/utils/location';

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(OUTBOX_SCHEMA);
  db.exec(RECOVER_OUTBOX);
  const adapter: QueueDatabase = {
    runSync: (sql, ...parameters) => db.prepare(sql).run(...parameters),
    getFirstSync: <T>(sql: string, ...parameters: (string | number | null)[]) => (db.prepare(sql).get(...parameters) as T | undefined) ?? null,
    withTransactionSync(action) {
      db.exec('BEGIN');
      try { action(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, repository: createQueueRepository(() => adapter) };
}
function item(id: string, kind: 'sos' | 'location' = 'sos'): QueueItem {
  const user = { user_id: 'USR-test', name: 'Test' };
  return { id, kind, payload: kind === 'sos' ? makeSos(user, null, id) : {
    ...user, request_id: id, has_gps: true, lat: -6, lon: 106, accuracy: 5, timestamp: 1789551200 },
    status: 'QUEUED', attempts: 0, nextAttemptAt: 0, lastError: null, deliveredAt: null };
}
test('SQLite persists every SOS; ordinary locations coalesce and SOS take priority', () => {
  const { db, repository } = open();
  try {
    repository.put(item('loc1', 'location'));
    repository.put(item('sos1'));
    repository.put(item('sos2'));
    repository.put(item('loc2', 'location'));
    assert.equal(repository.get('loc1'), null);
    assert.ok(repository.get('loc2'));
    assert.ok(repository.get('sos1'));
    assert.ok(repository.get('sos2'));
    assert.equal(repository.next(Date.now())?.kind, 'sos');
  } finally { db.close(); }
});
test('failed HTTP leaves SOS durable with attempts/backoff; restart recovers in-flight SOS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rescuenet-test-'));
  const file = join(directory, 'queue.db');
  let store = open(file);
  try {
    const worker = new OutboxService(store.repository, { send: async () => { throw new Error('offline'); } }, undefined, () => 1000);
    worker.enqueue(item('offline-sos'));
    await worker.flush();
    assert.equal(store.repository.get('offline-sos')?.status, 'QUEUED');
    assert.equal(store.repository.get('offline-sos')?.attempts, 1);
    assert.equal(store.repository.get('offline-sos')?.lastError, 'offline');
    assert.equal(store.repository.next(1001), null);
    store.repository.put({ ...item('interrupted'), status: 'SENDING', attempts: 1 });
    store.db.close();
    store = open(file);
    assert.equal(store.repository.get('interrupted')?.status, 'QUEUED');
    assert.equal(store.repository.get('offline-sos')?.attempts, 1);
    const sent: string[] = [];
    const recovered = new OutboxService(store.repository, { send: async (_kind, payload) => { sent.push(payload.request_id); } }, undefined, () => 999999);
    await recovered.flush();
    assert.deepEqual(new Set(sent), new Set(['offline-sos', 'interrupted']));
    assert.equal(store.repository.get('offline-sos')?.status, 'DELIVERED');
    assert.equal(store.repository.get('offline-sos')?.attempts, 2);
    assert.equal(store.repository.get('interrupted')?.deliveredAt, 999999);
  } finally { store.db.close(); rmSync(directory, { recursive: true }); }
});
test('concurrent flush calls share one worker and persist SENDING before HTTP', async () => {
  const { db, repository } = open();
  try {
    let sent = 0;
    const worker = new OutboxService(repository, { send: async () => {
      sent++;
      assert.equal(repository.get('same')?.status, 'SENDING');
      await new Promise(resolve => setTimeout(resolve, 5));
    } });
    worker.enqueue(item('same'));
    await Promise.all([worker.flush(), worker.flush(), worker.flush()]);
    assert.equal(sent, 1);
    assert.equal(repository.get('same')?.status, 'DELIVERED');
  } finally { db.close(); }
});
test('replacement transaction rollback preserves prior location on storage failure', () => {
  const { db, repository } = open();
  try {
    repository.put(item('keep-location', 'location'));
    repository.put(item('duplicate-id'));
    assert.throws(() => repository.put(item('duplicate-id', 'location')));
    assert.ok(repository.get('keep-location'));
    assert.equal(repository.get('duplicate-id')?.kind, 'sos');
  } finally { db.close(); }
});
test('location replacement never deletes in-flight item or any SOS history', async () => {
  const { db, repository } = open();
  try {
    const worker = new OutboxService(repository, { send: async () => {} });
    worker.enqueue(item('delivered-sos'));
    await worker.flush();
    repository.put({ ...item('in-flight', 'location'), status: 'SENDING' });
    repository.put(item('new-location', 'location'));
    assert.equal(repository.get('delivered-sos')?.status, 'DELIVERED');
    assert.equal(repository.get('in-flight')?.status, 'SENDING');
    assert.equal(repository.get('new-location')?.status, 'QUEUED');
  } finally { db.close(); }
});
test('failed earlier SOS does not prevent trying a newer SOS in the same flush', async () => {
  const { db, repository } = open();
  try {
    const attempted: string[] = [];
    const worker = new OutboxService(repository, { send: async (_kind, packet) => {
      attempted.push(packet.request_id);
      if (packet.request_id === 'first') throw new Error('temporary failure');
    } });
    worker.enqueue(item('first'));
    worker.enqueue(item('second'));
    await worker.flush();
    assert.deepEqual(attempted, ['first', 'second']);
    assert.equal(repository.get('first')?.status, 'QUEUED');
    assert.equal(repository.get('second')?.status, 'DELIVERED');
  } finally { db.close(); }
});
test('enqueue failure is surfaced and cannot lead to a network-only SOS', async () => {
  let sent = false;
  const worker = new OutboxService({ put() { throw new Error('disk full'); }, get: () => null,
    next: () => null, update: () => {} }, { send: async () => { sent = true; } });
  assert.throws(() => worker.enqueue(item('cannot-save')), /disk full/);
  await worker.flush();
  assert.equal(sent, false);
});
