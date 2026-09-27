import { SETTINGS } from '../config/settings';
import type { PhoneLocation, SosPacket, User } from '../models';

export function isFreshLocation(location: PhoneLocation | null, now = Date.now()): location is PhoneLocation {
  return location !== null && Number.isFinite(location.lat) && Number.isFinite(location.lon)
    && Math.abs(location.lat) <= 90 && Math.abs(location.lon) <= 180
    && Number.isFinite(location.timestamp) && now - location.timestamp >= -5000
    && now - location.timestamp <= SETTINGS.gpsMaxAgeMs
    && (location.accuracy === null || (Number.isFinite(location.accuracy) && location.accuracy >= 0));
}
export function distanceMeters(a: PhoneLocation, b: PhoneLocation): number {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
export function shouldQueueLocation(previous: PhoneLocation | null, current: PhoneLocation): boolean {
  if (!previous) return true;
  const elapsed = current.timestamp - previous.timestamp;
  return elapsed >= SETTINGS.trackingIntervalMs || (elapsed >= SETTINGS.minimumMovementIntervalMs
    && distanceMeters(previous, current) >= SETTINGS.movementMeters);
}
export function makeSos(user: User, location: PhoneLocation | null, id: string, now = Date.now()): SosPacket {
  const base = { ...user, request_id: id, sos: true as const, timestamp: Math.floor(now / 1000) };
  return isFreshLocation(location, now)
    ? { ...base, has_gps: true, lat: location.lat, lon: location.lon, accuracy: location.accuracy, gps_timestamp: Math.floor(location.timestamp / 1000) }
    : { ...base, has_gps: false };
}
