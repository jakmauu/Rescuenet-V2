export interface User { user_id: string; name: string }
export interface PhoneLocation {
  lat: number;
  lon: number;
  accuracy: number | null;
  timestamp: number;
}
export type GpsPayload = { has_gps: false } | ({ has_gps: true } & PhoneLocation);
export type LocationPacket = User & PhoneLocation & { request_id: string; has_gps: true };
export type SosPacket = User & GpsPayload & { request_id: string; sos: true; timestamp: number; gps_timestamp?: number };
export type TransmissionStatus = 'READY' | 'SENDING' | 'DELIVERED' | 'QUEUED' | 'FAILED';
export interface QueueItem {
  id: string;
  kind: 'sos' | 'location';
  payload: SosPacket | LocationPacket;
  status: TransmissionStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  deliveredAt: number | null;
}
export interface NodeStatus { service: 'rescuenet-field-node'; api_version: 1; node_id: number }
export type NetworkState = 'CHECKING' | 'CONNECTED' | 'UNAVAILABLE' | 'INCOMPATIBLE';
export type TrackingMode = 'off' | 'foreground' | 'background';
