# RescueNet Mobile — Fase 1

Aplikasi React Native + TypeScript strict, Expo SDK 55, Android/iOS. Source ini berada hanya di `Rescuenet-apk`. Firmware Field Node, Gateway, dan backend tidak diubah.

**PWA iPhone (prototipe):** lihat [`pwa/README.md`](pwa/README.md), jalankan `npm.cmd run pwa:test` dan `npm.cmd run pwa:serve`. PWA mengikuti protokol Android/Field Node tetapi belum dianggap siap untuk iPhone fisik: HTTPS-to-HTTP LAN, CORS/OPTIONS, dan dukungan WebKit masih harus divalidasi pada domain serta perangkat target.

**Batas saat ini:** aplikasi sudah memiliki profil, GPS HP, tracking, SOS dan antrean persisten. Firmware yang ada **belum memiliki API mobile**. Karena itu belum ada alur GPS HP → LoRa → dashboard. Jangan menganggap `DELIVERED` sebagai konfirmasi petugas: artinya hanya ACK penerimaan dari Field Node sesuai kontrak Fase 2.

## Mulai dari sini: APK tanpa Android Studio

Jalankan di PowerShell laptop, bukan terminal Raspberry Pi. Gunakan Node.js 22.14+ (versi LTS yang kompatibel dengan SDK 55). Internet diperlukan untuk instalasi dependency dan EAS Build, bukan untuk operasi aplikasi yang sudah terpasang.

```powershell
cd D:\RescueNET\Rescuenet-apk
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run doctor
npm.cmd run eas -- login
npm.cmd run build:apk
```

Perintah login akan meminta akun Expo Anda. Build pertama akan meminta penautan/pembuatan proyek EAS dan signing Android. Pilih akun/proyek milik Anda dan izinkan EAS mengelola keystore bila sesuai kebutuhan. Simpan akses akun dan cadangan signing untuk pembaruan aplikasi berikutnya.

`build:apk` menjalankan `eas build -p android --profile preview` dengan EAS CLI 24.7.0. Wrapper `scripts/eas.cjs` menetapkan `EAS_NO_VCS=1` dan `EAS_PROJECT_ROOT` ke folder aplikasi agar direktori firmware/server induk bukan root arsip upload. `.easignore` mengecualikan node_modules, hasil export, native generated directories, database, dan credentials lokal. Tetap periksa daftar arsip sebelum mengirim materi sensitif ke layanan build. **EAS adalah layanan cloud build**, bukan dependency runtime RescueNet.

Setelah build benar-benar sukses, buka tautan artefak yang diberikan EAS, unduh APK, lalu pasang di Android dengan izin instalasi dari sumber tersebut. APK preview menyertakan JavaScript sehingga tidak membutuhkan laptop/Metro. Nama unduhan EAS dapat berbeda; boleh diganti menjadi `RescueNet.apk`. **Repositori ini belum berisi APK hasil build.**

Untuk memeriksa arsip lokal sebelum upload:

```powershell
npm.cmd run eas -- build:inspect -p android -s archive -o .eas-inspect --profile preview
```

Jika tersedia EAS CLI langsung, ekuivalennya di PowerShell:

```powershell
$env:EAS_NO_VCS = '1'
$env:EAS_PROJECT_ROOT = (Get-Location).Path
npx.cmd eas-cli@24.7.0 build -p android --profile preview
```

## Development build

Jangan mengandalkan Expo Go untuk background location/konfigurasi native.

```powershell
npm.cmd run eas -- build -p android --profile development
npm.cmd start
```

Pasang development APK lalu buka URL Metro dari QR. HP dan laptop harus dapat menjangkau Metro. Saat HP berpindah ke Wi-Fi Field Node tanpa internet, Metro di jaringan sebelumnya mungkin terputus. **Gunakan APK preview standalone untuk demo offline**, bukan development client yang masih memerlukan bundle dari Metro. Debug Android mengizinkan HTTP LAN khusus Metro; release/preview tetap membatasi HTTP ke IP node.

Jika kelak Android SDK dan JDK yang sesuai terpasang:

```powershell
npx.cmd expo prebuild --platform android
npx.cmd expo run:android
```

Jangan mengedit `android/` atau `ios/` generated secara manual; ubah app.json/plugin lalu prebuild ulang. Folder native diabaikan Git/EAS agar cloud build menerapkan config plugin secara konsisten.

## Cara demo Fase 1

1. Buka aplikasi, isi nama. ID UUID dibuat otomatis dan disimpan bersama profil dalam SQLite lokal.
2. Izinkan lokasi ketika diminta. Pilih lokasi presisi; GPS tidak perlu internet tetapi cold start di luar ruangan bisa memakan waktu. Jika ditolak, SOS masih dapat dipakai tanpa GPS.
3. Tekan **Perbarui GPS** untuk latitude, longitude, akurasi dan waktu fix. Data lebih dari 120 detik atau koordinat tidak valid tidak dimasukkan ke SOS. `(0, 0)` tidak otomatis dianggap rusak; validasi berdasarkan umur/rentang.
4. Tekan **START TRACKING** secara eksplisit. Default foreground; kirim ketika mendapat fix sekitar 30 detik sejak fix terakhir yang diantrekan, atau bergerak 25 m dengan batas minimal 15 detik. Tidak ada pengiriman per detik.
5. Untuk layar terkunci, pilih **Aktif saat layar terkunci** sebelum START. Baca penjelasan izin background. Android 13+ juga meminta notifikasi agar layanan aktif terlihat. Penolakan tidak diam-diam mengaktifkan background.
6. Pilih Wi-Fi `RescueNet-Node1/2/3` melalui pengaturan HP; pilih tetap tersambung walau “No Internet”. Aplikasi tidak otomatis memindahkan Wi-Fi dan tidak membaca SSID.
7. Tekan **SEND SOS** kapan saja. SQLite commit dilakukan sebelum HTTP, menggunakan GPS valid terakhir atau `has_gps:false`. Tidak menunggu fix dan tidak menunggu interval tracking. Jika ada HTTP yang sedang berjalan, worker menyelesaikannya dulu (timeout 6 detik); SOS diprioritaskan atas lokasi biasa.
8. Dengan firmware lama, lihat **API mobile belum kompatibel** dan **QUEUED**. Ini perilaku benar: portal HTML bukan ACK. Pengiriman sukses memerlukan implementasi Fase 2.
9. Matikan Wi-Fi, buat beberapa SOS, tutup/buka aplikasi: profil dan antrean tetap ada. Ketika jaringan kembali, retry berjalan selama aplikasi foreground atau mendapat kesempatan task background.
10. STOP mengakhiri tracking dan membuang lokasi biasa yang masih menunggu, **bukan SOS**. Permintaan yang sudah in-flight mungkin selesai. Force-stop OS/reboot memerlukan pemeriksaan dan pengaktifan ulang; jangan menjanjikan tracking setelah aplikasi dipaksa berhenti.

Jika HP beralih ke seluler/Wi-Fi lain secara otomatis, pilih tetap memakai Wi-Fi tanpa internet/nonaktifkan smart network switching untuk demo. Aplikasi tidak memaksa routing jaringan dari JavaScript. Firewall, VPN, izin local network iOS, dan fitur vendor dapat memengaruhi koneksi; uji pada HP target.

## Arsitektur kode

```text
index.ts ── registrasi TaskManager sebelum React
App.tsx ── lifecycle foreground/background + error boundary
src/screens/ ── SetupScreen, HomeScreen
src/components/ ── elemen UI dan tema
src/services/
  LocationService ── izin foreground, one-shot GPS, pemetaan native
  TrackingService ── consent, watcher/native tracking, pembatas laju
  backgroundTask ── callback native, fix terbaru, retry antrean
  SosService ── snapshot GPS, commit SOS, flush segera
  NetworkMonitor ── probe lokal, perubahan jaringan, retry foreground
  RescueNetApi ── HTTP timeout dan validasi ACK
  OutboxService ── satu worker, prioritas SOS, backoff
src/storage/ ── SQLite, profil/settings, repository antrean
src/models/ ── tipe payload/status
src/config/settings.ts ── IP, interval, jarak, timeout, usia GPS
src/utils/location.ts ── validasi fix, jarak, payload SOS
tests/ ── unit API/GPS dan repository SQL menggunakan SQLite nyata
plugins/withLocalNetwork.cjs ── kebijakan HTTP Android
```

Database `rescuenet-mobile.db` menggunakan WAL dan transaksi. SOS menyimpan identitas, snapshot lokasi, waktu, ID permintaan, status, attempts, nextAttemptAt, lastError dan deliveredAt. Pending SOS tidak kedaluwarsa/dihapus otomatis; UI menampilkan 20 terbaru dan jumlah total belum terkirim. Riwayat delivered SOS juga dipertahankan. Lokasi biasa hanya menyimpan pending terbaru, plus maksimal satu in-flight. Penyimpanan gagal ditampilkan sebagai **FAILED**, bukan queued/sukses palsu.

Urutan status: READY → QUEUED (persisten) → SENDING → DELIVERED atau kembali QUEUED. Setelah restart, SENDING dipulihkan menjadi QUEUED dengan request_id sama. Retry berjarak 10, 20, 40, 80, 160, lalu maksimal 300 detik; saat jaringan berubah/pulih atau retry manual jadwal dipercepat. Foreground memeriksa node tiap 15 detik. Tiap flush maksimal empat pesan untuk membatasi waktu task. Retry tanpa batas attempts, tetapi tidak dijanjikan ketika OS menangguhkan aplikasi. Timestamp internal milidetik; HTTP detik Unix.

`request_id` dan header `Idempotency-Key` mencegah identitas berubah saat retry. **Server/Field Node harus mengimplementasikan deduplikasi**; timeout setelah node menerima data dapat menghasilkan retry. Klien sendiri tidak dapat menjamin exactly-once/end-to-end delivery.

## Android dan iOS

| Aspek | Implementasi / batas |
| --- | --- |
| Android GPS | Foreground fine/coarse; pengguna tetap bisa memilih approximate. Akurasi ditampilkan apa adanya. |
| Android background | ACCESS_BACKGROUND_LOCATION + foreground service location; notifikasi aktif. Android 11+ mungkin membuka halaman Settings. Vendor/hemat baterai dapat menghentikan layanan. |
| iOS GPS | When In Use lebih dulu; Always hanya bila pengguna memilih background. Allow Once dapat membuat permintaan Always berikutnya ditolak; buka Settings. |
| iOS background | TaskManager top-level dan UIBackgroundModes location; interval bukan jaminan. Force quit, daya, dan kebijakan OS membatasi callback. |
| Wi-Fi | Probe HTTP lokal, tidak memakai internet reachability sebagai gerbang. Tidak menampilkan SSID palsu atau menganggap koneksi Wi-Fi = node siap. |
| Android HTTP | Release hanya `192.168.4.1`; bukan global cleartext. Debug-only XML overlay mengizinkan Metro LAN. |
| iOS HTTP | NSAllowsLocalNetworking + exception IP 192.168.4.1 dan alasan izin local network; tidak memakai NSAllowsArbitraryLoads global. |
| Privasi | Tidak ada analytics/cloud auth/maps. Nama/lokasi disimpan dalam sandbox SQLite, **tidak dienkripsi tingkat aplikasi**; HTTP lokal juga tidak terenkripsi. Jangan menganggap service marker sebagai autentikasi node. |
| Backup | Android allowBackup=false. Backup sistem iOS belum dinonaktifkan; ikuti kebijakan perangkat untuk data sensitif. Uninstall/clear data dapat menghilangkan antrean. |

Proyek iOS menggunakan source yang sama. Build iPhone memerlukan akun/signing/provisioning Apple yang sesuai, dan perangkat terdaftar untuk distribusi internal. Native build lokal memerlukan macOS + Xcode; Windows hanya dapat menyiapkan/export bundle atau memakai EAS cloud.

```powershell
npm.cmd run eas -- build -p ios --profile development
```

## Validasi dan batas pembuktian

Lihat [VALIDATION.md](VALIDATION.md) untuk hasil yang benar-benar dijalankan serta checklist uji HP. Export `.hbc` bukan APK/IPA dan tidak membuktikan permission UI, rendering, GPS maupun background service pada perangkat.

Tes memakai fetch yang diinjeksi, tanpa endpoint cloud dan tanpa mode sukses palsu dalam aplikasi. Repository SQL yang sama diuji dengan SQLite bawaan Node; adapter native `expo-sqlite` tetap perlu diuji di HP. Node 22 menampilkan experimental warning untuk `node:sqlite`; bukan kegagalan tes.

Override terbatas `xcode → uuid@11.1.1` menutup advisory dependency build-tool. `xcode` menggunakan `uuid.v4()` yang masih kompatibel; prebuild/config introspection turut diperiksa. Jangan menjalankan `npm audit fix --force` yang dapat mengganti major Expo tanpa evaluasi.

## Fase 2 — menunggu persetujuan

Spesifikasi ada di [docs/PHASE_2_API_CONTRACT.md](docs/PHASE_2_API_CONTRACT.md). Tambahkan JSON API tanpa merusak `/`, `/submit`, `/sos`, tombol SOS fisik, radio, relay, HOP/MAX_HOP atau parser legacy. GPS HP tidak boleh diganti diam-diam dengan GPS T-Beam. Belum ada perubahan firmware atau backend pada Fase 1.

## Referensi resmi

- [Expo SDK 55 Location: izin dan batas background](https://docs.expo.dev/versions/v55.0.0/sdk/location/)
- [Expo TaskManager](https://docs.expo.dev/versions/v55.0.0/sdk/task-manager/)
- [Android Network Security Configuration](https://developer.android.com/privacy-and-security/security-config)
- [Apple NSAllowsLocalNetworking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
- [EAS build archive dan batas root](https://github.com/expo/fyi/blob/main/eas-build-archive.md)
- [Mengecualikan file upload EAS](https://docs.expo.dev/build-reference/easignore/)
