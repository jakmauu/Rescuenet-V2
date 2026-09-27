import * as Location from 'expo-location';
import type { PhoneLocation } from '../models';
import { notify } from './events';
import { readSetting, writeSetting } from '../storage/Database';

export function fromNative(location: Location.LocationObject): PhoneLocation {
  return { lat: location.coords.latitude, lon: location.coords.longitude,
    accuracy: location.coords.accuracy, timestamp: location.timestamp };
}
export async function requireForegroundPermission(): Promise<void> {
  const current = await Location.getForegroundPermissionsAsync();
  const result = current.granted ? current : await Location.requestForegroundPermissionsAsync();
  if (!result.granted) throw new Error('Izin lokasi ditolak. SOS tanpa GPS tetap tersedia. Aktifkan izin melalui Pengaturan bila diperlukan.');
  if (!await Location.hasServicesEnabledAsync()) throw new Error('GPS/layanan lokasi HP mati. Aktifkan di Pengaturan; SOS tetap tersedia.');
}
export function rememberLocation(location: PhoneLocation): void {
  const previous = readSetting('location');
  if (!previous || previous.timestamp <= location.timestamp) {
    writeSetting('location', location);
    notify();
  }
}
export async function refreshGps(): Promise<void> {
  await requireForegroundPermission();
  // Native one-shot requests can take a long time indoors. Bound UI waiting time.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const location = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GPS NO FIX: belum mendapat posisi dalam 20 detik. Coba di luar ruangan. SOS tidak perlu menunggu GPS.')), 20000); }),
    ]);
    rememberLocation(fromNative(location));
  } finally { if (timer) clearTimeout(timer); }
}
