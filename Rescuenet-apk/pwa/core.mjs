export const DEFAULT_NODE_URL = 'http://192.168.4.1';
export const NODE_URL = (typeof window !== 'undefined' && window.location.hostname === '192.168.4.1') ? '' : DEFAULT_NODE_URL;
export const LOCATION_MAX_AGE_MS = 120_000;
export const REQUEST_TIMEOUT_MS = 3_000;
export const TRACKING_INTERVAL_MS = 30_000;
export const MIN_MOVEMENT_INTERVAL_MS = 15_000;
export const MOVEMENT_THRESHOLD_METERS = 25;
export const MAX_LOCATION_ACCURACY_METERS = 250;

export class NodeApiError extends Error {
  constructor(message, code = 'NODE_ERROR') { super(message); this.name = 'NodeApiError'; this.code = code; }
}

function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function verifyNodeStatus(data) {
  return isRecord(data)
    && data.service === 'rescuenet-field-node'
    && data.api_version === 1
    && Number.isInteger(data.node_id) && data.node_id > 0
    && data.device === 'field_node'
    && data.status === 'ready'
    && data.mobile_protocol === 1
    && data.mobile_tx_enabled === true;
}

async function fetchWithTimeout(fetcher, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw new NodeApiError('Waktu tunggu Field Node habis (timeout). Pastikan sudah terhubung ke Wi-Fi RescueNet-Node.', 'TIMEOUT');
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http://')) {
      throw new NodeApiError('Safari/iOS mungkin memblokir PWA HTTPS saat mengakses API Field Node HTTP lokal (mixed content atau izin jaringan lokal). CORS saja tidak dapat melewati batas keamanan ini. Periksa koneksi Wi-Fi; untuk operasi konsisten diperlukan HTTPS lokal tepercaya atau aplikasi iOS native.', 'BROWSER_BLOCKED');
    }
    throw new NodeApiError('Field Node tidak dapat dijangkau. Pastikan Wi-Fi terhubung ke RescueNet-Node.', 'NETWORK');
  } finally { clearTimeout(timer); }
}

async function readJson(response) {
  if (!response.ok) throw new NodeApiError(`Field Node menolak permintaan (HTTP ${response.status}).`, 'HTTP');
  if (!(response.headers?.get?.('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new NodeApiError('Field Node membalas bukan JSON. API mobile tidak terverifikasi.', 'INCOMPATIBLE');
  }
  try { return await response.json(); }
  catch { throw new NodeApiError('Balasan JSON Field Node tidak valid.', 'INCOMPATIBLE'); }
}

function endpoint(baseUrl, path) { return `${baseUrl ?? NODE_URL}${path}`; }

export async function probeNode(fetcher = fetch, timeoutMs = REQUEST_TIMEOUT_MS, baseUrl = NODE_URL) {
  const response = await fetchWithTimeout(fetcher, endpoint(baseUrl, '/api/status'), {
    method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', targetAddressSpace: 'local',
  }, timeoutMs);
  const data = await readJson(response);
  if (!verifyNodeStatus(data)) {
    throw new NodeApiError('API Field Node belum kompatibel atau node sedang tidak siap.', 'INCOMPATIBLE');
  }
  return data;
}

export function makeSosPacket(user, location, requestId, now = Date.now()) {
  if (!user || typeof user.user_id !== 'string' || !user.user_id || typeof user.name !== 'string' || !user.name.trim()) {
    throw new NodeApiError('Isi dan simpan nama pelapor terlebih dahulu.', 'PROFILE');
  }
  const base = {
    user_id: user.user_id,
    name: user.name.trim(),
    request_id: requestId,
    sos: true,
    timestamp: Math.floor(now / 1000),
  };
  const fresh = location && Number.isFinite(location.lat) && Math.abs(location.lat) <= 90
    && Number.isFinite(location.lon) && Math.abs(location.lon) <= 180
    && Number.isFinite(location.timestamp) && now - location.timestamp >= -5_000
    && now - location.timestamp <= LOCATION_MAX_AGE_MS
    && (location.accuracy === null || (Number.isFinite(location.accuracy) && location.accuracy >= 0 && location.accuracy <= MAX_LOCATION_ACCURACY_METERS));
  return fresh
    ? { ...base, has_gps: true, lat: location.lat, lon: location.lon, accuracy: location.accuracy, gps_timestamp: Math.floor(location.timestamp / 1000) }
    : { ...base, has_gps: false };
}

export function verifySosAck(data, requestId) {
  return isRecord(data) && data.service === 'rescuenet-field-node'
    && data.accepted === true && data.request_id === requestId;
}

export function makeLocationPacket(user, location, requestId, now = Date.now()) {
  if (!user || typeof user.user_id !== 'string' || !user.user_id || typeof user.name !== 'string' || !user.name.trim()) {
    throw new NodeApiError('Isi dan simpan nama pelapor terlebih dahulu.', 'PROFILE');
  }
  if (!location || !Number.isFinite(location.lat) || Math.abs(location.lat) > 90
    || !Number.isFinite(location.lon) || Math.abs(location.lon) > 180
    || !Number.isFinite(location.timestamp) || now - location.timestamp < -5_000 || now - location.timestamp > LOCATION_MAX_AGE_MS
    || (location.accuracy !== null && (!Number.isFinite(location.accuracy) || location.accuracy < 0 || location.accuracy > MAX_LOCATION_ACCURACY_METERS))) {
    throw new NodeApiError('Fix GPS belum tersedia atau sudah terlalu lama untuk dibagikan.', 'GPS_FAILED');
  }
  return { user_id: user.user_id, name: user.name.trim(), request_id: requestId, timestamp: Math.floor(location.timestamp / 1000), has_gps: true,
    lat: location.lat, lon: location.lon, accuracy: location.accuracy };
}

export function shouldQueueLocation(previous, current, intervalMs = TRACKING_INTERVAL_MS) {
  if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lon)
    || !Number.isFinite(current.timestamp) || Math.abs(current.lat) > 90 || Math.abs(current.lon) > 180
    || (current.accuracy !== null && (!Number.isFinite(current.accuracy) || current.accuracy < 0 || current.accuracy > MAX_LOCATION_ACCURACY_METERS))) return false;
  if (!previous) return true;
  const elapsed = current.timestamp - previous.timestamp;
  if (elapsed >= intervalMs) return true;
  if (elapsed < MIN_MOVEMENT_INTERVAL_MS) return false;
  const radians = Math.PI / 180;
  const dLat = (current.lat - previous.lat) * radians;
  const dLon = (current.lon - previous.lon) * radians;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(previous.lat * radians) * Math.cos(current.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a)))) >= MOVEMENT_THRESHOLD_METERS;
}

export function normalizeProfile(input, existing = null) {
  const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  const role = ['survivor', 'rescuer'].includes(input?.role) ? input.role : 'survivor';
  const team = typeof input?.team === 'string' ? input.team.trim().slice(0, 32) : '';
  if (name.length < 2 || name.length > 60) throw new NodeApiError('Nama harus terdiri dari 2–60 karakter.', 'PROFILE');
  return { user_id: existing?.user_id || input?.user_id, name, role, team };
}

export function locationAgeMs(location, now = Date.now()) {
  if (!Number.isFinite(location?.timestamp)) return Infinity;
  return Math.max(0, now - location.timestamp);
}

export function normalizeNodeOrigin(value) {
  let parsed;
  try { parsed = new URL(typeof value === 'string' ? value.trim() : ''); }
  catch { throw new NodeApiError('Alamat harus berupa URL HTTP/HTTPS yang valid.', 'NODE_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new NodeApiError('Masukkan hanya origin, misalnya http://192.168.4.1.', 'NODE_URL');
  }
  return parsed.origin;
}

export function locationRetryDelayMs(failedAttempts) {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) return 0;
  return Math.min(120_000, 5_000 * (2 ** Math.min(failedAttempts - 1, 5)));
}

export function isPendingLocationStale(packet, now = Date.now()) {
  if (!Number.isFinite(packet?.timestamp)) return true;
  const ageSeconds = now / 1000 - packet.timestamp;
  return ageSeconds < -5 || ageSeconds > LOCATION_MAX_AGE_MS / 1000;
}

export async function transmitLocation(packet, fetcher = fetch, timeoutMs = REQUEST_TIMEOUT_MS, baseUrl = NODE_URL) {
  const response = await fetchWithTimeout(fetcher, endpoint(baseUrl, '/api/location'), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': packet.request_id },
    body: JSON.stringify(packet), cache: 'no-store', targetAddressSpace: 'local',
  }, timeoutMs);
  const ack = await readJson(response);
  if (!verifySosAck(ack, packet.request_id)) throw new NodeApiError('Field Node belum mengonfirmasi lokasi terbaru.', 'ACK');
  return ack;
}

export async function deliverLocation(packet, fetcher = fetch, timeoutMs = REQUEST_TIMEOUT_MS, baseUrl = NODE_URL) {
  const status = await probeNode(fetcher, timeoutMs, baseUrl);
  const ack = await transmitLocation(packet, fetcher, timeoutMs, baseUrl);
  return { status, ack };
}

export async function transmitSos(packet, fetcher = fetch, timeoutMs = REQUEST_TIMEOUT_MS, baseUrl = NODE_URL) {
  const response = await fetchWithTimeout(fetcher, endpoint(baseUrl, '/api/sos'), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': packet.request_id },
    body: JSON.stringify(packet), cache: 'no-store', targetAddressSpace: 'local',
  }, timeoutMs);
  const ack = await readJson(response);
  if (!verifySosAck(ack, packet.request_id)) {
    throw new NodeApiError('Field Node belum memberikan konfirmasi SOS yang valid. Pesan belum dinyatakan terkirim.', 'ACK');
  }
  return ack;
}

export async function deliverSos(packet, fetcher = fetch, timeoutMs = REQUEST_TIMEOUT_MS, baseUrl = NODE_URL) {
  const status = await probeNode(fetcher, timeoutMs, baseUrl);
  const ack = await transmitSos(packet, fetcher, timeoutMs, baseUrl);
  return { status, ack };
}

export function getBrowserLocation(geolocation = globalThis.navigator?.geolocation, options = {}) {
  if (!geolocation?.getCurrentPosition) return Promise.reject(new NodeApiError('Browser ini tidak menyediakan GPS/lokasi.', 'GPS_UNAVAILABLE'));
  return new Promise((resolve, reject) => geolocation.getCurrentPosition(
    ({ coords, timestamp }) => resolve({ lat: coords.latitude, lon: coords.longitude, accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null, timestamp }),
    error => reject(new NodeApiError(error.code === 1 ? 'Izin lokasi ditolak. Buka Pengaturan Safari dan izinkan lokasi untuk RescueNet.' : error.code === 2 ? 'GPS belum mendapatkan posisi. Coba di luar ruangan.' : 'Pencarian GPS melewati batas waktu. Coba lagi.', error.code === 1 ? 'GPS_DENIED' : 'GPS_FAILED')),
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0, ...options },
  ));
}

export function createRequestId(cryptoObject = globalThis.crypto) {
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoObject?.getRandomValues) cryptoObject.getRandomValues(bytes);
  else {
    // This UUID is an idempotency identifier, never an authentication secret.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((value, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${value.toString(16).padStart(2, '0')}`).join('');
}
