export const SETTINGS = {
  nodeUrl: 'http://192.168.4.1',
  requestTimeoutMs: 6000,
  trackingIntervalMs: 30_000,
  movementMeters: 25,
  minimumMovementIntervalMs: 15_000,
  gpsMaxAgeMs: 120_000,
  retryMaxMs: 5 * 60_000,
  foregroundRetryMs: 15_000,
  backgroundTask: 'rescuenet-phone-location-v1',
} as const;
