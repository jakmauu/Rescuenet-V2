# Checkpoint 2B.1 — isolasi journal SOS

## Status terkini — 2026-09-20

**READY FOR MANUAL FLASH pada Field Node TTGO LoRa32 V1 yang sama dengan
firmware legacy pengguna; firmware baru belum diuji di perangkat.**
Pengguna mengonfirmasi profil dan model papan serta melaporkan kode awal
berfungsi. Audit `git show HEAD:field_node/field_node.ino` versus source sekarang
menunjukkan NODE_ID, semua pin LoRa/GPS/PMU/OLED/tombol, frekuensi, dan fungsi
legacy tidak berubah. Variant TTGO V1 memang mempunyai default LoRa RST14 dan
OLED SDA4/SCL15, tetapi sketch mengatur pin sendiri (LoRa RST23, OLED21/22);
tidak ada alasan berbasis compile saja untuk mengubah wiring yang telah bekerja.
Periferal tetap harus diuji lagi pada boot firmware baru.
Instruksi dan angka di bawah bagian ini adalah catatan historis tahap kandidat;
untuk upload/uji yang berlaku sekarang gunakan
[CHECKPOINT_2B_1_MANUAL_TEST.md](CHECKPOINT_2B_1_MANUAL_TEST.md). Codex tidak
melakukan upload, erase, reset, atau power-cycle Field Node.

- Field Node COM17, ESP32-D0WDQ6-V3, flash fisik 4 MB. Dua backup penuh di
  `D:\RescueNET-backups\20260920-180551` diverifikasi ulang: keduanya SHA-256
  `DF5195A4FF125BC6B609470F453CAA14E18D4DB130BF86F465D307AACC6A2AB3`.
- Tabel fisik dibaca ulang dari offset `0x8000`, hasilnya sama byte-for-byte
  dengan pembacaan pertama. Layout: nvs 0x9000/0x5000, otadata
  0xe000/0x2000, app0 0x10000/0x140000, app1 0x150000/0x140000,
  spiffs 0x290000/0x160000, coredump 0x3f0000/0x10000.
- Pada snapshot backup, seluruh SPIFFS 0x290000..0x3f0000 adalah `0xFF`,
  termasuk 32 KiB di 0x3e8000..0x3f0000. String namespace SOS lama
  `rn_mobile_b1` tidak terlihat pada snapshot default NVS; pemeriksaan string
  ini bukan parser NVS penuh. Backup tetap wajib disimpan, terutama bila isi
  perangkat berubah setelah snapshot.
- Kandidat telah diaktifkan sebagai `field_node/partitions.csv`: NVS/otadata/
  dua aplikasi/coredump tidak berubah; SPIFFS kini 0x290000/0x158000;
  `rn_sos` data/nvs 0x3e8000/0x8000. Semua aligned, tanpa overlap,
  akhir tabel tepat 0x400000; default NVS tetap NVS pertama.
- Build lokal `esp32:esp32:esp32`, core 3.3.3, berhasil: program 1.037.767
  byte (79% dari slot 1.310.720), RAM statis 69.260 byte (21% dari 327.680),
  sisa slot aplikasi 272.953 byte. Binary `field_node.ino.partitions.bin`
  cocok byte-for-byte (SHA-256 sama) dengan binary yang dibuat langsung dari
  `partitions.csv`. Host test 1.024 assertion, 8 vektor, 21 fungsi legacy,
  dan validator isolasi lulus. Runtime free heap dan persistensi fisik belum
  diuji. Gate 2B tetap **terbuka** sampai hasil manual diperiksa.
- Koreksi profil board pada 2026-09-20: Arduino IDE pengguna memilih
  **TTGO LoRa32-OLED → Revision V1 (No TFCard)**, bukan ESP32 Dev Module.
  FQBN terpasang `esp32:esp32:ttgo-lora32` (V1 default), core 3.3.3,
  flash 4 MB, DIO 80 MHz, EraseFlash Disabled. Platform prebuild memprioritaskan
  `field_node/partitions.csv` dari folder sketch. Compile **PASS** pada build
  bersih `field_node/.build-ttgo-lora32-2b1`: program **1.037.783** byte
  (79% dari app 1.310.720), RAM statis **69.260** byte (23% dari 294.912),
  sisa slot app **272.937** byte. Binary partisi TTGO cocok byte-for-byte
  dengan tabel aktif, SHA-256
  `32231ACE7F008DB1725BB4016E382E3E496F6E73FF7220E66A7E49B300C101EA`.
  Host tests dijalankan ulang dan lulus. Angka build ESP32 Dev Module di atas
  hanyalah pembanding historis, **bukan profil upload final**.

## Arsip tahap kandidat (sebelum inspeksi COM17)

Status saat tahap awal: implementasi lokal memakai partisi `rn_sos`; layout perangkat fisik belum
terverifikasi. **Gate 2B belum ditutup dan belum ada flashing.** Tidak ada port
serial yang terdaftar saat inspeksi sesi ini. Kapasitas4MB di bawah adalah
konfigurasi build, bukan hasil flash-id T-Beam pengguna.

## Akar masalah dan koreksi

Core terpasang3.3.3, `cores/esp32/esp32-hal-misc.c:294–301`, menginisialisasi default
NVS sebelum setup. Pada NO_FREE_PAGES/NEW_VERSION_FOUND, core mencari partisi
data/NVS pertama dan menghapusnya. Namespace rn_mobile_b1 di default NVS ikut hilang.

`MobileJournal.h` sekarang menjalankan `nvs_flash_init_partition("rn_sos")` secara
eksplisit. Error langsung false; tidak ada erase atau fallback. Selanjutnya
`Preferences::begin("rn_mobile_b1", false, "rn_sos")`. Signature tiga argumen dan
`nvs_open_from_partition` telah diperiksa pada Preferences.cpp/h core terpasang.
Preferences mengulangi init secara idempotent; kegagalan open juga fail closed.
Kandidat memastikan default `nvs` adalah data/NVS pertama sehingga recovery core
tetap menunjuk NVS sistem. Jangan menyusun ulang rn_sos menjadi NVS pertama.

Schema/node marker, ABI/version/size, CRC32, SHA256, dedupe, pending restore dan
completed32 tidak diganti. Setelah putBytes+commit, record dibaca ulang, version/
size/CRC dibandingkan, seluruh byte dicocokkan, SHA256 dihitung ulang, baru queue
menerima dan HTTP202 dikirim. Missing partition/init/open/write/readback/restore
fault → queue unhealthy, status degraded, POST valid503 storage_unavailable.
Perilaku fail-closed seluruh antrean tetap seperti2B, termasuk lokasi saat storage
fault; lokasi tetap RAM-only dan tidak ditulis ke flash. Status API tidak perlu
field baru: status ready/degraded dan mobile_tx_enabled=false sudah mencukupi.

## Layout build sebelumnya dan kandidat

FQBN `esp32:esp32:esp32`, core3.3.3; build2B menggunakan default.csv, flash4MB.
Source Field Node tidak memanggil SPIFFS/LittleFS/EEPROM/OTA. Slot OTA, filesystem,
dan coredump tetap ada pada tabel; tidak digunakannya filesystem di source ini
**tidak membuktikan perangkat tidak menyimpan data firmware lama**.

Semua nilai hex; interval `[offset, offset+size)`. Tabel ini exact terhadap
default.csv yang dibangun sebelumnya, belum terhadap flash perangkat fisik.

| Partisi | Offset sebelum → kandidat | Size sebelum → kandidat |
| --- | --- | --- |
| nvs (system) | 0x009000 → sama | 0x005000 → sama |
| otadata | 0x00e000 → sama | 0x002000 → sama |
| app0 | 0x010000 → sama | 0x140000 → sama |
| app1 | 0x150000 → sama | 0x140000 → sama |
| spiffs | 0x290000 → sama | 0x160000 → **0x158000** |
| rn_sos (baru data/nvs) | tidak ada → **0x3e8000** | tidak ada → **0x008000 (32KiB)** |
| coredump | 0x3f0000 → sama | 0x010000 → sama |

Kandidat berakhir0x400000; semua data offset/size aligned4KiB, app aligned64KiB,
tanpa overlap. Pengurangan SPIFFS32KiB membutuhkan review/migrasi filesystem;
bahkan byte akhir kosong tidak membuktikan filesystem bisa dikecilkan tanpa rebuild.
File kandidat `field_node/partition_candidates/rescuenet_4mb.csv` sengaja tidak
dipasang sebagai sketch/partitions.csv. Build biasa menghasilkan firmware yang
menolak storage dengan503 jika rn_sos tidak ada. Itu bukan binary deployment siap.

Budget journal:8record sekitar432byte +32completed sekitar88byte (~6.3KiB raw),
ditambah overhead entry/page NVS, schema, satu slot recovery dan page GC.32KiB/8page
memberi margin di atas data raw; full-NVS tetap harus diukur dengan NVS sebenarnya.
Tidak ada klaim jumlah raw-byte sama dengan kapasitas NVS efektif.

## Migrasi dan prasyarat perangkat

Sebelum mengaktifkan kandidat: identifikasi port Field Node, flash-id fisik,
partition table aktual, flash encryption/secure boot bila dipakai, dan penggunaan
filesystem/OTA/data lama. Pastikan backup lengkap terverifikasi disimpan aman
karena dapat mengandung identitas/lokasi dan kredensial WiFi.

Jika ada accepted SOS di namespace rn_mobile_b1 default NVS, **jangan menjalankan
firmware baru dulu**. Firmware baru tidak membaca/fallback/migrasi otomatis dari
default NVS. Backup harus diambil sebelum boot normal firmware lama dapat memicu
recovery core. Masuk ROM download mode dan baca flash. Rencana migrasi: ekstrak
record dari backup menggunakan tool NVS sesuai IDF, validasi schema/NODE_ID/version/
size/CRC/SHA, import verbatim ke namespace sama di rn_sos pada image staging,
readback setiap record dan cocokkan ID/count/digest sebelum mengizinkan traffic.
Jangan menghapus sumber; simpan backup dan buktikan duplicate setelah reboot.
Tool import produksi belum dibuat karena layout/data fisik belum tersedia;
perangkat dengan journal lama tidak boleh dianggap telah dimigrasikan.

Jika ada SPIFFS/LittleFS lama, export files dan rebuild untuk size baru atau pilih
layout alternatif setelah mengetahui flash aktual. Jika flash8MB dan area atas
benar-benar tidak teralokasi, rn_sos dapat ditempatkan di area bebas tanpa shrink;
tidak menganggap T-Beam tertentu otomatis8MB. Blank target rn_sos harus dipastikan
sebelum init; jangan memakai runtime autoformat untuk menyembunyikan data lama.

## Perintah inspeksi dan backup (read-only terhadap flash)

Perintah berikut dilakukan setelah port Field Node diidentifikasi. Memasuki ROM
download mode/reset menghentikan sementara layanan node. Tidak dijalankan otomatis.

```powershell
$esp = 'C:\Users\LENOVO\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.1.0\esptool.exe'
$part = 'C:\Users\LENOVO\AppData\Local\Arduino15\packages\esp32\hardware\esp32\3.3.3\tools\gen_esp32part.exe'
$nodePort = 'COM7' # GANTI dengan Field Node yang sudah dikenali
& $esp --chip esp32 --port $nodePort --after no-reset flash-id
# Hanya jika hasil fisik benar-benar4MB. Untuk ukuran lain sesuaikan length.
# Pilih nama backup BARU, jangan menimpa backup sebelumnya.
& $esp --chip esp32 --port $nodePort --after no-reset read-flash 0 0x400000 node-before-A.bin
& $esp --chip esp32 --port $nodePort --after no-reset read-flash 0 0x400000 node-before-B.bin
Get-FileHash node-before-A.bin,node-before-B.bin -Algorithm SHA256
# Hash kedua backup harus sama sebelum boot normal lagi.
& $esp --chip esp32 --port $nodePort --after no-reset read-flash 0x8000 0x1000 node-partitions-before.bin
& $part node-partitions-before.bin node-partitions-before.csv
Get-Content node-partitions-before.csv
```

Dengan flash encryption atau table offset nondefault, berhenti dan sesuaikan
prosedur terhadap konfigurasi nyata; backup terenkripsi tidak otomatis portable.
Tabel aktual harus dibandingkan dengan tabel di atas sebelum mengubah layout.

## Build dan flash bersyarat

Versi library tetap ArduinoJson6.21.5, LoRa0.8.0, XPowersLib0.3.3, U8g22.36.19.
Compile biasa bisa dilakukan sekarang tanpa perangkat:

```powershell
$cli = 'C:\Users\LENOVO\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
& $cli compile --fqbn esp32:esp32:esp32 --build-path .\field_node\.build-2b .\field_node
```

**Bagian berikut belum boleh dijalankan sampai layout/backup/migrasi perangkat
sudah direview.** Setelah target4MB/default layout dan dampak SPIFFS diselesaikan,
copy kandidat menjadi field_node/partitions.csv, compile ke direktori build baru,
decode binary partition hasil build dan bandingkan tabelnya. Upload standard
Arduino CLI dengan port Field Node dan build tersebut; Erase All Flash disabled.
Jangan flash merged.bin karena dapat menimpa data/journal di area padding.

```powershell
# CONDITIONAL: hanya setelah hardware review dan migrasi selesai
Copy-Item .\field_node\partition_candidates\rescuenet_4mb.csv .\field_node\partitions.csv
& $cli compile --fqbn esp32:esp32:esp32 --build-path .\field_node\.build-isolated .\field_node
& $part .\field_node\.build-isolated\field_node.ino.partitions.bin reviewed-build.csv
Get-Content reviewed-build.csv
# Setelah tabel hasil compile cocok dengan review perangkat:
& $cli upload --fqbn esp32:esp32:esp32 --port $nodePort --input-dir .\field_node\.build-isolated .\field_node
```

Tidak ada erase-all, erase-partition, atau upload yang dijalankan pada checkpoint
ini. Update partition table bukan operasi tanpa risiko: source data dan filesystem
harus ditangani dulu meskipun offsets application/default NVS tidak berubah.

## Uji perangkat setelah provisioning disetujui

1. Serial115200, GETstatus ready/mobile_tx_enabled=false. Submit SOS fixture valid,
   amati202 dan pending_sos bertambah1. Simpan payload persis sama.
2. Reset biasa lalu retry:200 duplicate=true, pending tetap1.
3. Putus daya setelah202, nyalakan, retry:200duplicate. Catat ID/count/log.
4. Kirim7SOS ID lain; SOSke9→503queue_full. Retry ID lama tetap200. Jalankan
   full-queue terakhir pada board demo karena2B belum drain.
5. Fault missing/init/storage-full/CRC/version/node-mismatch diuji di host dahulu.
   Fault injection flash hanya pada board disposable yang telah dibackup, memakai
   image staging; jangan merusak partisi board operasional. Setiap fault harus
   degraded/503 dan image journal sesudahnya tidak hilang karena autoerase.
6. Simulasi default recovery: pada board uji terpisah dengan snapshot rn_sos,
   fault-inject default NVS dari image uji, boot, lalu bandingkan rn_sos/readback
   dan retrySOS. Tidak memberikan perintah destructive otomatis untuk board utama.
7. Ulangi portal/submit/sos/tombol/GPS/OLED/legacyRF/HOP sesuai18test2B. Uji latency
   commit, free_heap idle/full, dan power interruption saat put/commit/readback.

## Hasil dan penutupan gate

Hasil otomatis:

- **PASS1024 assertions** C++ host, termasuk seluruh suite2B dan10.000 mutasi JSON;
  partisi missing/init errors NO_FREE_PAGES/NEW_VERSION_FOUND/error umum memberi503,
  tidak melakukan write/erase; success/newSOS/readback/fullqueue/reboot/dedupe diuji.
- **PASS8 golden vectors** C++/JavaScript canonical/SHA256.
- **PASS21 fungsi legacy + HTML portal identik** terhadap baseline Git.
- **PASS storage-layout validator**: bound4MB/alignment/no-overlap, default-NVS
  first, OTA/apps/coredump preserved, shrinkSPIFFS tepat32KiB, kandidat belum aktif,
  explicit partition dan tidak ada aplikasi erase/fallback.
- **PASS tool gen_esp32part core3.3.3** CSV→binary dengan --flash-size4MB dan
  binary→CSV file roundtrip. Output ke stdout pada tool Windows ini menampilkan
  tabel lalu error closed-file; roundtrip dengan output-file berhasil exit0.
- No serial port terdaftar; tidak ada hardware flash/read/erase yang dilakukan.

Host NVS adalah stub dengan dua map partisi terpisah; ini menguji pemilihan partisi
dan alur gagal/pulih, **bukan bukti NVS real tahan power loss**. API post/status
tidak diubah: hasil queue503 dipetakan ke accepted=false/error storage_unavailable;
pengujian HTTP perangkat tetap diperlukan.

Jalankan ulang setelah compile host sesuai panduan2B:

```powershell
& .\field_node\tests\.build\mobile_host_test.exe
node field_node/tests/check_vectors_and_legacy.cjs
node field_node/tests/check_storage_isolation.cjs
```

Build final **PASS, CLI exit0**, 2026-09-19, `esp32:esp32:esp32`, core3.3.3,
ArduinoJson6.21.5/LoRa0.8.0/XPowersLib0.3.3/U8g22.36.19:

| Ukuran | 2B | 2B.1 | Dampak |
| --- | ---: | ---: | ---: |
| Program flash (slot0x140000) | 1.037.671byte | **1.037.767byte (79%)** | +96byte |
| Static RAM | 69.260byte | **69.260byte (21%)** | sama |
| Sisa RAM compiler | 258.420byte | 258.420byte | bukan pengukuran runtime heap |
| Partisi SOS | default NVS | kandidat rn_sos32KiB | SPIFFS kandidat berkurang32KiB |

Binary compile verifikasi masih memakai layout default yang ada, tanpa rn_sos;
jangan upload sebagai deployment. Kandidat partisi diuji generator secara terpisah,
belum dipasang ke sketch/partitions.csv. Setelah layout perangkat direview, build
ulang dengan tabel yang disetujui lalu verifikasi binary tabelnya sebelum upload.
Tidak ada klaim hardware sudah lulus.
Gate membutuhkan layout aktual/flash-size dan uji reboot/power-cycle fisik; sampai
bukti itu tersedia, status tetap terbuka. Checkpoint2C belum dimulai.

## Checklist laporan 18 poin

| No | Hasil |
| --- | --- |
| 1 | Root cause dikonfirmasi pada source core terpasang sebelum setup |
| 2 | Before/after kandidat exact di tabel; before hardware belum tersedia |
| 3 | MobileJournal.h; stub Preferences/nvs_flash; host test; check_storage_isolation.cjs; kandidat CSV; dokumen2B/2B.1/protokol |
| 4 | Partition rn_sos; namespace tetap rn_mobile_b1 |
| 5 | nvs_flash_init_partition eksplisit, error langsung false |
| 6 | Preferences.begin argumen ketiga rn_sos, diverifikasi source3.3.3 |
| 7 | Missing/init/open failure → degraded dan503, tidak false202 |
| 8 | CRC/version/node/size/readback/full storage fail closed; queue8 full503 |
| 9 | Tidak ada erase aplikasi/recovery SOS; core default erase tetap di partisi sistem pertama |
| 10 | Write+commit → readback/version/size/CRC/bytes/SHA → queue →202 |
| 11 | Tidak ada perubahan schema status; ready/degraded sudah tersedia, mobile_tx_enabled=false |
| 12 | Build pinned ESP32 Dev Module; hasil dicatat di bagian hasil |
| 13 | Flash/RAM hasil compiler; rn_sos kandidat32KiB dan SPIFFS berkurang32KiB |
| 14 | Host2B + dedicated-init/missing/failure/default-recovery/restore/dedupe/full/legacy + validator layout |
| 15 | Flash-id/table aktual, NVS real power-cycle/init/full/brownout, HTTP perangkat dan RF belum diuji |
| 16 | Backup flash2kali/hash, review filesystem, migrasi journal lama sebelum boot upgrade |
| 17 | Perintah read-only sekarang; flash hanya setelah layout/migrasi direview, prosedur di atas |
| 18 | Gate belum dapat ditutup: layout fisik T-Beam belum direview, hardware test belum dilakukan |
