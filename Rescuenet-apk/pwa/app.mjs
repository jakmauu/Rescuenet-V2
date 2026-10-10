import {
  createRequestId, deliverSos, getBrowserLocation, isPendingLocationStale, locationAgeMs,
  locationRetryDelayMs, makeLocationPacket, makeSosPacket, normalizeNodeOrigin, normalizeProfile,
  NodeApiError, probeNode, shouldQueueLocation, transmitLocation,
} from './core.mjs';

const keys = {
  user: 'rn.pwa.user.v1', location: 'rn.pwa.location.v1', report: 'rn.pwa.sos.v1',
  tracking: 'rn.pwa.tracking.v2', consent: 'rn.pwa.location-consent.v1',
  pendingLocation: 'rn.pwa.location.pending.v1', queuedLocation: 'rn.pwa.location.queued.v1',
  sentLocation: 'rn.pwa.location.sent.v1', nodeUrl: 'rn.pwa.node-url.v1', interval: 'rn.pwa.location-interval.v1',
};
const $ = id => document.getElementById(id);
const ui = {
  pill: $('connection-pill'), connectionTitle: $('connection-title'), connectionHelp: $('connection-help'),
  apiState: $('api-state'), meshState: $('mesh-state'), check: $('check-button'), sos: $('sos-button'),
  sosLabel: $('sos-button-label'), permission: $('permission-status'), gps: $('gps-status'),
  coordinates: $('coordinates'), location: $('location-button'), tracking: $('tracking-button'),
  trackingStatus: $('tracking-status'), consent: $('location-consent'), report: $('report-status'),
  reportDetail: $('report-detail'), retry: $('retry-button'), name: $('name-input'), role: $('role-input'),
  team: $('team-input'), saveProfile: $('save-name-button'), profileSummary: $('profile-summary'),
  profileEditLabel: $('profile-edit-label'), resetProfile: $('reset-profile-button'), nodeUrl: $('node-url-input'),
  saveNodeUrl: $('save-node-url-button'), retryLocation: $('retry-location-button'), toast: $('toast'),
  interval: $('tracking-interval-input'),
};
let nodeReady = false;
let nodeDetails = null;
let connectionState = 'UNVERIFIED';
let checking = false;
let sending = false;
let locationBusy = false;
let locationSending = false;
let locationWatch = null;
let locationRefreshTimer = null;
let locationPollBusy = false;
let tracking = load(keys.tracking) === true;
let consent = load(keys.consent) === true;
let connectionError = '';
let locationFix = load(keys.location);
let report = load(keys.report);
let toastTimer;

function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function store(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function user() { return load(keys.user); }
function pendingRecord() {
  const value = load(keys.pendingLocation);
  if (!value) return null;
  // Migrate the previous PWA's raw-packet storage without changing the request ID.
  return value.packet ? value : { packet: value, attempts: 0, nextAttemptAt: 0 };
}
function baseUrl() {
  const saved = load(keys.nodeUrl);
  const candidate = typeof saved === 'string' && saved ? saved : 'http://192.168.4.1';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('URL tidak valid');
    return location.origin === parsed.origin ? '' : parsed.origin;
  } catch { return 'http://192.168.4.1'; }
}
function message(text) {
  ui.toast.textContent = text; ui.toast.classList.add('visible'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 5200);
}
function meshDescription(status) {
  if (!status) return 'Belum diketahui oleh aplikasi';
  if (status.mesh_started !== true) return 'Mesh belum mulai';
  if (status.mesh_synchronized !== true) return 'Node tersambung; mesh belum sinkron';
  if (status.gateway_found !== true) return 'Mesh sinkron; Gateway belum ditemukan';
  const routes = Number.isInteger(status.route_count) ? ` · ${status.route_count} rute` : '';
  const pending = Number.isInteger(status.pending_locations) ? ` · ${status.pending_locations} lokasi antre` : '';
  return `Gateway ditemukan${routes}${pending}`;
}
function renderConnection() {
  const ready = nodeReady && connectionState === 'FIELD_CONNECTED';
  const labels = { UNVERIFIED: 'Belum diverifikasi', CHECKING: 'Memeriksa…', FIELD_CONNECTED: 'Field Node API siap', FIELD_UNREACHABLE: 'Tidak dapat dijangkau', API_INCOMPATIBLE: 'API tidak kompatibel', BROWSER_BLOCKED: 'Dibatasi browser', RECOVERING: 'Mencoba pulih…' };
  ui.pill.className = `status-pill ${checking ? 'status-checking' : ready ? 'status-online' : 'status-offline'}`;
  ui.pill.textContent = checking ? 'Memeriksa…' : ready ? `Node ${nodeDetails?.node_id ?? '?'}` : labels[connectionState] || 'Belum terhubung';
  ui.connectionTitle.textContent = checking ? 'Memeriksa Field Node…' : ready ? `Field Node ${nodeDetails.node_id} terverifikasi` : labels[connectionState] || 'Field Node belum diverifikasi';
  ui.connectionHelp.textContent = ready
    ? 'API mobile valid dan radio siap menerima antrean. ACK API hanya memastikan Field Node menerima pesan.'
    : connectionError || 'Pilih Wi-Fi Field Node di Pengaturan iPhone, kembali ke aplikasi, lalu periksa koneksi.';
  ui.apiState.textContent = checking ? 'Sedang diperiksa' : ready ? `Siap · Node ${nodeDetails.node_id}` : labels[connectionState];
  ui.meshState.textContent = checking ? 'Sedang memeriksa status mesh…' : meshDescription(nodeDetails);
  ui.check.disabled = checking;
  ui.check.textContent = checking ? 'Memeriksa…' : 'Periksa koneksi';
  ui.sos.disabled = !ready || checking || sending || !user();
  ui.sosLabel.textContent = sending ? 'MENGIRIM…' : 'KIRIM SOS';
}
function renderProfile() {
  const profile = user();
  if (profile) {
    ui.name.value = profile.name || '';
    ui.role.value = profile.role || 'survivor';
    ui.team.value = profile.team || '';
    ui.profileSummary.textContent = `${profile.name} · ${profile.role === 'rescuer' ? 'Tim Penyelamat' : 'Penyintas'}${profile.team ? ` · ${profile.team}` : ''}`;
    ui.profileEditLabel.textContent = 'Edit profil';
    ui.resetProfile.classList.remove('hidden');
    document.querySelector('.identity-card').open = false;
  } else {
    ui.profileSummary.textContent = 'Daftarkan identitas sebelum mengirim SOS atau berbagi lokasi.';
    ui.profileEditLabel.textContent = 'Daftarkan identitas';
    ui.resetProfile.classList.add('hidden');
    document.querySelector('.identity-card').open = true;
  }
  ui.sos.disabled = !nodeReady || checking || sending || !profile;
}
function renderLocation() {
  const permission = load('rn.pwa.location-permission.v1') || 'prompt';
  const labels = { granted: 'Izin lokasi: diizinkan', denied: 'Izin lokasi: ditolak', prompt: 'Izin lokasi: belum diminta', unknown: 'Izin lokasi: periksa melalui tombol lokasi' };
  ui.permission.textContent = labels[permission] || labels.unknown;
  const age = locationAgeMs(locationFix);
  if (locationBusy) ui.gps.textContent = 'GPS sedang mencari posisi…';
  else if (!locationFix) ui.gps.textContent = 'GPS belum mendapatkan fix';
  else ui.gps.textContent = age <= 120_000
    ? `${locationFix.accuracy > 250 ? 'Akurasi lemah; fix tidak dibagikan' : 'Fix GPS'} · ${Math.floor(age / 1000)} dtk · akurasi ${locationFix.accuracy == null ? 'tidak diketahui' : `±${Math.round(locationFix.accuracy)} m`}`
    : 'Fix GPS sudah lama; koordinat tidak dikirim.';
  ui.coordinates.textContent = locationFix && age <= 120_000
    ? `${Number(locationFix.lat).toFixed(6)}, ${Number(locationFix.lon).toFixed(6)}` : 'Koordinat terbaru belum tersedia';
  ui.location.disabled = locationBusy;
  ui.location.textContent = locationBusy ? 'Mencari GPS…' : 'Perbarui lokasi sekali';
  ui.consent.checked = consent;
  ui.interval.value = String([30, 60, 120].includes(load(keys.interval)) ? load(keys.interval) : 30);
  ui.tracking.disabled = !user() || !consent && !tracking;
  ui.tracking.textContent = tracking ? 'Hentikan berbagi lokasi' : 'Mulai bagikan lokasi';
  const pending = pendingRecord();
  const lastSent = load(keys.sentLocation);
  ui.retryLocation.classList.toggle('hidden', !pending || !tracking);
  ui.trackingStatus.textContent = !tracking
    ? 'Berbagi lokasi berhenti. Tidak ada pembaruan baru yang dikirim.'
    : document.visibilityState !== 'visible'
      ? 'Tracking dijeda saat aplikasi tidak aktif. iOS tidak menjamin PWA berjalan di latar belakang.'
      : locationSending ? 'Mengirim fix terbaru ke Field Node…'
        : pending ? `Menunggu koneksi/ACK Field Node · percobaan ${pending.attempts || 0}/5.`
          : lastSent?.at ? `Field Node menerima antrean lokasi pukul ${new Date(lastSent.at).toLocaleTimeString('id-ID')}. Ini belum konfirmasi server.`
            : 'Berbagi aktif selama aplikasi terbuka; menunggu GPS dan antrean Field Node.';
}
function renderReport() {
  if (!report) {
    ui.report.textContent = 'Belum ada SOS aktif';
    ui.reportDetail.textContent = 'Field Node / Gateway / server belum mengonfirmasi SOS.';
    ui.retry.classList.add('hidden'); return;
  }
  if (report.status === 'FIELD_ACCEPTED') {
    ui.report.textContent = 'SOS diterima Field Node';
    ui.reportDetail.textContent = `Node ${report.nodeId ?? '?'} mengakui antrean pukul ${new Date(report.deliveredAt).toLocaleTimeString('id-ID')}. Belum ada konfirmasi Gateway/server.`;
    ui.retry.classList.add('hidden');
  } else if (report.status === 'SENDING') {
    ui.report.textContent = 'Mengirim SOS…'; ui.reportDetail.textContent = 'Menunggu ACK Field Node untuk ID laporan yang sama.'; ui.retry.classList.add('hidden');
  } else {
    ui.report.textContent = 'SOS belum terkonfirmasi';
    ui.reportDetail.textContent = report.error || 'Belum ada ACK Field Node; gunakan coba lagi saat jaringan siap.';
    ui.retry.classList.remove('hidden');
  }
}
async function checkConnection() {
  if (checking || document.visibilityState !== 'visible') return false;
  checking = true; connectionState = 'CHECKING'; connectionError = ''; renderConnection();
  try {
    nodeDetails = await probeNode(fetch, undefined, baseUrl());
    nodeReady = true; connectionState = 'FIELD_CONNECTED'; connectionError = '';
    renderConnection(); void flushPendingLocation(); return true;
  } catch (error) {
    nodeReady = false; nodeDetails = null;
    connectionState = error instanceof NodeApiError && error.code === 'INCOMPATIBLE' ? 'API_INCOMPATIBLE'
      : error instanceof NodeApiError && error.code === 'BROWSER_BLOCKED' ? 'BROWSER_BLOCKED' : 'FIELD_UNREACHABLE';
    connectionError = error?.message || 'Field Node tidak dapat diverifikasi. Periksa Wi-Fi dan coba lagi.';
    renderConnection(); return false;
  } finally { checking = false; renderConnection(); }
}
async function refreshPermissionState() {
  try {
    if (!navigator.permissions?.query) throw new Error('unsupported');
    const status = await navigator.permissions.query({ name: 'geolocation' });
    store('rn.pwa.location-permission.v1', status.state); renderLocation();
    status.onchange = () => { store('rn.pwa.location-permission.v1', status.state); renderLocation(); };
  } catch { if (!load('rn.pwa.location-permission.v1')) store('rn.pwa.location-permission.v1', 'unknown'); renderLocation(); }
}
async function requestLocation() {
  if (locationBusy) return;
  if (!window.isSecureContext) { message('GPS iPhone memerlukan konteks aman HTTPS. Koneksi portal HTTP lokal tidak dapat memberi GPS browser dengan andal.'); return; }
  locationBusy = true; renderLocation();
  try {
    locationFix = await getBrowserLocation(); store(keys.location, locationFix);
    store('rn.pwa.location-permission.v1', 'granted'); await refreshPermissionState();
    if (tracking) queueFreshLocation(locationFix);
    message('Fix GPS diperbarui di perangkat.');
  } catch (error) {
    if (error.code === 'GPS_DENIED') store('rn.pwa.location-permission.v1', 'denied');
    message(error.message || 'Lokasi gagal diperbarui.');
  } finally { locationBusy = false; renderLocation(); }
}
function queueFreshLocation(fix) {
  if (!tracking || !consent || !user() || document.visibilityState !== 'visible') return;
  const intervalMs = (Number(load(keys.interval)) || 30) * 1000;
  if (!shouldQueueLocation(load(keys.queuedLocation), fix, intervalMs)) { renderLocation(); return; }
  try {
    const packet = makeLocationPacket(user(), fix, createRequestId());
    store(keys.pendingLocation, { packet, attempts: 0, nextAttemptAt: 0 });
    store(keys.queuedLocation, fix);
    void flushPendingLocation();
  } catch (error) { message(error.message || 'Fix GPS belum layak dikirim.'); }
}
function acceptTrackingFix(fix) {
  if (!tracking || !consent || document.visibilityState !== 'visible') return;
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return;
  locationFix = fix;
  try { store(keys.location, fix); store('rn.pwa.location-permission.v1', 'granted'); }
  catch { message('Lokasi didapat, tetapi penyimpanan perangkat gagal.'); }
  renderLocation(); queueFreshLocation(fix);
}
function onTrackingFix(position) {
  acceptTrackingFix({ lat: position.coords.latitude, lon: position.coords.longitude,
    accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    timestamp: position.timestamp || Date.now() });
}
async function flushPendingLocation() {
  const pending = pendingRecord();
  if (!tracking || !consent || !nodeReady || !pending || locationSending || sending || document.visibilityState !== 'visible') return;
  if (isPendingLocationStale(pending.packet)) {
    store(keys.pendingLocation, null); renderLocation(); message('Fix tertunda sudah lebih dari 2 menit dan dibuang demi mencegah pengiriman lokasi lama.'); return;
  }
  if ((pending.attempts || 0) >= 5 || Date.now() < (pending.nextAttemptAt || 0)) return;
  locationSending = true; renderLocation();
  try {
    const ack = await transmitLocation(pending.packet, fetch, undefined, baseUrl());
    if (pendingRecord()?.packet?.request_id === pending.packet.request_id) {
      store(keys.pendingLocation, null);
      store(keys.sentLocation, { at: Date.now(), nodeId: ack.node_id ?? null, requestId: pending.packet.request_id, state: ack.state || 'queued' });
    }
  } catch (error) {
    const attempts = (pending.attempts || 0) + 1;
    const nextAttemptAt = Date.now() + locationRetryDelayMs(attempts);
    if (pendingRecord()?.packet?.request_id === pending.packet.request_id) store(keys.pendingLocation, { ...pending, attempts, nextAttemptAt, lastError: error.message });
    if (['NETWORK', 'TIMEOUT', 'BROWSER_BLOCKED', 'INCOMPATIBLE'].includes(error.code)) {
      nodeReady = false; nodeDetails = null;
      connectionState = error.code === 'BROWSER_BLOCKED' ? 'BROWSER_BLOCKED' : 'FIELD_UNREACHABLE';
      connectionError = `${error.message} Fix terbaru tetap lokal; otomatisasi tidak menjamin server menerima.`;
      renderConnection();
    }
  } finally { locationSending = false; renderLocation(); void flushPendingLocation(); }
}
function stopLocationWatch() {
  if (locationWatch !== null) { try { navigator.geolocation?.clearWatch(locationWatch); } catch { /* browser may already have released it */ } }
  if (locationRefreshTimer !== null) clearInterval(locationRefreshTimer);
  locationWatch = null; locationRefreshTimer = null; locationPollBusy = false; locationBusy = false;
}
function scheduleLocationRefresh() {
  if (locationRefreshTimer !== null) clearInterval(locationRefreshTimer);
  if (!tracking || !consent || document.visibilityState !== 'visible') { locationRefreshTimer = null; return; }
  const sampleSeconds = [30, 60, 120].includes(load(keys.interval)) ? load(keys.interval) : 30;
  locationRefreshTimer = setInterval(async () => {
    if (!tracking || document.visibilityState !== 'visible' || locationPollBusy || locationAgeMs(locationFix) < sampleSeconds * 1000 - 2_000) return;
    locationPollBusy = true;
    try { acceptTrackingFix(await getBrowserLocation()); }
    catch (error) { if (error.code === 'GPS_DENIED') store('rn.pwa.location-permission.v1', 'denied'); renderLocation(); }
    finally { locationPollBusy = false; }
  }, sampleSeconds * 1000);
}
function startLocationWatch() {
  if (!tracking || !consent || !user() || document.visibilityState !== 'visible' || locationWatch !== null) return;
  if (!window.isSecureContext || !navigator.geolocation?.watchPosition) {
    message('Live GPS memerlukan PWA HTTPS dan dukungan Geolocation Safari.'); return;
  }
  locationBusy = true; renderLocation();
  try {
    locationWatch = navigator.geolocation.watchPosition(onTrackingFix, error => {
      locationBusy = false; renderLocation();
      if (error.code === 1) { store('rn.pwa.location-permission.v1', 'denied'); message('Izin GPS ditolak. Ubah izin lokasi Safari untuk RescueNet.'); }
      else message(error.code === 3 ? 'GPS melewati batas waktu; tracking tetap menunggu fix berikutnya.' : 'Lokasi belum tersedia. Pastikan Layanan Lokasi aktif.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
  } catch (error) {
    locationBusy = false; locationWatch = null; renderLocation();
    message(error.message || 'Browser tidak dapat memulai watcher lokasi.'); return;
  }
  // watchPosition handles movement; stationary sampling follows the selected interval.
  scheduleLocationRefresh();
  locationBusy = false; renderLocation();
}
function toggleTracking() {
  if (tracking) {
    tracking = false; store(keys.tracking, false); stopLocationWatch();
    store(keys.pendingLocation, null); store(keys.queuedLocation, null); renderLocation();
    message('Berbagi berhenti. Update yang sedang dikirim mungkin masih diterima; antrean Field Node/server yang sudah terbentuk tidak dapat ditarik dari aplikasi.'); return;
  }
  if (!user()) { document.querySelector('.identity-card').open = true; message('Daftarkan identitas terlebih dahulu.'); return; }
  if (!consent) { ui.consent.focus(); message('Centang persetujuan berbagi lokasi sebelum memulai.'); return; }
  if (!window.isSecureContext) { message('Browser menolak live GPS pada HTTP. Buka origin HTTPS; ini belum menyelesaikan akses API HTTP lokal.'); return; }
  tracking = true; store(keys.tracking, true); renderLocation(); startLocationWatch(); void checkConnection();
}
function saveProfile() {
  if (sending || locationSending) { message('Tunggu pengiriman yang sedang berlangsung selesai sebelum mengubah profil.'); return; }
  try {
    const previous = user();
    const profile = normalizeProfile({ user_id: previous?.user_id || createRequestId(), name: ui.name.value, role: ui.role.value, team: ui.team.value }, previous);
    const changedName = previous && previous.name !== profile.name;
    store(keys.user, profile);
    if (changedName) store(keys.pendingLocation, null);
    renderProfile(); renderConnection(); message(previous ? 'Profil diperbarui; ID pengguna tetap sama.' : 'Profil tersimpan di perangkat ini.');
  } catch (error) { message(error.message || 'Profil tidak dapat disimpan pada perangkat.'); }
}
function resetProfile() {
  if (sending || locationSending) { message('Tunggu pengiriman yang sedang berlangsung selesai sebelum reset identitas.'); return; }
  const pendingSos = ['FAILED', 'SENDING'].includes(report?.status);
  const warning = pendingSos ? ' SOS lokal yang belum terkonfirmasi dan tombol retry juga akan dihapus dari perangkat.' : '';
  if (!window.confirm(`Hapus identitas dan lokasi lokal, lalu hentikan sharing?${warning} Data yang sudah diterima Field Node/server tidak ikut terhapus.`)) return;
  tracking = false; consent = false; stopLocationWatch();
  for (const key of [keys.user, keys.tracking, keys.consent, keys.pendingLocation, keys.queuedLocation, keys.location, keys.report]) store(key, null);
  locationFix = null; report = null;
  ui.name.value = ''; ui.team.value = ''; ui.role.value = 'survivor'; renderProfile(); renderLocation(); renderReport();
  message('Identitas lokal dihapus. Data yang telah diterima Field Node/server tetap ada.');
}
function saveNodeAddress() {
  let origin;
  try { origin = normalizeNodeOrigin(ui.nodeUrl.value.replace(/\/+$/, '')); }
  catch (error) { message(error.message); return; }
  store(keys.nodeUrl, origin); ui.nodeUrl.value = origin;
  nodeReady = false; nodeDetails = null; connectionState = 'UNVERIFIED'; renderConnection();
  message('Alamat tersimpan. Tekan Periksa koneksi untuk memverifikasi API.');
}
async function sendCurrentSos() {
  if (sending || !nodeReady || !user()) return;
  const confirmation = report?.status === 'FIELD_ACCEPTED'
    ? 'SOS sebelumnya telah diterima Field Node. Kirim laporan SOS baru sekarang?'
    : report?.status === 'FAILED'
      ? 'Coba kirim ulang SOS yang belum terkonfirmasi memakai ID laporan yang sama?'
      : 'Kirim SOS sekarang ke Field Node? Lokasi dapat tidak disertakan bila GPS belum tersedia.';
  if (!window.confirm(confirmation)) return;
  sending = true; renderConnection();
  try {
    const packet = report?.status === 'FAILED' ? report.packet : makeSosPacket(user(), locationFix, createRequestId());
    report = { status: 'SENDING', packet, nodeId: null, error: null }; store(keys.report, report); renderReport();
    const { status, ack } = await deliverSos(packet, fetch, undefined, baseUrl());
    nodeDetails = status; nodeReady = true; connectionState = 'FIELD_CONNECTED';
    report = { status: 'FIELD_ACCEPTED', packet, nodeId: ack.node_id ?? status.node_id, deliveredAt: Date.now() };
    store(keys.report, report); renderReport(); message('Field Node mengakui antrean SOS. Gateway/server belum dikonfirmasi.');
  } catch (error) {
    if (['NETWORK', 'TIMEOUT', 'BROWSER_BLOCKED', 'INCOMPATIBLE'].includes(error.code)) {
      nodeReady = false; nodeDetails = null; connectionState = error.code === 'BROWSER_BLOCKED' ? 'BROWSER_BLOCKED' : 'FIELD_UNREACHABLE'; connectionError = error.message;
    }
    report = { ...report, status: 'FAILED', error: error.message || 'SOS belum terkonfirmasi; coba lagi dengan ID yang sama.' };
    try { store(keys.report, report); } catch { /* Do not show a success if local persistence failed. */ }
    renderReport();
  } finally { sending = false; renderConnection(); renderLocation(); }
}

ui.check.addEventListener('click', () => { void checkConnection(); });
ui.sos.addEventListener('click', () => { void sendCurrentSos(); });
ui.retry.addEventListener('click', async () => {
  if (report?.status !== 'FAILED' || sending) return;
  if (await checkConnection()) void sendCurrentSos();
  else message('Field Node belum siap. Periksa diagnosa koneksi lalu coba lagi.');
});
ui.retryLocation.addEventListener('click', () => {
  const pending = pendingRecord(); if (!pending) return;
  store(keys.pendingLocation, { ...pending, attempts: 0, nextAttemptAt: 0 });
  void flushPendingLocation();
});
ui.location.addEventListener('click', () => { void requestLocation(); });
ui.tracking.addEventListener('click', toggleTracking);
ui.consent.addEventListener('change', () => {
  consent = ui.consent.checked;
  store(keys.consent, consent);
  if (!consent && tracking) toggleTracking();
  else renderLocation();
});
ui.saveProfile.addEventListener('click', saveProfile);
ui.resetProfile.addEventListener('click', resetProfile);
ui.saveNodeUrl.addEventListener('click', saveNodeAddress);
ui.interval.addEventListener('change', () => {
  const seconds = Number(ui.interval.value);
  if (![30, 60, 120].includes(seconds)) { ui.interval.value = '30'; return; }
  store(keys.interval, seconds); scheduleLocationRefresh(); message(`Interval saat diam disetel ${seconds} detik. Pergerakan ≥25 m tetap dapat memicu update lebih cepat setelah jeda minimum.`);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { void checkConnection(); startLocationWatch(); void flushPendingLocation(); }
  else { stopLocationWatch(); renderLocation(); }
});
window.addEventListener('pageshow', () => { void checkConnection(); startLocationWatch(); });
window.addEventListener('focus', () => { void checkConnection(); startLocationWatch(); });
let connectionRefreshTimer = null;
function startConnectionRefresh() {
  if (connectionRefreshTimer !== null) clearInterval(connectionRefreshTimer);
  connectionRefreshTimer = setInterval(() => { if (document.visibilityState === 'visible') void checkConnection(); }, 30_000);
}
window.addEventListener('pagehide', () => { stopLocationWatch(); clearTimeout(toastTimer); });
window.addEventListener('pageshow', startConnectionRefresh);

if (ui.nodeUrl) ui.nodeUrl.value = load(keys.nodeUrl) || 'http://192.168.4.1';
if (report?.status === 'SENDING') {
  report = { ...report, status: 'FAILED', error: 'Aplikasi ditutup sebelum ACK. Status belum pasti; coba lagi memakai ID laporan yang sama.' };
  try { store(keys.report, report); } catch { /* fail closed */ }
}
renderProfile(); renderLocation(); renderReport(); renderConnection();
startConnectionRefresh(); void refreshPermissionState(); void checkConnection();
if (tracking && consent) startLocationWatch();
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' })
    .then(registration => registration.update()).catch(() => {});
}
