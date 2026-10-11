# RescueNet PWA iPhone — Test Plan (Prepared, Not Run)

Semua kasus di bawah masih **belum dijalankan**. Tes browser/unit memakai mock aman; uji Field Node, mesh, server produksi, dan iPhone memerlukan izin serta perangkat pengguna. Jangan menganggap daftar ini sebagai hasil lulus.

## Unit/source tests yang disiapkan

File `Rescuenet-apk/pwa/tests/core.test.mjs` saat ini mencakup verifikasi status/version API, timeout/kegagalan fetch, ACK SOS dengan request ID yang cocok, SOS tanpa GPS, payload lokasi, throttling pergerakan, profil/ID stabil saat edit, dan penolakan accuracy buruk.

File `Resquenet-server/tests/test_api.py` menyiapkan kasus paket mobile lama yang tiba belakangan tidak menggantikan fix yang timestamp-nya lebih baru.

Belum ada test DOM/Service Worker penuh untuk consent/profile wizard, visibility lifecycle, backoff, cache API network-only, map popup, atau rotasi/safe-area. Test source tambahan masih direkomendasikan sebelum menyatakan behavior UI terverifikasi.

## 1. Profil dan consent

- [ ] Pengguna baru: simpan nama, peran, kelompok opsional; ID dibuat sekali dan bertahan saat reload.
- [ ] Edit nama/peran/kelompok; `user_id` tidak berubah dan tidak membuat profil baru.
- [ ] Field `role`/`team` tidak ikut payload Field Node sampai API memiliki dukungan/versioning.
- [ ] Persetujuan sharing awal tidak aktif; tanpa centang, tombol Mulai tidak bisa mengaktifkan watcher.
- [ ] Centang consent lalu mulai/stop; stop membersihkan watcher/pending dan menghentikan callback terlambat.
- [ ] Reset profil mengonfirmasi tindakan, menghapus profil/fix/pending lokal, tetapi tidak menjanjikan penghapusan data server.
- [ ] Hapus storage browser: aplikasi kembali ke onboarding; tidak mengklaim ID bisa dipulihkan.

## 2. Koneksi Field Node / browser

- [ ] AP `RescueNet-Node1`/node target aktif; iPhone terhubung manual tanpa mengharuskan internet.
- [ ] `GET /api/status` mengembalikan JSON `service`, `api_version`, `node_id`, `device`, `status`, `mobile_protocol`, dan `mobile_tx_enabled` sesuai firmware.
- [ ] Node mati, IP salah, timeout 3 detik, JSON rusak, HTTP error, serta versi/capability tidak cocok menghasilkan status berbeda/diagnosa yang jujur.
- [ ] Tekan Periksa koneksi berkali-kali: satu request aktif, loading state terlihat, tombol kembali aktif setelah gagal.
- [ ] Ubah IP origin ke alamat tak valid dan origin Field Node alternatif; alamat hanya diterima bila format URL valid.
- [ ] Ganti SSID saat aplikasi terbuka; kembali ke foreground, cek ulang status dan pulih saat node kembali tersedia.
- [ ] iPhone Safari HTTPS → HTTP privat: catat versi iOS/Safari, prompt Local Network, console/error, apakah GET/OPTIONS/POST lolos. CORS sukses tidak dianggap bukti mixed-content teratasi.
- [ ] HTTP portal langsung: uji SOS/API bila diperlukan, tetapi catat Geolocation dan Add to Home Screen tidak dijamin karena bukan secure context.

## 3. GPS dan lifecycle

- [ ] Permission granted/denied, location unavailable, timeout, accuracy buruk (>250 m), koordinat di luar rentang, timestamp stale/future.
- [ ] Mulai tracking: tepat satu `watchPosition`; event lokasi tidak menyebabkan duplicate POST.
- [ ] Pindah ≥25 m setelah jeda minimal 15 detik memicu kandidat update; jika diam, cadence nominal 30 detik.
- [ ] `visibilitychange` hidden/pagehide membersihkan watcher dan timer; iOS dapat membekukan halaman.
- [ ] Kembali foreground: permission/koneksi dicek lagi dan watcher resume hanya jika consent + sesi sharing masih aktif.
- [ ] Stop/revoke ketika GPS request sedang berlangsung; callback terlambat tidak mengirim koordinat.
- [ ] Uji Add to Home Screen/standalone dan Safari tab terpisah; origin storage memang terpisah dan dijelaskan.

## 4. Queue dan SOS

- [ ] POST lokasi mendapat ACK `accepted:true` + request ID sama; UI hanya berkata Field Node menerima antrean.
- [ ] Putus jaringan setelah POST mungkin diterima; retry membawa request ID/payload identik dan tidak membuat duplikat.
- [ ] Pending lokasi hanya satu; fix lebih baru menggantikan pending lama; fix lewat 120 detik dibuang.
- [ ] Network/API error menerapkan backoff maksimal lima retry otomatis; tombol retry manual terlihat.
- [ ] SOS saat GPS tidak tersedia tetap dapat dikirim dengan `has_gps:false` sesuai parser firmware.
- [ ] Double tap tidak mengirim dua request bersamaan; Retry SOS memakai paket dan ID sama; SOS baru meminta konfirmasi.
- [ ] Field Node ACK tidak diartikan sebagai mesh, STORED server, atau respons petugas.
- [ ] Verifikasi dengan log serial Field Node/Gateway, serial bridge, MQTT, SQLite/mobile events, dan dashboard tanpa menjalankan test di produksi.

## 5. Dashboard/backend dan ordering

- [ ] Mobile event masuk dengan request key unik; duplikasi tidak memperbarui freshness server.
- [ ] Dua fix untuk satu user, fix baru diterima lebih dahulu dan fix lama belakangan: marker tetap di fix timestamp baru.
- [ ] Popup menunjukkan GPS fix time, server received time, accuracy, user key pseudonim, source node, dan hops.
- [ ] Recent/stale/offline dihitung dari timestamp lokasi; event SOS dengan `has_gps:false` tidak menciptakan koordinat.
- [ ] Marker mobile berbeda dari GPS Field Node, Gateway, dan SOS; tidak ada koordinat dummy.

## 6. PWA/cache/UI

- [ ] Manifest, ikon logo transparan, Apple touch icon, theme color, orientation, standalone.
- [ ] Cache versi baru menghapus cache RescueNet lama saja dan app-shell bekerja setelah pernah dibuka online.
- [ ] GET/POST `/api/...` selalu network-only; ketika offline tidak boleh ada respons API sukses dari cache.
- [ ] Rilis baru mengganti app shell; tutup/buka PWA dan periksa versi aset yang digunakan.
- [ ] iPhone kecil/besar, safe-area notch/home indicator, orientasi, keyboard, VoiceOver basics, reduced-motion, dan tap target ≥44 px.

## Kriteria stop uji

Hentikan penggunaan operasional bila Field Node/Gateway tidak menunjukkan jejak enqueue/forward yang sepadan, server tidak menunjukkan commit+ACK, status pada UI mengklaim server tetapi tidak ada event database, atau uji iPhone menunjukkan browser memblokir akses lokal. Laporkan log dan versi perangkat; jangan memperbaiki dengan menonaktifkan keamanan browser.
