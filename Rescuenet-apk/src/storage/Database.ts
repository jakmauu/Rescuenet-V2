import * as SQLite from 'expo-sqlite';
import type { PhoneLocation, QueueItem, TrackingMode, User } from '../models';
import { createQueueRepository, decodeItem, OUTBOX_SCHEMA, RECOVER_OUTBOX } from './SqliteQueueRepository';
import type { StoredItem } from './SqliteQueueRepository';

let instance: SQLite.SQLiteDatabase | undefined;
export function db(): SQLite.SQLiteDatabase {
  if (instance) return instance;
  const connection = SQLite.openDatabaseSync('rescuenet-mobile.db');
  connection.execSync(`PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${OUTBOX_SCHEMA}
    ${RECOVER_OUTBOX};`);
  instance = connection;
  return connection;
}
interface Settings { user: User; location: PhoneLocation; lastQueuedLocation: PhoneLocation; tracking: TrackingMode; trackingError: string; lastLocationSent: number }
export function readSetting<K extends keyof Settings>(key: K): Settings[K] | null {
  const row = db().getFirstSync<{ value: string }>('SELECT value FROM settings WHERE key=?', key);
  if (!row) return null;
  // Do not reset corrupt persistent data silently. The UI reports the storage failure.
  return JSON.parse(row.value) as Settings[K];
}
export function writeSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  db().runSync('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}
export function deleteSetting(key: keyof Settings): void { db().runSync('DELETE FROM settings WHERE key=?', key); }
export const repository = createQueueRepository(db, time => writeSetting('lastLocationSent', time));
export function recentSos(): QueueItem[] {
  return db().getAllSync<StoredItem>("SELECT * FROM outbox WHERE kind='sos' ORDER BY createdAt DESC LIMIT 20").map(decodeItem);
}
export function pendingSosCount(): number {
  return db().getFirstSync<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE kind='sos' AND status!='DELIVERED'")?.count ?? 0;
}
export function lastLocationDelivery(): number | null {
  return readSetting('lastLocationSent');
}
export function retryNow(): void { db().runSync("UPDATE outbox SET nextAttemptAt=0 WHERE status='QUEUED'"); }
export function clearPendingLocation(): void { db().runSync("DELETE FROM outbox WHERE kind='location' AND status='QUEUED'"); }
