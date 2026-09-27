import { randomUUID } from 'expo-crypto';
import { readSetting } from '../storage/Database';
import { makeSos } from '../utils/location';
import { outbox } from './runtime';
import { reportError } from './events';

export function sendSos(): string {
  const user = readSetting('user');
  if (!user) throw new Error('Simpan profil terlebih dahulu.');
  const id = randomUUID();
  const payload = makeSos(user, readSetting('location'), id);
  // SQLite commit precedes all network activity. No GPS wait and no tracking prerequisite.
  outbox.enqueue({ id, kind: 'sos', payload, status: 'QUEUED', attempts: 0,
    nextAttemptAt: 0, lastError: null, deliveredAt: null });
  void outbox.flush().catch(reportError);
  return id;
}
