import { useState } from 'react';
import { Alert, AppState, Linking, ScrollView, Switch, Text, View } from 'react-native';
import { Button, Card, Detail, palette, styles } from '../components/ui';
import { readSetting, recentSos, pendingSosCount, lastLocationDelivery, retryNow } from '../storage/Database';
import { refreshGps } from '../services/LocationService';
import { startTracking, stopTracking } from '../services/TrackingService';
import { networkSnapshot, checkNode } from '../services/NetworkMonitor';
import { sendSos } from '../services/SosService';
import { outbox } from '../services/runtime';
import { clearError, getRuntimeError, reportError } from '../services/events';
import { isFreshLocation } from '../utils/location';
import { useAppState } from '../hooks/useAppState';

function date(value: number | null): string { return value === null ? 'Belum ada' : new Date(value).toLocaleString(); }
export function HomeScreen() {
  useAppState();
  const [busy, setBusy] = useState<string | null>(null);
  const [background, setBackground] = useState(false);
  const [sosFailure, setSosFailure] = useState(false);
  const user = readSetting('user');
  const location = readSetting('location');
  const mode = readSetting('tracking') ?? 'off';
  const network = networkSnapshot();
  const history = recentSos();
  const latest = history[0];
  const ready = isFreshLocation(location);
  const error = getRuntimeError() ?? readSetting('trackingError');
  async function run(name: string, action: () => Promise<unknown>) {
    setBusy(name);
    clearError();
    try { await action(); } catch (failure) { reportError(failure); } finally { setBusy(null); }
  }
  function start() {
    if (!background) { void run('tracking', () => startTracking(false)); return; }
    Alert.alert('Tracking saat layar terkunci', 'Lokasi akan dikumpulkan dan dikirim meski Anda membuka aplikasi lain. Android menampilkan notifikasi aktif. Pilih izin lokasi sepanjang waktu jika diminta. Sistem dapat membatasi background; tekan STOP untuk mengakhiri.', [
      { text: 'Batal', style: 'cancel' }, { text: 'Izinkan & mulai', onPress: () => { void run('tracking', () => startTracking(true)); } },
    ]);
  }
  function sos() {
    try { setSosFailure(false); sendSos(); }
    catch (failure) { setSosFailure(true); reportError(failure); }
  }
  return <ScrollView style={styles.page} contentContainerStyle={styles.content}>
    <View><Text style={styles.title}>RescueNet</Text><Text style={styles.subtitle}>Emergency Communication</Text></View>
    <Card title="USER"><Text style={styles.heading}>{user?.name}</Text><Text selectable style={styles.muted}>{user?.user_id}</Text></Card>
    <Card title="GPS HP">
      <Text style={[styles.heading, { color: ready ? palette.green : palette.amber }]}>{ready ? 'GPS READY' : 'GPS NO FIX'}</Text>
      {!ready && <Text style={styles.muted}>Belum ada posisi baru yang valid. Data lebih dari 2 menit tidak digunakan pada SOS.</Text>}
      <Detail label={ready ? 'Latitude / Longitude' : 'Posisi terakhir (bukan fix saat ini)'} value={location ? `${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}` : 'Belum tersedia'} />
      <Detail label="Akurasi" value={location?.accuracy != null ? `± ${location.accuracy.toFixed(1)} m` : 'Tidak tersedia'} />
      <Detail label="Waktu fix terakhir" value={date(location?.timestamp ?? null)} />
      <Button title={busy === 'gps' ? 'Mencari GPS… SOS tetap tersedia' : 'Perbarui GPS / izinkan lokasi'} secondary disabled={busy !== null} onPress={() => { void run('gps', refreshGps); }} />
      <Text style={styles.muted}>GPS tidak membutuhkan internet. Fix awal dapat lebih lambat; coba di ruang terbuka dan pilih lokasi presisi.</Text>
    </Card>
    <Card title="RESCUENET NETWORK">
      <Text style={styles.heading}>{({ CHECKING: 'Memeriksa node…', CONNECTED: 'Connected · API siap', UNAVAILABLE: 'Node tidak terjangkau', INCOMPATIBLE: 'API mobile belum kompatibel' })[network.state]}</Text>
      <Detail label="Field Node terverifikasi lewat API" value={network.nodeId !== null ? `Node ${network.nodeId}` : 'Belum terverifikasi'} />
      <Text style={styles.muted}>http://192.168.4.1 · SSID tidak dibaca aplikasi. Pilih Wi-Fi RescueNet-Node di Pengaturan dan tetap tersambung meski bertuliskan “No Internet”.</Text>
      {network.state === 'INCOMPATIBLE' && <Text style={styles.error}>Firmware saat ini masih portal web. Endpoint mobile baru akan ditambahkan di Fase 2. Pesan belum dapat diteruskan oleh aplikasi ini.</Text>}
      <Button title="Periksa node" secondary disabled={busy !== null} onPress={() => { void run('network', checkNode); }} />
    </Card>
    <Card title="TRACKING">
      <Text style={styles.heading}>{mode === 'off' ? 'Stopped' : mode === 'background' ? 'Active · Background diminta' : AppState.currentState === 'active' ? 'Active · Foreground' : 'Paused · Foreground'}</Text>
      <Text style={styles.muted}>Pengiriman sekitar 30 detik atau perpindahan 25 m (minimal 15 detik). Update background mengikuti kesempatan dari sistem operasi.</Text>
      <Detail label="Lokasi terakhir diterima Field Node" value={date(lastLocationDelivery())} />
      <View style={styles.row}><Text style={[styles.value, { flex: 1 }]}>Aktif saat layar terkunci</Text><Switch accessibilityLabel="Gunakan tracking background" value={mode === 'off' ? background : mode === 'background'} disabled={mode !== 'off' || busy !== null} onValueChange={setBackground} /></View>
      <Button title={busy === 'tracking' ? 'Memproses…' : mode === 'off' ? 'START TRACKING' : 'STOP TRACKING'} disabled={busy !== null} onPress={mode === 'off' ? start : () => { void run('tracking', stopTracking); }} />
      <Text style={styles.muted}>STOP menghentikan tracking, bukan membatalkan SOS yang sudah diantrekan. Tanpa mode background, buka aplikasi agar pengiriman berjalan.</Text>
    </Card>
    <Card title="DARURAT">
      <Text style={styles.muted}>{ready ? 'SOS menggunakan fix GPS terbaru yang valid.' : 'SOS tetap bisa dikirim TANPA GPS.'} Tidak perlu menyalakan tracking.</Text>
      <Button title="SEND SOS" danger onPress={sos} />
      <Text accessibilityLiveRegion="polite" style={[styles.heading, { color: sosFailure ? palette.red : palette.ink }]}>{sosFailure ? 'FAILED · SOS belum tersimpan' : latest?.status ?? 'READY'}</Text>
      {sosFailure ? <Text style={styles.error}>Penyimpanan gagal. Jangan menganggap SOS sudah terkirim. Periksa ruang penyimpanan dan coba lagi.</Text> : <Text style={styles.muted}>{latest?.status === 'DELIVERED' ? 'Diterima Field Node saja. Belum ada konfirmasi dari Raspberry Pi atau petugas.' : latest?.status === 'SENDING' ? 'Mencoba mengirim ke Field Node…' : latest ? 'SOS QUEUED · Waiting for RescueNet network. Pesan tersimpan di HP.' : 'Tekan untuk menyimpan SOS dan langsung mencoba pengiriman.'}</Text>}
      <Detail label="SOS belum diterima node" value={String(pendingSosCount())} />
      <Button title="Coba kirim ulang antrean" secondary disabled={busy !== null} onPress={() => { void run('retry', async () => { retryNow(); await outbox.flush(); }); }} />
    </Card>
    {error && <Card title="PERLU DIPERIKSA"><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button title="Buka pengaturan aplikasi" secondary onPress={() => { void Linking.openSettings().catch(reportError); }} /></Card>}
    {history.length > 0 && <Card title="20 SOS TERAKHIR · SEMUA ANTREAN TETAP DISIMPAN">{history.map(item => <View key={item.id} style={{ gap: 5 }}>
      <View style={styles.separator} /><Text style={styles.value}>{item.status} · {item.payload.has_gps ? 'Dengan GPS' : 'Tanpa GPS'}</Text>
      <Text style={styles.muted}>{date(item.payload.timestamp * 1000)} · {item.attempts} percobaan</Text>
      <Text selectable style={styles.muted}>ID: {item.id}</Text>
      {item.lastError && <Text style={styles.error}>{item.lastError}</Text>}
      {item.status === 'QUEUED' && <Text style={styles.muted}>Percobaan berikut: {date(item.nextAttemptAt || Date.now())} atau saat jaringan kembali (ketika aplikasi dapat berjalan).</Text>}
    </View>)}</Card>}
    <Text style={styles.muted}>Prototipe capstone, bukan layanan keselamatan tersertifikasi. Internet tidak diperlukan untuk operasi lokal. Hapus data/uninstall menghilangkan antrean. Gunakan jalur bantuan lain jika tersedia.</Text>
  </ScrollView>;
}
