import * as Location from 'expo-location';
import { PermissionsAndroid, Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { SETTINGS } from '../config/settings';
import type { PhoneLocation, TrackingMode } from '../models';
import { clearPendingLocation, deleteSetting, readSetting, writeSetting } from '../storage/Database';
import { isFreshLocation, shouldQueueLocation } from '../utils/location';
import { fromNative, rememberLocation, requireForegroundPermission } from './LocationService';
import { notify, reportError } from './events';
import { outbox } from './runtime';

let watcher: Location.LocationSubscription | null = null;
let watchGeneration = 0;
let watchStarting = false;
export function receiveLocation(location: PhoneLocation): void {
  if (!isFreshLocation(location)) return;
  rememberLocation(location);
  if ((readSetting('tracking') ?? 'off') === 'off') return;
  const user = readSetting('user');
  if (!user || !shouldQueueLocation(readSetting('lastQueuedLocation'), location)) return;
  const id = randomUUID();
  outbox.enqueue({ id, kind: 'location', payload: { ...user, ...location,
    timestamp: Math.floor(location.timestamp / 1000), has_gps: true, request_id: id },
    status: 'QUEUED', attempts: 0, nextAttemptAt: 0, lastError: null, deliveredAt: null });
  writeSetting('lastQueuedLocation', location);
  void outbox.flush().catch(reportError);
}
export function suspendForegroundWatcher(): void { watchGeneration++; watcher?.remove(); watcher = null; }
export async function resumeForegroundWatcher(): Promise<void> {
  if (watcher || watchStarting || readSetting('tracking') !== 'foreground') return;
  watchStarting = true;
  const generation = watchGeneration;
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) throw new Error('Tracking terhenti: izin lokasi tidak tersedia.');
    const subscription = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High,
      timeInterval: 5000, distanceInterval: 0 }, value => {
        try { receiveLocation(fromNative(value)); } catch (error) { reportError(error); }
      }, reason => { reportError(new Error(`GPS NO FIX: ${reason}`)); });
    if (generation !== watchGeneration || readSetting('tracking') !== 'foreground') subscription.remove();
    else watcher = subscription;
  } finally { watchStarting = false; }
}
export async function startTracking(background: boolean): Promise<void> {
  await requireForegroundPermission();
  if (background) {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      const notifications = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (notifications !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Izinkan notifikasi agar tracking background terlihat. Anda tetap dapat memakai tracking foreground.');
    }
    const permission = await Location.requestBackgroundPermissionsAsync();
    if (!permission.granted) throw new Error('Izin lokasi latar belakang belum diberikan. Pilih foreground saja atau izinkan lokasi sepanjang waktu di Pengaturan.');
  }
  const mode: TrackingMode = background ? 'background' : 'foreground';
  deleteSetting('lastQueuedLocation');
  writeSetting('tracking', mode);
  deleteSetting('trackingError');
  try {
    if (background) {
      await Location.startLocationUpdatesAsync(SETTINGS.backgroundTask, {
        accuracy: Location.Accuracy.High, timeInterval: 15000, distanceInterval: 0,
        deferredUpdatesInterval: SETTINGS.trackingIntervalMs,
        pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true,
        foregroundService: { notificationTitle: 'RescueNet',
          notificationBody: 'Emergency Location Tracking Active', notificationColor: '#17334c', killServiceOnDestroy: true },
      });
    } else await resumeForegroundWatcher();
  } catch (error) {
    writeSetting('tracking', 'off');
    suspendForegroundWatcher();
    notify();
    throw error;
  }
  notify();
}
export async function stopTracking(): Promise<void> {
  // Consent is revoked first, including when a native stop operation fails.
  writeSetting('tracking', 'off');
  suspendForegroundWatcher();
  clearPendingLocation();
  deleteSetting('lastQueuedLocation');
  notify();
  if (await Location.hasStartedLocationUpdatesAsync(SETTINGS.backgroundTask)) {
    await Location.stopLocationUpdatesAsync(SETTINGS.backgroundTask);
  }
}
export async function reconcileTracking(): Promise<void> {
  const mode = readSetting('tracking') ?? 'off';
  if (mode === 'background') {
    const permission = await Location.getBackgroundPermissionsAsync();
    if (!permission.granted || !await Location.hasStartedLocationUpdatesAsync(SETTINGS.backgroundTask)) {
      await stopTracking();
      throw new Error('Tracking background tidak aktif lagi. Tekan START untuk mengaktifkan ulang.');
    }
  } else if (mode === 'foreground') {
    try { await resumeForegroundWatcher(); }
    catch (error) { await stopTracking(); throw error; }
  } else if (await Location.hasStartedLocationUpdatesAsync(SETTINGS.backgroundTask)) {
    await Location.stopLocationUpdatesAsync(SETTINGS.backgroundTask);
  }
}
