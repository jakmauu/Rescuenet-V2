import type { QueueItem } from '../models';
import type { QueueRepository } from './QueueRepository';

type Binding = string | number | null;
export interface QueueDatabase {
  runSync(sql: string, ...parameters: Binding[]): unknown;
  getFirstSync<T>(sql: string, ...parameters: Binding[]): T | null;
  withTransactionSync(action: () => void): void;
}
export const OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL, nextAttemptAt REAL NOT NULL,
  lastError TEXT, deliveredAt REAL, createdAt REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, nextAttemptAt);`;
export const RECOVER_OUTBOX = "UPDATE outbox SET status='QUEUED', nextAttemptAt=0 WHERE status='SENDING'";
export interface StoredItem extends Omit<QueueItem, 'payload'> { payload: string }
export function decodeItem(row: StoredItem): QueueItem { return { ...row, payload: JSON.parse(row.payload) as QueueItem['payload'] }; }
export function createQueueRepository(database: () => QueueDatabase, onLocationDelivered: (time: number) => void = () => {}, now = Date.now): QueueRepository {
  return {
    put(item) {
      const connection = database();
      connection.withTransactionSync(() => {
        if (item.kind === 'location') connection.runSync("DELETE FROM outbox WHERE kind='location' AND status IN ('QUEUED','DELIVERED')");
        connection.runSync('INSERT INTO outbox(id,kind,payload,status,attempts,nextAttemptAt,lastError,deliveredAt,createdAt) VALUES(?,?,?,?,?,?,?,?,?)',
          item.id, item.kind, JSON.stringify(item.payload), item.status, item.attempts, item.nextAttemptAt, item.lastError, item.deliveredAt, now());
      });
    },
    get(id) { const row = database().getFirstSync<StoredItem>('SELECT * FROM outbox WHERE id=?', id); return row ? decodeItem(row) : null; },
    next(time) {
      const row = database().getFirstSync<StoredItem>("SELECT * FROM outbox WHERE status='QUEUED' AND nextAttemptAt<=? ORDER BY CASE kind WHEN 'sos' THEN 0 ELSE 1 END, createdAt LIMIT 1", time);
      return row ? decodeItem(row) : null;
    },
    update(item) {
      database().withTransactionSync(() => {
        database().runSync('UPDATE outbox SET status=?,attempts=?,nextAttemptAt=?,lastError=?,deliveredAt=? WHERE id=?',
          item.status, item.attempts, item.nextAttemptAt, item.lastError, item.deliveredAt, item.id);
        if (item.kind === 'location' && item.status === 'DELIVERED' && item.deliveredAt !== null) onLocationDelivered(item.deliveredAt);
      });
    },
  };
}
