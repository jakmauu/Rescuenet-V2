# Laporan validasi Fase 1

Lingkungan: Windows PowerShell, Node 22.14.0, npm 10.9.2. Semua implementasi berada di `D:\RescueNET\Rescuenet-apk`. Pemeriksaan source Field Node/Gateway/backend bersifat read-only; perubahan lama pada working tree dipertahankan.

## Perintah yang dijalankan

```powershell
npm.cmd install --no-audit --no-fund
npx.cmd expo install react react-native expo-location expo-task-manager expo-sqlite expo-crypto expo-network expo-dev-client react-native-safe-area-context @types/react
npx.cmd expo install expo-system-ui
npm.cmd install --no-fund
npm.cmd ci --no-fund
npm.cmd run typecheck
npm.cmd test
npx.cmd expo install --check
npx.cmd expo-doctor
npm.cmd audit --json
npm.cmd run export:android
npx.cmd expo export --platform ios --output-dir dist-ios
npx.cmd expo export --platform all --output-dir dist
npx.cmd expo prebuild --platform android --no-install
npx.cmd expo prebuild --platform all --no-install
npx.cmd expo config --type introspect --json
npm.cmd run eas -- whoami
```

Instalasi awal hanya Expo sempat menghasilkan transitive peer dependency React Native yang tidak sesuai SDK. `expo install` mengoreksi versi sesuai SDK55 tetapi proses CLI lama sempat berakhir dengan missing module setelah dependency-nya sendiri diganti. Invocation berikutnya berjalan normal; bukan error yang diabaikan. Lockfile serta instalasi bersih `npm ci` dipakai untuk pemeriksaan akhir.

## Hasil

- TypeScript strict/noUncheckedIndexedAccess: lolos.
- Tes API/GPS/SQLite/config: **19 tes lolos, 0 gagal** setelah instalasi bersih.
- Expo dependency compatibility: dependencies up to date.
- Expo Doctor: 20/20 checks passed.
- npm audit dependency aplikasi setelah override terbatas uuid: 0 vulnerabilities pada pemeriksaan ini. Ini bukan jaminan tidak ada celah; CLI EAS yang diunduh terpisah memiliki dependency/tooling sendiri.
- Android export: berhasil menghasilkan Hermes bundle/metadata di `dist/`.
- iOS export: berhasil menghasilkan Hermes bundle/metadata di `dist-ios/`.
- Android native prebuild: berhasil; XML HTTP main/debug dan manifest izin diperiksa. Android release mengizinkan HTTP hanya ke 192.168.4.1.
- iOS config introspection: memuat izin lokasi, UIBackgroundModes location, alasan local network, exception IP dan tidak memuat NSAllowsArbitraryLoads. Windows prebuild `--platform all` hanya menghasilkan Android; **bukan** bukti build native iOS.
- Lint: tidak dikonfigurasi; tidak diklaim lulus lint.
- Warning nonfatal: dependency transitif deprecated, Node SQLite experimental, dan NO_COLOR/FORCE_COLOR. Bukan kegagalan TypeScript/export.

## APK / IPA

Belum ada APK/IPA yang dihasilkan. Android SDK/adb tidak ditemukan pada PATH, ANDROID_HOME/ANDROID_SDK_ROOT kosong, direktori SDK default tidak ditemukan, dan tidak ada android/local.properties. Export bundle bukan Gradle assemble. EAS `whoami` mengembalikan **Not logged in** (exit 1). Cloud build memerlukan akun/proyek EAS dan signing; tidak ada build cloud yang disubmit pada sesi ini. iOS native build/signing juga belum dilakukan.

Jalankan berikutnya dari folder aplikasi:

```powershell
npm.cmd run eas -- login
npm.cmd run build:apk
```

Tidak ada path `RescueNet.apk` yang dapat diberikan sebelum build tersebut selesai. Periksa juga arsip build dengan perintah build:inspect di README agar hanya aplikasi yang diupload.

## Apa yang dibuktikan oleh tes otomatis

Tes SQL menggunakan schema/query repository produksi dengan adapter Node SQLite: semua SOS dipertahankan, pending lokasi diganti secara transaksional, rollback saat insert gagal, prioritas SOS, single-worker concurrent flush, retry/backoff dan attempts, pemulihan SENDING serta buka ulang database file. Tes ini tidak mengeksekusi bridge native expo-sqlite di Android/iOS.

Tes API memeriksa payload/Idempotency-Key, timeout abort, non-2xx, HTML captive portal, JSON rusak, ACK request_id salah, marker API salah, dan probe node. Tidak ada mock mode aplikasi yang otomatis menyebut data tersampaikan.

Tes GPS memeriksa stale/out-of-range/nonfinite/future fix, akurasi, 0° koordinat valid, SOS tanpa GPS, timestamp detik, threshold 30s/25m/min15s. Tes konfigurasi memeriksa APK profile serta tidak adanya global ATS bypass.

## Checklist HP fisik — BELUM dijalankan

| Skenario | Hasil yang perlu dibuktikan di perangkat |
| --- | --- |
| Instalasi pertama/restart | Nama dan UUID sama setelah restart; tracking awal mati |
| Izin GPS presisi | Koordinat/akurasi/waktu fix HP tampil, bukan posisi node |
| Denied / Don't ask again | Pesan jelas dan tautan Settings; SOS tanpa GPS tetap bisa disimpan |
| GPS off/di dalam gedung | GPS NO FIX, timeout refresh; tombol SOS tetap aktif |
| START/STOP | Tidak kirim sebelum START; cadence normal; STOP tidak menghapus SOS |
| Wi-Fi no internet | Tetap mencoba IP lokal, tidak menunggu internet reachable |
| Firmware lama | HTML redirect tidak dianggap sukses; SOS QUEUED |
| API future/test node | POST serta ACK valid menghasilkan DELIVERED hanya ke node |
| Putus Wi-Fi | Semua SOS tersimpan, attempts bertambah secara terbatas |
| Buka ulang aplikasi | SOS yang SENDING saat mati pulih QUEUED dengan ID sama |
| Wi-Fi kembali | Retry otomatis foreground; saat background mengikuti callback OS |
| Layar terkunci Android | Notifikasi foreground service terlihat; GPS/task berjalan pada HP target |
| Background iOS | Always/local network granted; amati cadence OS, bukan menjanjikan tepat 30 detik |
| Force-stop/reboot | Tidak mengklaim selalu hidup; periksa status dan aktifkan kembali |
| Disk penuh/DB rusak | FAILED/peringatan; jangan menghapus DB diam-diam |
| Banyak SOS | Tidak ada pending SOS yang tertimpa; jumlah antrean >20 tetap utuh |
| Teks besar/TalkBack/VoiceOver | Semua status dapat dibaca, tombol SOS mudah ditekan, layout tidak terpotong |

Skenario Field Node → LoRa relay → Gateway → serial → dashboard lokasi pengguna menunggu Fase 2, dan **tidak** diklaim lulus pada Fase 1. Harus diuji terpisah setelah API/protokol/backend disepakati.
