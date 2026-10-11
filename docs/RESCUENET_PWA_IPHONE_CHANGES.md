# RescueNet V2 — Perubahan PWA iPhone

## Ringkasan status

PWA yang diaudit berada di `Rescuenet-apk/pwa/` dan merupakan halaman HTML/CSS/ES module tanpa framework build. Direktori `Rescuenet-apk/src/` adalah aplikasi Expo terpisah; perubahan ini tidak mengubah aplikasi native/Android.

Implementasi sebelumnya sudah memakai endpoint dan wire format Field Node yang benar, tetapi onboarding hanya berupa input nama; tidak ada persetujuan eksplisit untuk live sharing; diagnosa browser menyarankan membuka portal HTTP seolah-olah GPS akan tersedia; pemantauan lokasi memakai watcher sekaligus polling tanpa batas retry yang tegas; dan ACK Field Node berisiko dipahami sebagai data sudah sampai server. Dashboard sudah memiliki marker pengguna mobile, namun pemilihan lokasi terakhir memakai waktu paket diterima sehingga fix lama yang datang terlambat dapat menggantikan fix baru.

## Perubahan yang disiapkan

- Menambahkan logo PNG RescueNet yang diberikan pengguna pada `Rescuenet-apk/pwa/assets/rescuenet-logo.png`; memasangnya pada header, ikon browser, Apple touch icon, manifest, dan app shell offline.
- Membuat profil satu kali di perangkat: nama, peran, kelompok opsional, ID stabil; edit profil mempertahankan ID. Reset lokal menghentikan sharing dan menghapus identitas/fix/status SOS tersimpan lokal setelah konfirmasi (dengan peringatan bila ada retry SOS belum terkonfirmasi); tidak menghapus data Field Node/server.
- Memisahkan penyimpanan profil dari persetujuan berbagi lokasi. Checkbox persetujuan eksplisit dapat dicabut; tombol mulai/stop mengatur sesi secara terpisah.
- Menampilkan status API Field Node dan mesh/Gateway sebagai dua hal berbeda. Status mesh hanya mencerminkan field yang dikembalikan `/api/status`; PWA tidak mengklaim server terkonfirmasi.
- Menambahkan panduan Wi-Fi iPhone dan input origin Field Node (default firmware saat ini `http://192.168.4.1`, SSID `RescueNet-Node<N>`). Pemeriksaan tetap menggunakan JSON/version/capability check dari firmware.
- Mempertahankan hint `targetAddressSpace: "local"` pada fetch ke node untuk browser yang mendukung Local Network Access. Hint ini bukan bypass; izin browser, CORS/preflight, dan kebijakan mixed content tetap berlaku.
- Menambahkan tracking foreground dengan satu `watchPosition`, refresh maksimum tiap 30 detik ketika watcher tidak memberi fix, akurasi maksimum 250 m, usia fix maksimum 2 menit, jarak minimum 25 m atau interval diam yang dapat dipilih (30/60/120 detik; default 30 detik).
- Mengirim hanya satu update lokasi terbaru tertunda (latest-value wins); retry memakai ID/payload sama, exponential backoff dan maksimal 5 percobaan otomatis. Fix tertunda yang lebih tua dari 2 menit dibuang. Ini bukan antrean SOS persisten dan tidak mengirim riwayat lokasi.
- Membuat status pengiriman lokasi/SOS jujur: `FIELD_ACCEPTED` berarti Field Node membalas ACK untuk ID yang sama; tidak berarti Gateway, server, database, atau petugas telah menerima.
- Mengubah service worker ke cache versi v5 untuk app shell saja. Request `/api/...` selalu network-only dan tidak pernah dijawab dari cache. Cache RescueNet PWA versi sebelumnya dibersihkan; cache aplikasi lain tidak disentuh.
- Mengubah snapshot peta supaya lokasi mobile terbaru dipilih berdasar waktu fix GPS, bukan urutan kedatangan paket. Popup peta memisahkan waktu fix, waktu server menerima, akurasi, user key pseudonim, Field Node, dan mesh hop.
- Menambah test source untuk normalisasi profil, ID tetap ketika edit, validasi lokasi, dan paket lokasi terlambat.

## Kontrak yang dipertahankan

- `GET /api/status`
- `POST /api/location`
- `POST /api/sos`
- `Content-Type: application/json`, `Idempotency-Key: request_id`
- Payload Field Node memakai `user_id`, `name`, `request_id`, `timestamp`/GPS fields sesuai parser `field_node/MobileModel.h`. Field `role` dan `team` hanya disimpan lokal dan sengaja tidak dikirim karena parser firmware tidak menerimanya.
- Mobile wire → Gateway serial → MQTT → `mobile_events` → `/api/map/positions` sudah tersedia di perubahan reliability lokal yang diaudit. User key di database berupa pseudonim wire; ID profil mentah tidak ditampilkan pada peta.

## Root cause/batas koneksi yang teridentifikasi

PWA yang dipublikasikan di HTTPS (`https://jakmauu.github.io/...`) meminta API HTTP dari IP privat Field Node. Firmware membatasi CORS ke origin PWA dan menangani preflight, tetapi CORS tidak membuat koneksi HTTPS→HTTP menjadi aman dan tidak menghapus kebijakan mixed-content/private-network Safari/iOS. Error `fetch` generik juga tidak dapat membedakan dengan pasti antara Wi-Fi salah, node mati, CORS, izin jaringan lokal, dan mixed content; UI kini menyebut kemungkinan tersebut, bukan mengaku tahu penyebab yang tak dapat diamati.

Membuka `http://192.168.4.1` secara langsung dapat membantu memeriksa portal/API, tetapi halaman HTTP pada IP privat bukan secure context yang dapat diandalkan untuk Geolocation API atau instalasi PWA iOS. Karena itu ia bukan solusi live GPS.

## Verifikasi

Perubahan source/test/documentasi dibuat lokal. Build, test suite, perangkat iPhone, Field Node, Gateway, Pi, deployment, database produksi, dan Git remote tidak disentuh. Rencana verifikasi ada di `RESCUENET_PWA_IPHONE_TEST_PLAN.md`.
