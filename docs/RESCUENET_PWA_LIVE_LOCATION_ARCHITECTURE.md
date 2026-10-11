# RescueNet PWA iPhone — Live Location & Integration Architecture

## Arsitektur source sekarang

```text
iPhone Safari / Home Screen PWA (HTTPS origin)
  ├─ Geolocation API: hanya secure context, saat foreground dan consent aktif
  └─ fetch ke HTTP privat http://192.168.4.1 (CORS/preflight dari firmware)
          ↓ batas kompatibilitas WebKit/iOS belum dibuktikan
Field Node HTTP API → antrean lokasi bounded/coalesced → LoRaMesher
          → Gateway → USB serial → serial bridge → MQTT → SQLite mobile_events
          → GET /api/map/positions → dashboard Leaflet marker mobile_user
```

PWA menyimpan satu `user_id` UUID lokal yang stabil, nama, peran, dan kelompok opsional. Payload saat ini mengirim hanya ID, nama, request ID, fix timestamp, koordinat, dan accuracy; peran/kelompok sengaja belum dipropagasikan karena parser firmware belum memiliki field tersebut. Field Node menghitung identitas wire pseudonimnya; dashboard tidak memerlukan ID mentah.

Fetch PWA menyertakan `targetAddressSpace: "local"` sebagai hint Local Network Access pada browser yang mendukungnya. Implementasi browser bisa mengabaikan properti tersebut; ini tidak memberi izin secara otomatis dan bukan cara melewati CORS/mixed-content.

## State dan arti ACK

| Lapisan | Status yang dapat dibuktikan | Yang belum dibuktikan oleh status itu |
|---|---|---|
| iPhone → Field Node | API status cocok; POST mengembalikan HTTP sukses, `accepted:true`, request ID sama | Mesh mengirim atau Gateway menerima |
| Field Node → mesh | Field Node dapat melaporkan sinkronisasi, gateway ditemukan, dan jumlah pending pada saat `/api/status` dipanggil | Paket tertentu tersimpan server |
| Gateway → server | Envelope mobile tervalidasi, MQTT commit, STORED ACK melalui serial | Petugas membaca/menangani laporan |
| Server → dashboard | Mobile event tersimpan; map snapshot memilih fix terbaru dan memberi freshness | iPhone sedang online saat ini |

Lokasi lama yang datang setelah lokasi baru tidak boleh menjadi marker utama. Snapshot memilih `COALESCE(fix_timestamp,event_timestamp)` paling baru dan menyertakan `received_at` terpisah. Fresh/stale/offline dihitung dari waktu fix, bukan waktu kedatangan paket.

## Scheduling dan backpressure PWA

- `watchPosition` satu kali per sesi foreground; dibersihkan pada hidden/pagehide.
- Sampling bantu paling cepat satu kali per 30 detik jika watcher tidak memberi fix. Event watcher dan sampling berbagi validasi serta throttling.
- Interval saat diam dapat dipilih 30/60/120 detik (default 30); pengiriman gerak ≥25 m boleh lebih cepat setelah ≥15 detik. Akurasi di atas 250 m ditolak untuk live location; SOS tetap dapat dikirim tanpa GPS.
- Hanya satu pending location di local storage. Fix terbaru mengganti fix yang belum dikirim (coalescing). Paket pending memakai `request_id` sama saat retry untuk idempotensi.
- Otomatis mencoba maksimal 5 kali dengan backoff 5, 10, 20, 40, hingga 80 detik (batas 120 detik); fix >120 detik dibuang. Retry manual disediakan. Antrean lokasi ini terpisah dari antrean SOS persisten Field Node.
- Persetujuan sharing dan toggle sesi terpisah. Stop/revoke menghentikan watcher, membuang pending lokal, dan mencegah callback GPS yang terlambat mengantre data baru. Data yang sudah ada di Field Node/server tidak dapat dihapus dari PWA.

## Evaluasi secure context dan opsi prototipe offline

Kebutuhan simultan: PWA perlu origin HTTPS tepercaya untuk geolocation iPhone, sementara ESP32 saat ini menyediakan API HTTP pada AP privat tanpa internet. GitHub Pages HTTPS + firmware CORS adalah rancangan yang dicoba, tetapi Safari/iOS dapat memblokir HTTPS→HTTP lokal sebagai mixed content atau meminta/menolak akses jaringan lokal. Header CORS dan OPTIONS yang benar hanya memenuhi kebijakan lintas origin; bukan bypass transport security. Service worker juga tidak dapat mengubah aturan ini.

Pilihan realistis:

1. **PWA HTTPS foreground untuk uji kompatibilitas** — pertahankan origin tepercaya, koneksikan iPhone manual ke SSID node, dan uji Safari/iOS aktual. Dapat berfungsi pada kombinasi browser/perizinan tertentu, tetapi source tidak mengklaim kompatibel universal. PWA harus sudah dimuat dan service worker/app shell sudah terpasang sebelum offline.
2. **HTTPS lokal tepercaya** — perlu hostname stabil, DNS lokal yang dapat diakses iPhone, sertifikat TLS yang iPhone percayai, dan perubahan server Field Node/proxy. ESP32 TLS, ukuran memori, provisioning CA, captive network, dan private-network permission harus diuji. IP + self-signed cert tidak cukup.
3. **Proxy HTTPS di Pi/router lokal** — layak hanya jika iPhone dapat mencapai proxy dan proxy dapat mencapai Field Node pada jaringan yang sama. AP node sekarang tidak menyediakan internet/backhaul ke Pi; topologi, rute, DNS, dan pengamanan proxy harus dirancang lebih dulu.
4. **Aplikasi iOS native/hybrid** — jalur paling realistis jika lokasi foreground/offline harus bekerja konsisten. Repo sudah memiliki aplikasi Expo terpisah, tetapi izin iOS, akses local network, background Core Location, EAS/iOS signing, dan alur pengiriman tetap perlu implementasi/tes; source PWA ini tidak mengubahnya. Background tracking tetap memerlukan kemampuan native dan persetujuan iOS yang sesuai.

**Keputusan saat ini:** selesaikan PWA foreground dan diagnosis jujur; jangan menonaktifkan keamanan browser, membuat lokasi palsu, atau menjanjikan tracking background. Keputusan hosting/network untuk perilaku offline yang benar-benar andal masih membutuhkan uji iPhone dan perubahan deployment/topologi yang disetujui.

## Privasi, freshness, dan batasan data

- Consent lokasi dapat dicabut. Nama/ID/role/team, fix terakhir, dan status SOS lokal disimpan di localStorage per origin, bukan bukti login; menghapus data website menghilangkan profil. Reset profil meminta konfirmasi dan menghapus status/retry SOS lokal yang belum selesai.
- Koordinat lokal terakhir tetap tersimpan untuk ditampilkan dan dapat digunakan sebagai lokasi SOS jika masih <2 menit. Stop sharing menghapus pending live fix, bukan data lokal fix terakhir; reset profil menghapus fix lokal.
- Dashboard hanya menunjukkan lokasi server yang valid. Freshness berarti usia GPS fix, bukan heartbeat iPhone atau node.
- Saat paket lama telat dari radio, fix timestamp lama tidak menimpa marker yang lebih baru. Laporan SOS tetap dicatat terpisah dari marker mobile.
- Belum ada autentikasi dashboard/retensi lokasi spesifik pada perubahan ini; kontrol akses jaringan/dashboard dan kebijakan retensi wajib diverifikasi sebelum sistem digunakan pada insiden nyata.
