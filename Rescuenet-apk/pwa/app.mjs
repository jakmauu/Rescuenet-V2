import { createRequestId, deliverSos, getBrowserLocation, makeLocationPacket, makeSosPacket, NodeApiError, probeNode, shouldQueueLocation, transmitLocation } from './core.mjs';

const keys = { user: 'rn.pwa.user.v1', location: 'rn.pwa.location.v1', report: 'rn.pwa.sos.v1', tracking: 'rn.pwa.tracking.v1', queuedLocation: 'rn.pwa.location.queued.v1', pendingLocation: 'rn.pwa.location.pending.v1', sentLocation: 'rn.pwa.location.sent.v1' };
const $ = id => document.getElementById(id);
const ui = {
  pill: $('connection-pill'), connectionTitle: $('connection-title'), connectionHelp: $('connection-help'),
  check: $('check-button'), sos: $('sos-button'), sosLabel: $('sos-button-label'), permission: $('permission-status'),
  gps: $('gps-status'), coordinates: $('coordinates'), location: $('location-button'), tracking: $('tracking-button'), trackingStatus: $('tracking-status'), report: $('report-status'),
  reportDetail: $('report-detail'), retry: $('retry-button'), name: $('name-input'), saveName: $('save-name-button'), toast: $('toast'),
};
let nodeReady = false;
let checking = false;
let sending = false;
let locationBusy = false;
let locationSending = false;
let locationWatch = null;
let locationPollTimer = null;
let locationPollBusy = false;
let tracking = load(keys.tracking) === true;
let connectionError = '';
let locationFix = load(keys.location);
let report = load(keys.report);
let toastTimer;

function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function store(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function user() { return load(keys.user); }
function message(text) {
  ui.toast.textContent = text; ui.toast.classList.add('visible'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 5200);
}
function setNode(ready, state = '') {
  nodeReady = ready;
  ui.pill.className = `status-pill ${checking ? 'status-checking' : ready ? 'status-online' : 'status-offline'}`;
  ui.pill.textContent = checking ? 'Memeriksa…' : ready ? `Terhubung · Node ${state}` : 'Belum terhubung';
  ui.connectionTitle.textContent = checking ? 'Memeriksa komunikasi Field Node…' : ready ? `Terhubung ke Field Node ${state}` : 'Field Node belum diverifikasi';
  ui.connectionHelp.textContent = ready
    ? `API Field Node merespons dan firmware siap menerima laporan.${user() ? '' : ' Isi nama pelapor di kartu bawah untuk mengaktifkan SOS.'}`
    : connectionError || 'Hubungkan iPhone ke Wi-Fi Field Node melalui Pengaturan Wi-Fi, lalu kembali ke RescueNet.';
  ui.check.disabled = checking;
  ui.check.textContent = checking ? 'Memeriksa…' : 'Periksa koneksi';
  ui.sos.disabled = !ready || checking || sending || !user();
  ui.sosLabel.textContent = sending ? 'MENGIRIM…' : 'KIRIM SOS';
}
function renderLocation() {
  const permission = load('rn.pwa.location-permission.v1') || 'prompt';
  const labels = { granted: 'Izin lokasi: diizinkan', denied: 'Izin lokasi: ditolak', prompt: 'Izin lokasi: belum diminta', unknown: 'Izin lokasi: periksa melalui tombol GPS' };
  ui.permission.textContent = labels[permission] || labels.unknown;
  if (locationBusy) ui.gps.textContent = 'GPS sedang mencari posisi…';
  else if (!locationFix) ui.gps.textContent = 'GPS belum mendapatkan fix';
  else {
    const age = Date.now() - locationFix.timestamp;
    ui.gps.textContent = age <= 120_000 ? `GPS aktif · akurasi ${locationFix.accuracy == null ? 'tidak tersedia' : `±${Math.round(locationFix.accuracy)} m`}` : 'GPS tersedia, tetapi fix sudah lama';
  }
  ui.coordinates.textContent = locationFix
    ? `Koordinat${Date.now() - locationFix.timestamp <= 120_000 ? ' siap dikirim' : ' (fix lama, tidak disertakan)'}\n${locationFix.lat.toFixed(6)}, ${locationFix.lon.toFixed(6)}`
    : 'Koordinat belum tersedia';
  ui.location.disabled = locationBusy;
  ui.location.textContent = locationBusy ? 'Mencari GPS…' : 'Izinkan / perbarui lokasi';
  ui.tracking.textContent = tracking ? 'Hentikan berbagi lokasi' : 'Mulai bagikan lokasi';
  const lastSent = load(keys.sentLocation);
  ui.trackingStatus.textContent = !tracking
    ? 'Berbagi lokasi berhenti. Aktifkan hanya jika Anda setuju membagikan lokasi ke jaringan RescueNet.'
    : document.visibilityState !== 'visible'
      ? 'Berbagi lokasi dijeda saat aplikasi tidak aktif. iPhone tidak menjamin tracking PWA di latar belakang.'
      : locationSending ? 'Mengirim lokasi terbaru ke Field Node…'
        : load(keys.pendingLocation) ? 'Lokasi terbaru tersimpan di perangkat; menunggu koneksi dan ACK Field Node.'
        : lastSent?.at ? `Berbagi aktif di aplikasi. Terakhir diterima Field Node ${new Date(lastSent.at).toLocaleTimeString('id-ID')}.`
          : 'Berbagi aktif selama aplikasi terbuka; menunggu fix GPS dan ACK Field Node.';
}
function renderReport() {
  if (!report) {
    ui.report.textContent = 'Belum ada SOS aktif'; ui.reportDetail.textContent = 'Penerimaan di Field Node belum berarti bantuan sudah tiba.';
    ui.retry.classList.add('hidden'); return;
  }
  if (report.status === 'DELIVERED') {
    ui.report.textContent = 'SOS terkirim';
    ui.reportDetail.textContent = `Dikonfirmasi Field Node ${report.nodeId ?? ''} · ${new Date(report.deliveredAt).toLocaleTimeString('id-ID')}. Ini belum menjadi konfirmasi dari Gateway atau tim penyelamat.`;
    ui.retry.classList.add('hidden');
  } else if (report.status === 'SENDING') {
    ui.report.textContent = 'Mengirim…'; ui.reportDetail.textContent = 'Menunggu ACK valid dari Field Node.'; ui.retry.classList.add('hidden');
  } else {
    ui.report.textContent = 'SOS belum terkonfirmasi'; ui.reportDetail.textContent = report.error || 'Field Node belum mengirim ACK yang valid. Pesan tersimpan di perangkat; coba lagi saat siap.';
    ui.retry.classList.remove('hidden');
  }
}
async function checkConnection() {
  if (checking) return false;
  checking = true; setNode(nodeReady);
  try {
    const status = await probeNode(); connectionError = ''; setNode(true, status.node_id); void flushPendingLocation(); return true;
  } catch (error) {
    setNode(false);
    connectionError = error instanceof NodeApiError
      ? `${error.message} Pastikan firmware Field Node terbaru sudah di-upload agar mengizinkan CORS dari PWA. Safari iPhone juga dapat membatasi akses HTTPS ke HTTP lokal.`
      : 'Field Node tidak dapat diverifikasi. Periksa Wi-Fi lalu coba lagi.';
    return false;
  } finally { checking = false; setNode(nodeReady, nodeReady ? ui.pill.textContent.replace('Terhubung · Node ', '') : ''); }
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
  if (!window.isSecureContext) { message('GPS memerlukan halaman aman HTTPS. Buka PWA dari tautan HTTPS dan pasang ke Home Screen.'); return; }
  locationBusy = true; renderLocation();
  try {
    locationFix = await getBrowserLocation(); store(keys.location, locationFix);
    store('rn.pwa.location-permission.v1', 'granted');
    await refreshPermissionState(); message('Lokasi GPS terbaru berhasil diperbarui.');
  } catch (error) {
    if (error.code === 'GPS_DENIED') store('rn.pwa.location-permission.v1', 'denied');
    else if (error.code === 'GPS_FAILED') store('rn.pwa.location-permission.v1', 'granted');
    message(error.message || 'Lokasi gagal diperbarui.');
  } finally { locationBusy = false; renderLocation(); }
}
function onTrackingFix(fix) {
  locationFix = fix;
  try { store(keys.location, fix); store('rn.pwa.location-permission.v1', 'granted'); }
  catch { message('GPS aktif, tetapi penyimpanan lokal gagal.'); }
  renderLocation();
  if (!tracking || !user() || !shouldQueueLocation(load(keys.queuedLocation), fix)) return;
  try {
    const packet = makeLocationPacket(user(), fix, createRequestId());
    store(keys.pendingLocation, packet); // Keep the exact ID/body until Field Node ACKs it.
    store(keys.queuedLocation, fix);
    void flushPendingLocation();
  } catch (error) { message(error.message || 'Lokasi belum siap dibagikan.'); }
}
async function flushPendingLocation() {
  const packet = load(keys.pendingLocation);
  if (!tracking || !nodeReady || !packet || locationSending || sending || document.visibilityState !== 'visible') return;
  // A delayed retry must never overwrite the server's latest position with an old fix.
  if (!Number.isFinite(packet.timestamp) || Date.now() - packet.timestamp * 1000 > 120_000) return;
  locationSending = true; renderLocation();
  try {
    const ack = await transmitLocation(packet);
    if (load(keys.pendingLocation)?.request_id === packet.request_id) {
      store(keys.pendingLocation, null);
      store(keys.sentLocation, { at: Date.now(), nodeId: ack.node_id ?? null, requestId: packet.request_id });
    }
  } catch (error) {
    if (error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'INCOMPATIBLE') {
      nodeReady = false;
      connectionError = `${error.message} Lokasi terbaru tetap tersimpan di perangkat dan akan dicoba lagi.`;
      setNode(false);
    } else message(error.message || 'Lokasi belum dikonfirmasi Field Node; akan dicoba lagi.');
  } finally { locationSending = false; renderLocation(); }
}
function stopLocationWatch() {
  if (locationWatch !== null) navigator.geolocation?.clearWatch(locationWatch);
  if (locationPollTimer !== null) clearInterval(locationPollTimer);
  locationPollTimer = null; locationPollBusy = false;
  locationWatch = null; locationBusy = false;
}
function startLocationWatch() {
  if (!tracking || document.visibilityState !== 'visible' || locationWatch !== null) return;
  if (!window.isSecureContext || !navigator.geolocation?.watchPosition) {
    message('Pelacakan GPS memerlukan PWA HTTPS dan dukungan lokasi browser.'); return;
  }
  locationBusy = true; renderLocation();
  locationWatch = navigator.geolocation.watchPosition(position => {
    locationBusy = false;
    onTrackingFix({ lat: position.coords.latitude, lon: position.coords.longitude,
      accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
      timestamp: position.timestamp || Date.now() });
  }, error => {
    locationBusy = false;
    if (error.code === 1) store('rn.pwa.location-permission.v1', 'denied');
    renderLocation();
    message(error.code === 1 ? 'Izin GPS ditolak. Izinkan lokasi di Pengaturan iPhone untuk RescueNet.' : 'GPS belum mendapat posisi. Pastikan Layanan Lokasi aktif dan coba di area terbuka.');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
  // watchPosition has no portable sampling interval; poll while foregrounded so
  // a stationary phone also refreshes the last known fix like Android tracking.
  locationPollTimer = setInterval(async () => {
    if (!tracking || document.visibilityState !== 'visible' || locationPollBusy) return;
    locationPollBusy = true;
    try { onTrackingFix(await getBrowserLocation()); }
    catch (error) {
      if (error.code === 'GPS_DENIED') store('rn.pwa.location-permission.v1', 'denied');
      renderLocation();
    } finally { locationPollBusy = false; }
  }, 30_000);
  renderLocation();
}
function toggleTracking() {
  if (tracking) {
    tracking = false; store(keys.tracking, false); stopLocationWatch();
    store(keys.pendingLocation, null); store(keys.queuedLocation, null); renderLocation();
    message('Berbagi lokasi dihentikan. Lokasi yang sudah diterima Field Node tidak dihapus.'); return;
  }
  if (!user()) { document.querySelector('.identity-card').open = true; message('Simpan nama pelapor sebelum berbagi lokasi.'); return; }
  if (!window.isSecureContext) { message('GPS dan PWA memerlukan halaman HTTPS.'); return; }
  tracking = true; store(keys.tracking, true); renderLocation(); startLocationWatch(); void checkConnection();
}
function saveName() {
  const name = ui.name.value.trim();
  if (name.length < 2) { message('Masukkan nama lengkap (minimal 2 karakter).'); return; }
  try {
    const previous = user();
    store(keys.user, { user_id: previous?.user_id || createRequestId(), name });
    ui.name.value = name; setNode(nodeReady); message('Nama pelapor tersimpan di perangkat ini.');
  } catch (error) { message(error.message || 'Nama gagal disimpan.'); }
}
async function sendCurrentSos() {
  if (sending) return;
  if (!nodeReady) { message('Periksa komunikasi Field Node terlebih dahulu.'); return; }
  if (!user()) { document.querySelector('.identity-card').open = true; message('Isi dan simpan nama pelapor terlebih dahulu.'); return; }
  if (report?.status === 'DELIVERED' && !window.confirm('SOS sebelumnya sudah diterima Field Node. Kirim SOS baru?')) return;
  sending = true; setNode(nodeReady, ui.pill.textContent.replace('Terhubung · Node ', ''));
  try {
    const packet = report?.status === 'FAILED' ? report.packet : makeSosPacket(user(), locationFix, createRequestId());
    // Persist the exact packet before networking; a retry reuses its request_id/body.
    report = { status: 'SENDING', packet, nodeId: null, error: null };
    store(keys.report, report); renderReport();
    // deliverSos verifies again immediately before POST; Wi-Fi/browser state is never trusted.
    const { status, ack } = await deliverSos(packet); nodeReady = true;
    report = { status: 'DELIVERED', packet, nodeId: ack.node_id ?? status.node_id, deliveredAt: Date.now(), error: null };
    store(keys.report, report); renderReport(); message('SOS diterima Field Node. Belum ada konfirmasi bahwa Gateway atau petugas sudah menerimanya.');
  } catch (error) {
    if (error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'INCOMPATIBLE') {
      nodeReady = false;
      connectionError = `${error.message} Sambungkan kembali Wi-Fi Field Node lalu periksa koneksi.`;
    }
    if (report?.status === 'SENDING') {
      report = { ...report, status: 'FAILED', error: error.message || 'SOS gagal dikonfirmasi. Coba kirim lagi.' };
      try { store(keys.report, report); } catch { message('SOS gagal dan penyimpanan lokal juga gagal. Jangan anggap terkirim.'); }
      renderReport();
    } else message(error.message || 'Field Node tidak dapat diverifikasi.');
  } finally { sending = false; setNode(nodeReady, nodeReady ? ui.pill.textContent.replace('Terhubung · Node ', '') : ''); void flushPendingLocation(); }
}

ui.check.addEventListener('click', () => { void checkConnection(); });
ui.sos.addEventListener('click', () => { void sendCurrentSos(); });
ui.retry.addEventListener('click', async () => {
  if (report?.status !== 'FAILED') return;
  if (!await checkConnection()) { message('Field Node belum siap. Periksa Wi-Fi dan coba lagi.'); return; }
  void sendCurrentSos();
});
ui.location.addEventListener('click', () => { void requestLocation(); });
ui.tracking.addEventListener('click', toggleTracking);
ui.saveName.addEventListener('click', saveName);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { void checkConnection(); startLocationWatch(); }
  else { stopLocationWatch(); renderLocation(); }
});
window.addEventListener('pageshow', () => { void checkConnection(); });
window.addEventListener('focus', () => { void checkConnection(); });
setInterval(() => { if (document.visibilityState === 'visible') void checkConnection(); }, 15_000);

const storedUser = user();
if (storedUser) ui.name.value = storedUser.name;
else document.querySelector('.identity-card').open = true;
// A page/app closed during transmission cannot know whether the ACK arrived.
// Keep the same request_id/body and require an explicit, idempotent retry.
if (report?.status === 'SENDING') {
  report = { ...report, status: 'FAILED', error: 'Aplikasi ditutup sebelum ACK diterima. Status belum pasti; coba kirim ulang dengan ID laporan yang sama.' };
  try { store(keys.report, report); } catch { /* Fail closed; the visible error is still truthful. */ }
}
renderLocation(); renderReport(); setNode(false); void refreshPermissionState(); void checkConnection(); if (tracking) startLocationWatch();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
