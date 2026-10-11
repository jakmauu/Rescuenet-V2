# RescueNet Monitoring Dashboard — UI redesign

## Ruang lingkup

Empat halaman mengikuti satu design system navy/biru: Dashboard, Emergency Reports,
GPS Map, Mesh Nodes. System Status, REST API, penyimpanan, ingest serial/MQTT,
firmware, protokol, ACK, retry, dan deduplikasi tetap menggunakan implementasi existing.
Logo lokal adalah salinan asli logo yang diberikan, tidak digambar ulang.

Redesign ini **tidak mempercepat transmisi radio** dan tidak mengubah polling:
laporan/PWA SOS 2 detik; posisi peta dan data health 5 detik sesuai konfigurasi existing.
Interval tersebut dimulai dari data yang sudah tersedia di server, bukan jaminan
waktu SOS dari iPhone hingga Raspberry Pi.

## Struktur runtime

- `templates/base.html`: satu shell, urutan stylesheet/script, navigasi tanpa reload.
- `templates/components/`: sidebar, header, sprite ikon, modal, macro kartu/toolbar.
- `templates/pages/`: Dashboard, Reports, Map, Mesh Nodes, System Status.
- `static/css/style.css`: stylesheet existing, termasuk perubahan lokal sebelumnya;
  dipertahankan. `tokens.css`, `components.css`, `layout.css`, `pages/*.css` melapisi
  desain baru. Container map memiliki stacking context agar pane Leaflet tidak
  menutupi navigasi/sidebar/modal, tanpa mengubah konfigurasi Leaflet.
- `static/js/ui.js`: formatter/badge, normalisasi referensi insiden, DOM helper.
- `static/js/pages/*.js`: renderer halaman dengan state eksplisit. Logic Leaflet
  existing dipisah ke factory `pages/map.js` dengan endpoint/provider/marker/zoom/
  filter/fit/popup/refresh yang sama; klik marker juga mengisi panel informasi.
- `static/js/app.js`: fetch, polling, navigasi, filter, event dan PATCH status existing.
- `static/vendor/leaflet-1.9.4/`: versi Leaflet yang sama, sekarang tersedia lokal;
  license disertakan. Tile source tidak berubah.
- `static/img/branding/rescuenet-logo.png`: logo asli.

Tidak perlu route baru, bundler, npm runtime, maupun migrasi database.

## Arti data/status dan perbedaan dari mockup

- Dashboard summary berasal dari `/api/stats` (laporan legacy/portal). PWA SOS
  ditampilkan dari `/api/mobile/events` dan bukan ditambahkan sebagai angka palsu
  ke summary legacy. Ringkasan Emergency Reports mengikuti records yang dimuat.
- Portal/device dan PWA SOS tampil bersama di tabel latest SOS. Halaman Reports
  mempertahankan daftar PWA tersendiri di atas tabel portal/device, karena kontrak
  API dan handling status berbeda. Pencarian/filter/pagination tabel berlaku untuk
  maksimal 1.000 records legacy yang dimuat. PWA feed maksimal 100 events existing.
- Badge PWA "Stored on server" hanya untuk `delivery_state: STORED`. Legacy records
  berasal dari API database server. Keduanya tidak membuktikan petugas sudah bertindak.
- Timestamp penerimaan Field Node tidak disediakan API: timeline menyatakan tidak
  tersedia. `received_at` adalah waktu penerimaan server. "Visible on this dashboard"
  memakai waktu observasi di sesi browser ini, bukan waktu historis yang direkayasa.
- Online/stale/unknown memakai `device_status` heartbeat server. Report activity,
  readiness serial Gateway, mesh sync/Gateway found adalah indikator terpisah.
  Node tanpa heartbeat bukan otomatis offline. Telemetry null tetap "Not available"
  atau "Unknown", sedangkan nilai 0 yang benar-benar diterima tetap 0.
- Node list/roster hanya menampilkan node yang ditemukan API, bukan dummy Node 1/2/3.
  Garis topologi menunjukkan asosiasi logis, bukan rute relay atau paket aktual.
- Grafik menggunakan count aktivitas actual. API tidak menyediakan pemisahan kritis
  per bucket, jadi grafik tidak membuat stacked critical series seperti mockup.
- Tidak ada tombol Node Settings palsu: actions yang tersedia View reports dan
  Locate on map (nonaktif bila koordinat node tidak tersedia).
- Saat feed gagal, tampilkan warning dan pertahankan data terakhir jika ada.
  "Local Server Connected" bukan klaim semua perangkat atau feed masih sehat.
- Leaflet, logo, CSS/JS lokal tidak perlu CDN. Tile peta existing masih dapat
  membutuhkan internet. Tidak ada download/prefetch tile; marker/control tetap lokal.

## Animasi Mesh Nodes

- Latar gunung berlapis berasal dari SVG lokal `static/img/mesh-mountains.svg`;
  bukan peta geografis. Latar/garis dekoratif tidak menangkap klik atau fokus.
- Garis SVG mengikuti `device_status` API existing: Online biru dengan dash halus,
  Stale amber bergerak lebih lambat/memudar, Unknown abu-abu statis. Ring hijau
  Field Node hanya untuk Online; status Gateway tetap kesiapan USB serial.
- Keterangan "Line animation reflects reported node status, not packet path" dan
  "Logical associations · route not measured" tetap terlihat. Tidak ada pengukuran
  rute atau traffic baru, endpoint baru, maupun perubahan interval polling.
- Node/garis dipertahankan saat polling agar fokus keyboard dan animasi tidak di-reset.
  SVG menyesuaikan posisi kartu ketika ukuran layar, jumlah node, atau halaman berubah.
- Preferensi OS/browser reduced motion menghentikan semua gerak; label status tetap
  terlihat. Memilih node, View reports, Locate on map dan Refresh memakai aksi existing.
  Node Settings tidak ditambahkan karena tidak ada implementasi existing.
- CSS/JS Mesh Nodes memakai versi cache `mesh-animation-20261011-1` pada `base.html`.
  Salin template base, template halaman, stylesheet, JavaScript, dan SVG bersamaan.

Acuan implementasi: [SVG stroke-dashoffset](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/stroke-dashoffset),
[CSS animations](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Animations/Using),
[prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).

## Preview aman di Windows

Jalankan dari root repo `D:\Rescuenet-V2`:

```powershell
python Resquenet-server/scripts/preview_dashboard.py
```

Buka `http://127.0.0.1:5055`. Preview memakai database sementara kosong dan tidak
memulai serial/MQTT, tidak menyentuh database produksi. Ctrl+C untuk berhenti.
Empty/unknown state yang terlihat adalah normal. `--port 5057` jika port sedang dipakai.

## Pemeriksaan

```powershell
python -m pytest Resquenet-server/tests -q
node --test Resquenet-server/tests/dashboard_ui.test.cjs
node --check Resquenet-server/static/js/app.js
node --check Resquenet-server/static/js/ui.js
Get-ChildItem Resquenet-server/static/js/pages/*.js | ForEach-Object { node --check $_.FullName }
git diff --check
```

Browser smoke opsional memerlukan Playwright dan Chrome. Gunakan instalasi test-only,
bukan dependency runtime/dashboard:

```powershell
npm.cmd install --prefix "$env:TEMP\rescuenet-dashboard-browser-tools" --no-save --package-lock=false playwright
$env:RESCUENET_PLAYWRIGHT_PATH = "$env:TEMP\rescuenet-dashboard-browser-tools\node_modules\playwright"
node Resquenet-server/tests/dashboard_browser_smoke.cjs
```

`tests/dashboard_smoke_server.py` hanya fixture lokal: database disposable, port5056,
tidak memulai serial/MQTT. Data ilustrasi/screenshot berasal dari fixture ini, tidak
ditanam pada renderer produksi. Test memeriksa API status PATCH sebenarnya pada
fixture, navigasi, filter, sorting, pagination, popup/zoom/filter/fit Leaflet,
refresh record yang disimpan, viewport1600/768/375, API error/disconnect dan aset lokal.
Mesh Nodes juga diuji pada 320px dengan lima ID node arbitrer, pergantian status,
empty/recovery, garis yang tetap menempel pada kartu, reduced motion, keyboard,
Refresh tanpa reset animasi/fokus, serta navigasi View reports/Locate on map.
Tile smoke menggunakan provider existing; hasil network harus diperiksa di output,
bukan diasumsikan. Hasil bukan bukti koneksi ke radio/Gateway/iPhone nyata.

## Buat paket UI

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Resquenet-server/scripts/package_dashboard_ui.ps1
```

Menghasilkan `artifacts/rescuenet-dashboard-ui.zip`. Isi runtime hanya `templates/`
dan `static/`, ditambah panduan ini di `docs/`. Tidak memasukkan `.env`, database,
sertifikat, private key, source Python/backend, PWA atau firmware. Source map vendor
opsional tidak dimasukkan (tidak dibutuhkan runtime). Skrip menolak menimpa ZIP yang
sudah ada; rename ZIP lama atau berikan `-OutputZip` baru bila membuat paket berikutnya.

## Pindahkan ke Raspberry Pi — dilakukan pengguna, bukan otomatis

**Sebelum update:** backend Raspberry Pi harus versi proyek ini dengan endpoint
existing. Paket UI tidak meng-update Python/database/backend lama.

PowerShell Windows, dari root repo:

```powershell
scp .\artifacts\rescuenet-dashboard-ui.zip rescuenet@10.10.10.22:/home/rescuenet/RescueNET/rescuenet-dashboard-ui.zip
ssh rescuenet@10.10.10.22
```

Di shell Raspberry Pi, backup dulu dua direktori UI sebelum menimpa file:

```bash
cd /home/rescuenet/RescueNET/Resquenet-server
backup_dir="/home/rescuenet/RescueNET/dashboard-ui-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir" && cp -a templates static "$backup_dir/"
```

**Hanya lanjut jika backup berhasil.** Periksa arsip lalu ekstrak ke direktori server:

```bash
unzip -l /home/rescuenet/RescueNET/rescuenet-dashboard-ui.zip
unzip -o /home/rescuenet/RescueNET/rescuenet-dashboard-ui.zip -d /home/rescuenet/RescueNET/Resquenet-server
```

Restart **proses dashboard Flask yang biasanya digunakan** supaya template lama tidak
tertahan di memori. Jangan menebak nama unit systemd, menjalankan server kedua pada
port yang sama, atau menghentikan serial/MQTT tanpa kebutuhan. Buka dashboard biasa
`http://10.10.10.22:5000`, lalu hard refresh (Ctrl+Shift+R pada desktop). Jika aset
belum berubah, pastikan seluruh `templates` dan `static` tersalin, bukan hanya index.
File CSS/JS redesign memiliki query versi yang sama pada base.html untuk pembaruan cache.

Rollback UI: setelah menghentikan proses dashboard secara normal, salin kembali
`templates/` dan `static/` dari backup, kemudian restart dashboard. Tidak perlu
menyentuh database, firmware atau broker.

## Uji di perangkat target

1. Semua lima halaman, menu mobile, scroll tabel, focus keyboard dan modal status.
2. SOS portal/PWA nyata muncul pada list yang tepat setelah API server menyimpannya.
3. Ubah handling status legacy dan verifikasi tersimpan; PWA tidak mempunyai action
   PATCH handling jika backend tidak menyediakan.
4. Data node heartbeat/RSSI/SNR/hop/pending dari firmware, bukan dari fixture screenshot.
5. Leaflet marker, popup, fit, zoom, filter, refresh dan akses tile pada jaringan Pi.
6. Matikan akses server dari browser dan pastikan warning/last data, lalu sambungkan
   kembali. Uji tidak adanya internet: UI lokal tetap berjalan, tile mungkin kosong.
7. Catat waktu end-to-end radio terpisah; redesign UI tidak menjamin SLA SOS.
