import { randomUUID } from 'expo-crypto';
import type { User } from '../models';
import { readSetting, writeSetting } from './Database';
import { notify } from '../services/events';

export function createUser(name: string): User {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 2 || cleaned.length > 60) throw new Error('Isi nama dengan 2–60 karakter.');
  const existing = readSetting('user');
  const user = { name: cleaned, user_id: existing?.user_id ?? `USR-${randomUUID()}` };
  writeSetting('user', user);
  notify();
  return user;
}
