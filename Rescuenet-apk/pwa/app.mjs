import {
  createRequestId, getBrowserLocation, locationAgeMs, makeLocationPacket, makeSosPacket,
  nodeApiReadiness, normalizeNodeOrigin, normalizeProfile, NodeApiError, probeNode,
  transmitLocation, transmitSos,
} from './core.mjs';
import { LocationScheduler } from './location-scheduler.mjs';

const KEY = {
  user: 'rn.pwa.user.v1', location: 'rn.pwa.location.v1', sos: 'rn.pwa.sos-events.v2',
  legacySos: 'rn.pwa.sos.v1', tracking: 'rn.pwa.tracking.v2', consent: 'rn.pwa.location-consent.v1',
  pendingLocation: 'rn.pwa.location.pending.v1', latestLocation: 'rn.pwa.location.latest.v1',
  acceptedLocation: 'rn.pwa.location.sent.v1', nodeUrl: 'rn.pwa.node-url.v1', interval: 'rn.pwa.location-interval.v1',
  onboarded: 'rn.pwa.onboarded.v1',
};
const $ = id => document.getElementById(id);
const byId = Object.fromEntries([
  'connection-pill','onboarding-screen','onboarding-step','onboarding-title','onboarding-copy','onboarding-form','wifi-guide','verify-guide','permission-guide','onboarding-consent','onboarding-location-consent','onboarding-next','onboarding-back','onboarding-skip','check-button','home-check-button','connection-title','connection-help','api-state','mesh-state','home-connection-title','home-connection-help','home-api-state','home-mesh-state','status-api','status-mesh','sos-button','sos-button-label','permission-button','permission-status','gps-status','home-gps-status','coordinates','home-coordinates','map-coordinate-title','map-coordinate-detail','map-accuracy','map-time','map-age','maps-link','location-button','tracking-button','tracking-status','tracking-badge','location-consent','report-status','report-detail','home-report-status','home-report-detail','retry-button','retry-location-button','new-sos-button','sos-history','name-input','role-input','team-input','profile-name-input','profile-role-input','profile-team-input','save-name-button','profile-summary','profile-edit-label','reset-profile-button','node-url-input','save-node-url-button','tracking-interval-input','toast','bottom-nav','privacy-delete-button','map-update-button','home-map-button','home-status-button','home-wifi-button','location-delivery-status','location-delivery-detail','onboarding-back','onboarding-skip'
].map(id => [id, $(id)]));
const screens = Object.fromEntries(['splash','onboarding','home','map','status','profile'].map(id => [id, $(`${id}-screen`)]));
const safeStorage = {
  read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
  write(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};
const state = {
  screen: 'splash', onboardingStep: 0, checking: false, nodeReady: false, nodeDetails: null,
  connectionState: 'UNVERIFIED', connectionError: '', checkController: null, checkSequence: 0,
  connectionRetryTimer: null, connectionAttempts: 0, splashTimer: null,
  sendingSosId: null, tracking: safeStorage.read(KEY.tracking) === true,
  consent: safeStorage.read(KEY.consent) === true, fix: safeStorage.read(KEY.location),
  events: restoreSosEvents(), watchId: null, refreshTimer: null, pollBusy: false, toastTimer: null,
};

function restoreSosEvents() {
  const stored = safeStorage.read(KEY.sos);
  if (Array.isArray(stored)) return stored.slice(-10);
  const legacy = safeStorage.read(KEY.legacySos);
  if (legacy?.packet) return [{ ...legacy, id: legacy.packet.request_id }];
  return [];
}
function persistSosEvents() {
  // Browser storage is a small best-effort journal, not equivalent to the Field Node NVS journal.
  const ok = safeStorage.write(KEY.sos, state.events.slice(-10));
  if (!ok) toast('Penyimpanan SOS lokal gagal. Jangan tutup halaman; status pengiriman tidak dapat dipulihkan.');
  return ok;
}
function activeSos() { return state.events.at(-1) || null; }
function profile() { return safeStorage.read(KEY.user); }
function pendingRecord() {
  const value=safeStorage.read(KEY.pendingLocation);
  if(!value)return null;
  if(value.packet)return value;
  // Migrate the previous version's raw packet without changing its idempotency key.
  if(typeof value.request_id==='string'){
    const migrated={packet:value,fixTimestamp:Number(value.timestamp)*1000,attempts:0,nextAttemptAt:0};
    safeStorage.write(KEY.pendingLocation,migrated);
    return migrated;
  }
  return null;
}
function pending() { return pendingRecord(); }
function nodeUrl() {
  const raw = safeStorage.read(KEY.nodeUrl) || 'http://192.168.4.1';
  try { const parsed = new URL(raw); return parsed.origin === location.origin ? '' : parsed.origin; }
  catch { return 'http://192.168.4.1'; }
}
function toast(text) {
  byId.toast.textContent = text; byId.toast.classList.add('visible'); clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => byId.toast.classList.remove('visible'), 5200);
}
function meshText(info) {
  if (!info) return 'Belum diketahui';
  if (info.mesh_started !== true) return 'Mesh belum mulai';
  if (info.mesh_synchronized !== true) return 'Mesh belum sinkron';
  if (info.gateway_found !== true) return 'Gateway belum ditemukan';
  const routes = Number.isInteger(info.route_count) ? ` · ${info.route_count} rute` : '';
  const queued = Number.isInteger(info.pending_locations) ? ` · ${info.pending_locations} lokasi antre` : '';
  return `Gateway ditemukan${routes}${queued}`;
}
function statusLabel() {
  return ({ UNVERIFIED: 'Belum diverifikasi', CHECKING: 'Memeriksa…', FIELD_CONNECTED: 'Field Node siap',
    FIELD_API_NOT_READY: 'API ada · node belum siap', FIELD_UNREACHABLE: 'Tidak dapat dijangkau',
    API_INCOMPATIBLE: 'API tidak kompatibel', BROWSER_BLOCKED: 'Mungkin dibatasi browser', RECOVERING: 'Mencoba pulih…' })[state.connectionState] || 'Belum terhubung';
}
function connectionRetryNeeded() {
  return state.tracking || state.events.some(event=>['SENDING','UNKNOWN','FAILED'].includes(event.status));
}
function scheduleConnectionRetry() {
  if(state.connectionRetryTimer!==null||!connectionRetryNeeded()||document.visibilityState!=='visible')return;
  const delay=Math.min(120_000,15_000*(2**Math.min(state.connectionAttempts,3)));
  state.connectionAttempts++;
  state.connectionRetryTimer=setTimeout(()=>{state.connectionRetryTimer=null;if(connectionRetryNeeded())void checkConnection();},delay);
}
function clearConnectionRetry() {
  if(state.connectionRetryTimer!==null)clearTimeout(state.connectionRetryTimer);
  state.connectionRetryTimer=null;state.connectionAttempts=0;
}
function renderConnection() {
  const ready = state.nodeReady;
  byId['connection-pill'].className = `status-pill ${state.checking ? 'status-checking' : ready ? 'status-online' : 'status-offline'}`;
  byId['connection-pill'].textContent = state.checking ? 'Memeriksa…' : ready ? `Node ${state.nodeDetails?.node_id ?? '?'}` : statusLabel();
  const title = state.checking ? 'Memeriksa Field Node…' : ready ? `Field Node ${state.nodeDetails.node_id} terverifikasi` : statusLabel();
  const help = ready ? 'API menerima permintaan. Mesh/Gateway tetap ditampilkan terpisah; ACK PWA hanya membuktikan penerimaan Field Node.'
    : state.connectionError || 'Hubungkan Wi-Fi Field Node, kembali ke aplikasi, lalu periksa koneksi.';
  for (const [id, value] of [['connection-title',title],['home-connection-title',title],['connection-help',help],['home-connection-help',help],
    ['api-state',ready?'Siap':statusLabel()],['home-api-state',ready?'Siap':statusLabel()],['mesh-state',meshText(state.nodeDetails)],['home-mesh-state',meshText(state.nodeDetails)],['status-api',ready?'Siap':statusLabel()],['status-mesh',meshText(state.nodeDetails)]]) {
    if (byId[id]) byId[id].textContent = value;
  }
  for (const id of ['check-button','home-check-button']) if (byId[id]) { byId[id].disabled = state.checking; byId[id].textContent = state.checking ? 'Memeriksa…' : 'Periksa koneksi'; }
  byId['sos-button'].disabled = state.sendingSosId !== null || !profile();
  byId['sos-button-label'].textContent = state.sendingSosId ? 'MENGIRIM…' : ready ? 'KIRIM SOS' : 'SIMPAN SOS';
}
function showScreen(name) {
  state.screen = name;
  for (const [id, element] of Object.entries(screens)) element.hidden = id !== name;
  byId['bottom-nav'].hidden = name === 'onboarding' || name === 'splash';
  document.querySelectorAll('.bottom-nav button').forEach(button => {
    if (button.dataset.screen === name) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  if (name === 'map') renderMap();
  window.scrollTo?.({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function beginOnboarding(step = 0) { state.onboardingStep = step; showScreen('onboarding'); renderOnboarding(); }
function finishOnboarding() { safeStorage.write(KEY.onboarded, true); showScreen('home'); renderAll(); }
function scheduleSplashRoute() {
  if (state.screen !== 'splash' || state.splashTimer !== null) return;
  state.splashTimer = setTimeout(() => {
    state.splashTimer = null;
    if (state.screen !== 'splash') return;
    const firstRun = !profile() || safeStorage.read(KEY.onboarded) !== true;
    if (firstRun) beginOnboarding(profile() ? 2 : 0);
    else showScreen('home');
  }, 180);
}
function renderOnboarding() {
  const step = state.onboardingStep;
  const titles = ['Selamat datang di RescueNet','Daftarkan identitas','Hubungkan ke Field Node','Verifikasi koneksi','Aktifkan lokasi bila dibutuhkan'];
  const copies = ['Komunikasi darurat, berbagi lokasi, dan SOS melalui jaringan RescueNet.','Nama dan peran membantu petugas memahami laporan. Identitas dibuat sekali di perangkat ini.','Hubungkan iPhone ke Wi-Fi Field Node agar PWA dapat mengirim laporan.','Pemeriksaan ini memverifikasi API lokal. Status mesh dan Gateway tidak disamakan dengan koneksi iPhone.','Lokasi hanya digunakan setelah izin dan persetujuan Anda. Sharing dapat dihentikan kapan saja.'];
  byId['onboarding-step'].textContent = `LANGKAH ${step + 1} DARI 5`;
  byId['onboarding-title'].textContent = titles[step]; byId['onboarding-copy'].textContent = copies[step];
  for (const [id, show] of [['onboarding-form',step===1],['wifi-guide',step===2],['verify-guide',step===3],['permission-guide',step===4]]) byId[id].hidden = !show;
  byId['onboarding-back'].hidden = step === 0;
  byId['onboarding-skip'].hidden = ![2,3,4].includes(step);
  byId['onboarding-next'].textContent = ['Mulai','Simpan & lanjut','Saya sudah terhubung','Lanjutkan','Selesai'][step];
  byId['onboarding-next'].disabled = step === 3 && state.checking;
  if (step === 1 && !profile()) { byId['name-input'].value = ''; }
  if (step === 3) renderConnection();
}
async function advanceOnboarding() {
  const step = state.onboardingStep;
  if (step === 1) {
    try {
      const current = profile();
      const next = normalizeProfile({ name: byId['name-input'].value, role: byId['role-input'].value, team: byId['team-input'].value, user_id: current?.user_id || createRequestId() }, current);
      if (!safeStorage.write(KEY.user,next)) throw new NodeApiError('Perangkat tidak mengizinkan penyimpanan profil. Periksa ruang penyimpanan Safari.','STORAGE');
      if (byId['onboarding-consent'].checked) { state.consent = safeStorage.write(KEY.consent,true); if(!state.consent)toast('Persetujuan tidak dapat disimpan. Lokasi tidak akan dibagikan otomatis.'); }
    } catch (error) { toast(error.message); return; }
  }
  if (step === 3 && state.checking) return;
  if (step === 4) {
    state.consent = byId['onboarding-location-consent'].checked || state.consent;
    if(!safeStorage.write(KEY.consent,state.consent)){state.consent=false;byId['onboarding-location-consent'].checked=false;toast('Persetujuan lokasi tidak dapat disimpan; sharing tetap nonaktif.');}
    if (byId['onboarding-location-consent'].checked) await requestLocation();
    finishOnboarding(); return;
  }
  if (step === 3 && !state.nodeReady) { toast('Koneksi belum terverifikasi. Anda dapat melanjutkan, tetapi fitur kirim perlu node siap.'); }
  state.onboardingStep = Math.min(4,step+1); renderOnboarding();
}

async function checkConnection() {
  if (state.checking || document.visibilityState !== 'visible') return false;
  state.checking = true; state.connectionState='CHECKING'; state.connectionError='';
  const sequence = ++state.checkSequence; state.checkController?.abort(); state.checkController = new AbortController();
  renderConnection(); renderOnboarding();
  try {
    const info = await probeNode(fetch, 3500, nodeUrl(), state.checkController.signal);
    if (sequence !== state.checkSequence) return false;
    state.nodeDetails=info;
    state.connectionState=nodeApiReadiness(info);
    state.nodeReady=state.connectionState === 'FIELD_CONNECTED';
    if (!state.nodeReady) state.connectionError='API dapat dijangkau, tetapi radio/antrian atau mesh belum siap. Periksa status pada Field Node.';
    if(state.nodeReady)clearConnectionRetry();else scheduleConnectionRetry();
    renderConnection(); if (state.nodeReady) scheduler.resume();
    return state.nodeReady;
  } catch (error) {
    if (sequence !== state.checkSequence) return false;
    state.nodeDetails=null; state.nodeReady=false;
    state.connectionState=error.code==='INCOMPATIBLE'?'API_INCOMPATIBLE':error.code==='BROWSER_BLOCKED'?'BROWSER_BLOCKED':'FIELD_UNREACHABLE';
    state.connectionError=error.message || 'Field Node belum dapat diverifikasi.';
    scheduleConnectionRetry();
    renderConnection(); return false;
  } finally {
    if (sequence === state.checkSequence) { state.checking=false; state.checkController=null; renderConnection(); renderOnboarding(); }
  }
}

const scheduler = new LocationScheduler({
  readPending: pendingRecord, writePending: value => safeStorage.write(KEY.pendingLocation,value),
  readLatest: () => safeStorage.read(KEY.latestLocation), writeLatest: value => safeStorage.write(KEY.latestLocation,value),
  readLastAccepted: () => safeStorage.read(KEY.acceptedLocation), writeLastAccepted: value => safeStorage.write(KEY.acceptedLocation,value),
  makePacket: fix => makeLocationPacket(profile(),fix,createRequestId()),
  send: packet => transmitLocation(packet,fetch,3500,nodeUrl()),
  enabled: () => state.tracking && state.consent && state.nodeReady && document.visibilityState==='visible',
  intervalMs: (Number(safeStorage.read(KEY.interval)) || 120) * 1000,
  minimumSpacingMs: 60_000,
  onState(kind,detail) {
    if (kind==='accepted') toast('Field Node menerima antrean lokasi. Server belum terkonfirmasi.');
    if (kind==='stale') toast('Fix tertunda sudah terlalu lama; lokasi lama tidak dikirim.');
    if (kind==='exhausted') toast('Percobaan lokasi mencapai batas. Periksa koneksi lalu pilih coba lagi.');
    if (['retry_wait','exhausted'].includes(kind) && detail instanceof Error) {
      state.connectionError=detail.message;
      if (['NETWORK','TIMEOUT','BROWSER_BLOCKED'].includes(detail.code)) { state.nodeReady=false; state.connectionState=detail.code==='BROWSER_BLOCKED'?'BROWSER_BLOCKED':'FIELD_UNREACHABLE'; }
    }
    if(kind==='retry_wait'||kind==='exhausted')scheduleConnectionRetry();
    renderLocation(); renderConnection();
  },
});

function renderProfile() {
  const current=profile();
  if (current) {
    byId['profile-name-input'].value=current.name||''; byId['profile-role-input'].value=current.role||'survivor'; byId['profile-team-input'].value=current.team||'';
    byId['profile-summary'].textContent=`${current.name} · ${current.role==='rescuer'?'Tim Penyelamat':'Penyintas'}${current.team?` · ${current.team}`:''} · ID ${current.user_id}`;
    byId['profile-edit-label'].textContent='Edit identitas';
    byId['reset-profile-button'].hidden=false;
    $('welcome-user').textContent=`Halo, ${current.name}. SOS dan lokasi hanya dikirim lewat Field Node yang terverifikasi.`;
  } else {
    byId['profile-name-input'].value=''; byId['profile-role-input'].value='survivor'; byId['profile-team-input'].value='';
    byId['profile-summary'].textContent='Identitas belum didaftarkan di perangkat ini.';
    byId['profile-edit-label'].textContent='Daftarkan identitas';
    byId['reset-profile-button'].hidden=true;
  }
}
function ageText(ms) { return !Number.isFinite(ms)?'—':ms<60_000?`${Math.floor(ms/1000)} dtk`:ms<3_600_000?`${Math.floor(ms/60_000)} mnt`:`${Math.floor(ms/3_600_000)} jam`; }
function renderLocation() {
  const fix=state.fix; const age=locationAgeMs(fix); const recent=fix && age<=120_000;
  const coords=recent?`${Number(fix.lat).toFixed(6)}, ${Number(fix.lon).toFixed(6)}`:'Koordinat terbaru belum tersedia';
  const gps= !fix?'GPS belum diperiksa':recent?`Fix GPS · ±${fix.accuracy==null?'?':Math.round(fix.accuracy)} m · ${ageText(age)} lalu`:'Fix GPS sudah lama';
  byId['gps-status'].textContent=gps; byId['home-gps-status'].textContent=gps; byId['coordinates'].textContent=coords; byId['home-coordinates'].textContent=coords;
  const permission=safeStorage.read('rn.pwa.location-permission.v1')||'prompt';
  byId['permission-status'].textContent=({granted:'Izin lokasi: diizinkan',denied:'Izin lokasi: ditolak',prompt:'Izin lokasi: belum diminta',unknown:'Izin lokasi: status tidak tersedia'})[permission]||'Izin lokasi: status tidak diketahui';
  byId['location-consent'].checked=state.consent;
  byId['tracking-button'].textContent=state.tracking?'Hentikan berbagi lokasi':'Mulai bagikan lokasi';
  byId['tracking-badge'].textContent=state.tracking?'Berbagi aktif':'Berhenti'; byId['tracking-badge'].className=`status-pill ${state.tracking?'status-online':'status-offline'}`;
  const p=pending(); const accepted=safeStorage.read(KEY.acceptedLocation);
  byId['tracking-status'].textContent=!state.tracking?'Berbagi berhenti.':document.visibilityState!=='visible'?'Berbagi dijeda: PWA tidak aktif; iOS dapat menangguhkan GPS.':p?`Lokasi menunggu ACK · percobaan ${p.attempts}/${5}.`:accepted?`Field Node menerima lokasi ${new Date(accepted.acceptedAt).toLocaleTimeString('id-ID')}. Ini bukan ACK server.`:'Menunggu fix GPS yang memenuhi batas akurasi dan interval.';
  byId['retry-location-button'].classList.toggle('hidden',!p || !state.tracking);
  renderLocationDelivery(p,accepted);
  if (state.screen==='map') renderMap();
}
function renderLocationDelivery(p,accepted) {
  const label=p?'Menunggu Field Node':accepted?'Diterima Field Node':'Belum dikirim';
  byId['location-delivery-status'].textContent=label;
  byId['location-delivery-detail'].textContent=p?`Retry ${p.attempts}/${5}; gateway dan server belum dikonfirmasi.`:accepted?`ACK dari Node ${accepted.nodeId??'?'} pukul ${new Date(accepted.acceptedAt).toLocaleTimeString('id-ID')}. Server belum dikonfirmasi.`:'GPS lokal tidak berarti paket sudah dikirim.';
}
function renderMap() {
  const fix=state.fix; const age=locationAgeMs(fix); const valid=fix&&age<=120_000&&Number.isFinite(fix.lat)&&Number.isFinite(fix.lon);
  byId['map-coordinate-title'].textContent=valid?`${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}`:'Belum ada fix GPS terbaru';
  byId['map-coordinate-detail'].textContent=valid?'Posisi dari GPS perangkat; tidak dibagikan ke tile map.':'Aktifkan lokasi dan tunggu fix GPS.';
  byId['map-accuracy'].textContent=valid&&fix.accuracy!=null?`±${Math.round(fix.accuracy)} m`:'Belum tersedia';
  byId['map-time'].textContent=valid?new Date(fix.timestamp).toLocaleString('id-ID'):'Belum tersedia';
  byId['map-age'].textContent=valid?ageText(age):'Kedaluwarsa / tidak tersedia';
  byId['maps-link'].classList.toggle('hidden',!valid);
  if(valid) byId['maps-link'].href=`https://maps.apple.com/?ll=${encodeURIComponent(`${fix.lat},${fix.lon}`)}`;
}
function renderSos() {
  const current=activeSos();
  if (!current) { byId['report-status'].textContent='Belum ada SOS aktif'; byId['report-detail'].textContent='Belum ada laporan SOS dari perangkat ini.'; byId['home-report-status'].textContent='Belum ada SOS aktif'; byId['home-report-detail'].textContent='Status pengiriman akan muncul di sini.'; byId['retry-button'].classList.add('hidden'); byId['sos-history'].replaceChildren(); return; }
  const labels={SENDING:'Sedang mengirim ke Field Node',FIELD_ACCEPTED:'Diterima Field Node',UNKNOWN:'Status belum pasti',FAILED:'Belum terkonfirmasi'};
  const detail=current.status==='FIELD_ACCEPTED'?`Field Node ${current.nodeId??'?'} mengakui antrean ${new Date(current.deliveredAt).toLocaleTimeString('id-ID')}. Gateway/server belum mengonfirmasi.`:current.error||`ID laporan ${current.id} disimpan lokal. Retry akan memakai ID yang sama.`;
  byId['report-status'].textContent=labels[current.status]||'Status belum diketahui'; byId['report-detail'].textContent=detail;
  byId['home-report-status'].textContent=labels[current.status]||'Status belum diketahui'; byId['home-report-detail'].textContent=detail;
  byId['retry-button'].classList.toggle('hidden',!['FAILED','UNKNOWN'].includes(current.status));
  byId['sos-history'].replaceChildren();
  for(const event of [...state.events].reverse()) {
    const row=document.createElement('div'); row.className='sos-history-row';
    const copy=document.createElement('span'); copy.textContent=`${new Date(event.createdAt).toLocaleTimeString('id-ID')} · ${labels[event.status]||event.status} · ${event.id.slice(0,8)}`;
    row.append(copy);
    if(['FAILED','UNKNOWN'].includes(event.status)) { const retry=document.createElement('button'); retry.type='button'; retry.className='text-button'; retry.textContent='Retry'; retry.addEventListener('click',()=>void retrySos(event.id)); row.append(retry); }
    byId['sos-history'].append(row);
  }
}
function renderAll() { renderProfile(); renderConnection(); renderLocation(); renderSos(); }

async function requestLocation() {
  if (!window.isSecureContext) { toast('GPS browser memerlukan HTTPS/konteks aman. HTTP AP lokal tidak otomatis menyediakan GPS.'); return null; }
  try {
    const fix=await getBrowserLocation(); state.fix=fix;
    safeStorage.write(KEY.location,fix); safeStorage.write('rn.pwa.location-permission.v1','granted');
    if(state.tracking) scheduler.offer(fix); renderLocation(); toast('Fix GPS didapat di perangkat.'); return fix;
  } catch(error) { safeStorage.write('rn.pwa.location-permission.v1',error.code==='GPS_DENIED'?'denied':'unknown'); renderLocation(); toast(error.message); return null; }
}
function acceptFix(position) {
  const fix={lat:position.coords.latitude,lon:position.coords.longitude,accuracy:Number.isFinite(position.coords.accuracy)?position.coords.accuracy:null,timestamp:position.timestamp||Date.now()};
  if(!Number.isFinite(fix.lat)||!Number.isFinite(fix.lon)||Math.abs(fix.lat)>90||Math.abs(fix.lon)>180) return;
  state.fix=fix; safeStorage.write(KEY.location,fix); safeStorage.write('rn.pwa.location-permission.v1','granted');
  if(state.tracking&&state.consent) scheduler.offer(fix); renderLocation();
}
function startTracking() {
  if(state.watchId!==null||!state.tracking||!state.consent||!profile()||document.visibilityState!=='visible') return;
  if(!window.isSecureContext||!navigator.geolocation?.watchPosition){toast('Live GPS memerlukan HTTPS dan dukungan Geolocation.');return;}
  state.watchId=navigator.geolocation.watchPosition(acceptFix,error=>{
    if(error.code===1){safeStorage.write('rn.pwa.location-permission.v1','denied');toast('Izin lokasi ditolak. Ubah izin lokasi Safari untuk RescueNet.');}
    else if(error.code===3) toast('GPS melewati batas waktu; menunggu fix berikutnya.');
    renderLocation();
  },{enableHighAccuracy:true,maximumAge:0,timeout:25_000});
  refreshStationaryTimer(); scheduler.resume(); renderLocation();
}
function stopTracking({discard=false}={}) {
  if(state.watchId!==null){try{navigator.geolocation?.clearWatch(state.watchId);}catch{} state.watchId=null;}
  if(state.refreshTimer!==null){clearInterval(state.refreshTimer);state.refreshTimer=null;}
  state.pollBusy=false; scheduler.stop({discard});
}
function refreshStationaryTimer() {
  if(state.refreshTimer!==null)clearInterval(state.refreshTimer);
  if(!state.tracking||!state.consent||document.visibilityState!=='visible')return;
  const seconds=[30,60,120].includes(Number(safeStorage.read(KEY.interval)))?Number(safeStorage.read(KEY.interval)):120;
  state.refreshTimer=setInterval(async()=>{
    if(state.pollBusy||locationAgeMs(state.fix)<seconds*1000-2000)return;
    state.pollBusy=true;try{const fix=await getBrowserLocation();acceptFix({coords:{latitude:fix.lat,longitude:fix.lon,accuracy:fix.accuracy},timestamp:fix.timestamp});}
    catch(error){if(error.code==='GPS_DENIED')safeStorage.write('rn.pwa.location-permission.v1','denied');}
    finally{state.pollBusy=false;}
  },seconds*1000);
}
function toggleTracking() {
  if(state.tracking){state.tracking=false;safeStorage.write(KEY.tracking,false);stopTracking({discard:true});renderLocation();toast('Berbagi lokasi dihentikan. Antrean lokasi di perangkat dibersihkan; data yang sudah diterima node tidak dapat ditarik.');return;}
  if(!profile()){beginOnboarding(1);toast('Daftarkan identitas terlebih dahulu.');return;}
  if(!state.consent){byId['location-consent'].focus();toast('Centang persetujuan sebelum mengaktifkan berbagi.');return;}
  if(!window.isSecureContext){toast('Live GPS browser memerlukan PWA HTTPS; koneksi HTTPS ke API HTTP node tetap bergantung pada kebijakan iOS.');return;}
  state.tracking=true;safeStorage.write(KEY.tracking,true);startTracking();void checkConnection();
}
function saveProfile() {
  const old=profile();
  try {
    const next=normalizeProfile({user_id:old?.user_id||createRequestId(),name:byId['profile-name-input'].value,role:byId['profile-role-input'].value,team:byId['profile-team-input'].value},old);
    if(!safeStorage.write(KEY.user,next))throw new NodeApiError('Profil tidak dapat disimpan di perangkat.','STORAGE');
    renderProfile();renderConnection();toast('Profil tersimpan. ID pengguna tetap sama.');
  }catch(error){toast(error.message);}
}
function resetLocalData() {
  if(!confirm('Hapus identitas, persetujuan, SOS dan lokasi lokal, lalu hentikan sharing? Data yang sudah diterima node/server tidak ikut terhapus.'))return;
  state.tracking=false;state.consent=false;stopTracking({discard:true});
  for(const key of [...Object.values(KEY),KEY.legacySos,'rn.pwa.location-permission.v1','rn.pwa.location.queued.v1'])safeStorage.write(key,null);
  state.fix=null;state.events=[];renderAll();beginOnboarding(0);toast('Data lokal perangkat dihapus. Data di Field Node/server tetap ada.');
}
async function sendSos({retry=false,eventId=null}={}) {
  if(state.sendingSosId||!profile())return;
  let event=eventId?state.events.find(item=>item.id===eventId):activeSos();
  let locallyPersisted=true;
  if(retry){if(!event||!['FAILED','UNKNOWN'].includes(event.status))return;}
  else {
    const unresolved=state.events.find(item=>['SENDING','UNKNOWN','FAILED'].includes(item.status));
    if(unresolved&&!confirm(`SOS ${unresolved.id} belum terkonfirmasi. Buat SOS baru juga? SOS lama tetap tersimpan dan tidak akan dihapus.`))return;
    if(state.events.length>=10){const evict=state.events.findIndex(item=>item.status==='FIELD_ACCEPTED');if(evict>=0)state.events.splice(evict,1);else{toast('Riwayat SOS lokal penuh (maksimum 10) dan semuanya belum terkonfirmasi. Catat ID laporan sebelum membuat SOS baru.');return;}}
    const packet=makeSosPacket(profile(),state.fix,createRequestId());
    event={id:packet.request_id,packet,status:'UNKNOWN',createdAt:Date.now(),error:null};
    state.events.push(event); locallyPersisted=persistSosEvents();
  }
  if(!state.nodeReady){event.status='UNKNOWN';event.error=locallyPersisted?'SOS tersimpan pada perangkat ini, tetapi belum dikirim ke Field Node. Hubungkan Wi-Fi node dan pilih Retry.':'Penyimpanan lokal gagal dan Field Node offline; laporan ini hanya ada selama halaman tetap terbuka.';persistSosEvents();renderSos();showScreen('status');toast(event.error);return;}
  state.sendingSosId=event.id;event.status='SENDING';event.error=null;persistSosEvents();renderSos();renderConnection();
  try {
    const ack=await transmitSos(event.packet,fetch,3500,nodeUrl());
    event.status='FIELD_ACCEPTED';event.nodeId=ack.node_id??null;event.deliveredAt=Date.now();event.error=null;
    persistSosEvents();
    toast('Field Node mengakui antrean SOS. Gateway/server belum terkonfirmasi.');
  } catch(error) {
    event.status='UNKNOWN';event.error=`Belum ada ACK yang cocok. Bisa jadi request sudah diterima tetapi balasan hilang. Retry memakai ID yang sama. (${error.message})`;
    if(['NETWORK','TIMEOUT','BROWSER_BLOCKED'].includes(error.code)){state.nodeReady=false;state.connectionState=error.code==='BROWSER_BLOCKED'?'BROWSER_BLOCKED':'FIELD_UNREACHABLE';state.connectionError=error.message;}
    persistSosEvents();scheduleConnectionRetry();
  } finally { state.sendingSosId=null;renderSos();renderConnection(); }
}
function saveNodeAddress() {
  try{const origin=normalizeNodeOrigin(byId['node-url-input'].value);if(!safeStorage.write(KEY.nodeUrl,origin))throw new Error('Alamat node tidak dapat disimpan.');byId['node-url-input'].value=origin;state.nodeReady=false;state.nodeDetails=null;state.connectionState='UNVERIFIED';renderConnection();toast('Alamat tersimpan. Periksa koneksi untuk memverifikasi API.');}
  catch(error){toast(error.message);}
}

for(const id of ['check-button','home-check-button'])byId[id]?.addEventListener('click',()=>void checkConnection());
byId['sos-button'].addEventListener('click',()=>{if(!confirm('Kirim SOS sekarang? Jika GPS belum tersedia, SOS tetap dikirim tanpa koordinat.'))return;void sendSos();});
async function retrySos(eventId=null){if(!state.nodeReady&&!await checkConnection()){toast('Field Node belum siap. SOS tetap tersimpan lokal; coba lagi setelah terhubung.');return;}await sendSos({retry:true,eventId});}
byId['retry-button'].addEventListener('click',()=>void retrySos());
byId['new-sos-button'].addEventListener('click',()=>{showScreen('home');byId['sos-button'].focus();});
byId['retry-location-button'].addEventListener('click',()=>scheduler.retryNow());
byId['location-button'].addEventListener('click',()=>void requestLocation());
byId['map-update-button'].addEventListener('click',()=>void requestLocation());
byId['tracking-button'].addEventListener('click',toggleTracking);
byId['location-consent'].addEventListener('change',()=>{state.consent=byId['location-consent'].checked;if(!safeStorage.write(KEY.consent,state.consent)){state.consent=false;byId['location-consent'].checked=false;toast('Persetujuan tidak dapat disimpan di perangkat; lokasi tidak dibagikan.');}if(!state.consent&&state.tracking)toggleTracking();else if(state.consent&&state.tracking)startTracking();renderLocation();});
byId['tracking-interval-input'].value=String(safeStorage.read(KEY.interval)||120);
byId['tracking-interval-input'].addEventListener('change',()=>{const seconds=Number(byId['tracking-interval-input'].value);if(![30,60,120].includes(seconds)){byId['tracking-interval-input'].value='120';return;}safeStorage.write(KEY.interval,seconds);scheduler.intervalMs=seconds*1000;refreshStationaryTimer();toast(`Interval saat diam ${seconds} detik. Pengiriman tetap dibatasi jeda minimal 60 detik untuk menjaga kapasitas LoRa.`);});
byId['save-name-button'].addEventListener('click',saveProfile);byId['reset-profile-button'].addEventListener('click',resetLocalData);byId['privacy-delete-button'].addEventListener('click',resetLocalData);byId['save-node-url-button'].addEventListener('click',saveNodeAddress);
byId['home-map-button'].addEventListener('click',()=>showScreen('map'));byId['home-status-button'].addEventListener('click',()=>showScreen('status'));byId['home-wifi-button'].addEventListener('click',()=>beginOnboarding(2));
document.querySelectorAll('.bottom-nav button').forEach(button=>button.addEventListener('click',()=>showScreen(button.dataset.screen)));
byId['onboarding-next'].addEventListener('click',()=>void advanceOnboarding());
byId['onboarding-back'].addEventListener('click',()=>{state.onboardingStep=Math.max(0,state.onboardingStep-1);renderOnboarding();});
byId['onboarding-skip'].addEventListener('click',()=>{if(state.onboardingStep===2){state.onboardingStep=3;renderOnboarding();}else finishOnboarding();});
byId['permission-button'].addEventListener('click',()=>void requestLocation());
byId['onboarding-location-consent'].addEventListener('change',()=>{state.consent=byId['onboarding-location-consent'].checked;if(!safeStorage.write(KEY.consent,state.consent)){state.consent=false;byId['onboarding-location-consent'].checked=false;toast('Persetujuan tidak dapat disimpan; lokasi tidak akan dibagikan.');}});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){scheduleSplashRoute();void checkConnection();startTracking();scheduler.resume();}
  else{stopTracking();renderLocation();}
});
window.addEventListener('pagehide',()=>{stopTracking();clearTimeout(state.toastTimer);clearTimeout(state.splashTimer);state.splashTimer=null;clearConnectionRetry();state.checkController?.abort();});
window.addEventListener('pageshow',()=>{if(document.visibilityState==='visible'){scheduleSplashRoute();void checkConnection();startTracking();}});

byId['node-url-input'].value=safeStorage.read(KEY.nodeUrl)||'http://192.168.4.1';
byId['name-input'].value=profile()?.name||'';byId['role-input'].value=profile()?.role||'survivor';byId['team-input'].value=profile()?.team||'';
if(state.events.at(-1)?.status==='SENDING'){state.events.at(-1).status='UNKNOWN';state.events.at(-1).error='Aplikasi ditutup sebelum ACK diterima. Retry memakai ID yang sama.';persistSosEvents();}
renderAll();
showScreen('splash');
scheduleSplashRoute();
void checkConnection();
if(state.tracking&&state.consent)startTracking();
if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('./service-worker.js',{updateViaCache:'none'}).then(reg=>reg.update()).catch(()=>{});
