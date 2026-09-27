# RescueNet Checkpoint 2B — implementasi dan pengujian Field Node

**Catatan 2026-09-20:** bagian build/flash dan status kandidat di dokumen ini
adalah arsip 2B sebelum inspeksi hardware. Untuk source akhir 2B.1 yang sudah
memakai `field_node/partitions.csv`, gunakan
[laporan storage terkini](CHECKPOINT_2B_1_STORAGE.md) dan
[panduan flash/uji manual final](CHECKPOINT_2B_1_MANUAL_TEST.md). Codex belum
melakukan upload; Gate 2B masih terbuka sampai uji hardware manual lulus.
Profil upload final yang diverifikasi adalah **TTGO LoRa32-OLED V1 (No TFCard)**,
FQBN `esp32:esp32:ttgo-lora32`; instruksi ESP32 Dev Module di arsip ini jangan
dipakai untuk upload manual.

**Lanjutan 2B.1:** kode journal kini memakai partisi khusus rn_sos. Laporan di
bawah mencatat hasil historis2B; status terkini, kandidat layout, backup/migrasi
dan gate hardware ada di [CHECKPOINT_2B_1_STORAGE.md](CHECKPOINT_2B_1_STORAGE.md).
Instruksi upload historis di bagian4 tidak berlaku sebelum review layout2B.1.

Ruang lingkup: **HP → HTTP Field Node → antrean mobile lokal**. Berhenti sebelum 2C.
**Gate 2B belum ditutup:** audit akhir core3.3.3 menemukan automatic erase default
NVS sebelum setup pada NO_FREE_PAGES/NEW_VERSION_FOUND. Implementasi/compile/unit
tests lulus, tetapi jaminan fail-closed journal belum terpenuhi pada kondisi ini.
Jangan flash untuk deployment/kejadian nyata sebelum usulan isolasi NVS di bagian10
disetujui dan diverifikasi. Instruksi flash di bawah adalah prosedur teknis/draft,
bukan persetujuan bahwa checkpoint sudah production-safe.
`queued_for_lora` berarti tersimpan di node, **bukan diterima Gateway/Pi/dashboard**.
Pada 2B, `mobile_tx_enabled` selalu `false`: tidak ada encoder/drain mobile LoRa.
Server Pi boleh mati; uji HP → node tidak membutuhkan Pi maupun internet.

## 1. Berkas dan batas perubahan

- `field_node/field_node.ino`: include, tipe server, inisialisasi API, guard JSON404.
- `field_node/MobileModel.h`: model, parser JSON ketat, validasi, normalisasi alias/nama, canonical dedupe.
- `field_node/MobileHttpHeaders.h` / `MobileWebServer.h`: preflight API, buffer tetap, baca cooperative.
- `field_node/MobileQueue.h`: prioritas, coalescing, dedupe, pemulihan SOS.
- `field_node/MobileJournal.h`: SHA256, CRC32, Preferences/NVS.
- `field_node/MobileApi.h`: tiga route, ACK, status, log tanpa nama/koordinat.
- `field_node/sketch.yaml`: profil versi build; `.gitignore`: build/tool sementara.
- `field_node/tests/`: pengujian host, fixture cross-language, stub NVS/crypto khusus host.
- Dokumen ini dan catatan implementasi di `docs/MOBILE_PROTOCOL_V1.md`.

Gateway, APK, Pi/server, dashboard dan protokol/radio/relay legacy tidak diubah pada 2B.
Perubahan lama pengguna di area tersebut tetap dibiarkan.

## 2. Kontrak HTTP yang diterapkan

| Route | Hasil |
| --- | --- |
| `GET /api/status` | 200 JSON marker `rescuenet-field-node`, API1, node_id, device, status, mobile_protocol1, kapasitas/jumlah antrean, mobile_tx_enabled=false |
| `POST /api/location` | Validasi GPS **smartphone**, enqueue/coalesce lokasi |
| `POST /api/sos` | Validasi SOS, simpan durable sebelum ACK; tanpa GPS tetap valid |
| Unknown `/api` atau `/api/*` | 404 JSON, tidak redirect ke HTML |
| Metode salah pada route dikenal | 405 JSON |

Payload canonical lokasi:

```json
{"request_id":"DEMO-LOC-1","user_id":"USR-DEMO","name":"Riko Dharmawan","has_gps":true,"lat":-6.364821,"lon":106.828913,"accuracy":6.8,"fix_timestamp":1789551200}
```

SOS dengan GPS:

```json
{"request_id":"DEMO-SOS-GPS","user_id":"USR-DEMO","name":"Riko Dharmawan","sos":true,"has_gps":true,"lat":-6.364821,"lon":106.828913,"accuracy":6.8,"fix_timestamp":1789551200,"event_timestamp":1789551230}
```

SOS tanpa GPS:

```json
{"request_id":"DEMO-SOS-NOGPS","user_id":"USR-DEMO","name":"Riko Dharmawan","sos":true,"has_gps":false,"event_timestamp":1789551230}
```

Kompatibilitas Fase1: lokasi menerima `timestamp` sebagai fix; SOS menerima
`timestamp` sebagai event dan `gps_timestamp` sebagai fix. Jika alias dan canonical
ada bersama, nilainya wajib sama. Antrean lama APK tidak diubah/dihapus.

Batas: body1024 byte; object datar, tidak ada unknown/duplicate key; ID1–40 ASCII
`[A-Za-z0-9_-]+`; nama UTF8 valid, whitespace dinormalisasi, 2–60 UTF16 code units,
maksimal240 byte decoded. Nama penuh disimpan; `name_truncated` menunjukkan lebih
dari48 byte untuk encoder 2C nanti, belum memotong nama pada HTTP.
Latitude[-90,90], longitude[-180,180], accuracy0..6553.4 atau null;
timestamp integer Unix detik1..4294967295. Bool/string bukan angka, NaN/Infinity
ditolak; koordinat0 valid. SOS has_gps=false harus menghilangkan seluruh field GPS.
Tidak ada fallback GPS onboard untuk mobile. Snapshot SOS lama tidak ditolak oleh umur.

Content-Length wajib untuk POST, Content-Type application/json dengan optional
charset UTF8. Multipart/chunked/content-encoding ditolak. Idempotency-Key optional;
jika dikirim harus sama persis dengan request_id. Header buffer1536 byte, maksimal32
header; deadline header dan body masing-masing2 s. Koneksi API ditutup setelah respons.
Tidak ada wildcard CORS/auth baru.

ACK baru202:

```json
{"service":"rescuenet-field-node","accepted":true,"request_id":"DEMO-SOS-NOGPS","node_id":1,"state":"queued_for_lora","duplicate":false,"name_truncated":false}
```

Retry yang dikenal200 duplicate=true: state `queued_for_lora`, `superseded` untuk
lokasi yang sudah diganti, atau `lora_tx_completed` jika ada catatan completion.
2B sendiri **tidak menghasilkan completion** karena belum mengirim mobile LoRa.
ID sama payload normalisasi berbeda →409 request_conflict, bukan SOS kedua.

| HTTP | Error penting |
| --- | --- |
| 400 | invalid_json, unknown_field, duplicate_field, invalid_request_id/user_id/name/has_gps/sos, invalid_timestamp/latitude/longitude/accuracy/fix_timestamp/event_timestamp, missing_accuracy, unexpected_field/unexpected_gps_fields, location_requires_gps, idempotency_key_mismatch, header/length/timeout errors |
| 404 / 405 | api_not_found / method_not_allowed |
| 409 | request_conflict, stale_location |
| 413 | payload_too_large sebelum alokasi/baca body raksasa |
| 415 | unsupported_media_type/charset/encoding |
| 503 | queue_full, dedupe_full, storage_unavailable, radio_unavailable, digest_unavailable, response_unavailable, identity_exhausted |

429 tidak digunakan: rate scheduler/transmisi mobile baru dibuat di 2C.

## 3. Antrean, dedupe, persistence dan memori

- SOS8 slot durable, FIFO dalam kelas SOS, tidak ditimpa oleh lokasi/SOS lain.
- Lokasi16 slot RAM, satu per user_id. Fix lebih baru mengganti yang belum terkirim;
  ID baru dengan fix lama/sama409. Dedupe ID dicek **sebelum** stale/capacity check.
- Riwayat lokasi64 ID+SHA256 RAM:30menit atau oldest eviction, pending dipin.
  Coalesced ID menjadi superseded selama cache tersedia; tidak survive reboot.
- SOS pending dipin NVS; completed-history32 slot disiapkan untuk dibaca/dedup.
  Penulisan completion/FIFO eviction/release pending adalah pekerjaan 2C.
- `nextPending()` read-only memilih SOS dahulu. Tidak mengubah scheduler radio legacy;
  prioritas antar mobile/legacy saat TX akan ditambahkan pada 2C.
- Journal namespace `rn_mobile_b1`: schema/node marker, s0..s7 pending, d0..d31
  completed. Satu blob/version/size/CRC32 per pending, commit Preferences dan readback
  penuh diverifikasi sebelum202. SHA256 dihitung ulang saat restore.
- Write baru hanya untuk SOS baru dan marker awal; retry SOS dan lokasi tidak write
  flash. Kegagalan write/readback membuat queue fail closed503 sampai reboot/recovery.
  Commit ambigu boleh pulih sebagai request yang sudah dikenal setelah reboot.
- Corrupt/version/size/node mismatch tidak otomatis dihapus. Jangan mengubah NODE_ID,
  layout record/partition/NVS atau erase flash pada node berisi SOS pending tanpa
  rencana backup/migrasi. Journal adalah format lokal ABI-versioned, **bukan paket LoRa**.
  Ini perilaku aplikasi journal, bukan keseluruhan boot core: risiko default-NVS
  erase sebelum setup dibahas pada bagian10 dan masih menghalangi acceptance gate.
- boot_session random64 nonzero setelah WiFi aktif; sequence monoton; pending SOS
  mempertahankan transport identity awal saat reboot. Overflow fail closed; rotasi
  session dan scheduler TX akan diselesaikan di 2C.
- Semua antrean tetap; JSON document1536byte, request1025, response512; buffer header1537.
  Tidak memakai vector/deque dinamis di firmware. Serial awal mencetak static_bytes
  dan free_heap: catat nilai idle dan setelah queue penuh untuk uji hardware.
- Parser menyimpan12 nilai numerik sementara (~104byte stack), memakai strtod
  sesudah pemeriksaan syntax ketat untuk rounding binary64 konsisten. ArduinoJson6
  fast parser sendiri bergeser beberapa ulp pada fixture dan accuracy6553.4.
  Konversi libc dapat memakai temporary heap; input tetap dibatasi1024byte. Stress
  angka dengan banyak digit dan pantau heap di ESP32; tidak mengklaim libc tanpa malloc.
- Tidak ada klaim anti-DoS total: AP terbuka, satu client aktif, legacy WebServer
  tetap memakai parser lamanya. NVS commit sinkron diperlukan untuk durable ACK;
  ukur latency/flash wear di perangkat. Parser HTTP API menggunakan anggota protected
  core3.3.3: jangan upgrade core tanpa compile/stress/regression test ulang.

## 4. Build dan flash Field Node

Versi terkunci di `field_node/sketch.yaml`:
ESP32 by Espressif3.3.3, ArduinoJson6.21.5, LoRa0.8.0, XPowersLib0.3.3,
U8g2 2.36.19. Board compile `esp32:esp32:esp32` (ESP32 Dev Module, ESP32 klasik).
Pin/wiring tetap T-BeamV1.2 AXP2101/SX1276; bukan ESP32S3 atau radio lain.

Arduino IDE:

1. Gunakan board/partition/flash setting yang sebelumnya berhasil untuk T-Beam.
   Build yang diuji memakai ESP32 Dev Module/default partition; cocokkan perangkatmu.
2. Install/pilih library dengan versi di atas. Jangan install ArduinoJson7 untuk sketch ini.
3. Buka `field_node/field_node.ino`; **semua enam header Mobile*.h wajib ada di folder
   field_node yang sama**, bukan hanya menyalin satu .ino.
4. NODE_ID di bagian atas:1 untuk node1,2 untuk node2,3 untuk node3. Jangan mengganti
   ID perangkat yang sudah memiliki journal SOS tanpa migrasi.
5. Verify dulu, pilih port USB **Field Node**, bukan Gateway. Nonaktifkan erase-all-flash;
   jangan mengubah partition. Tutup serial monitor lain sebelum Upload.
6. Upload manual setelah perangkat teridentifikasi, buka Serial Monitor115200.
7. Tunggu AP dan `[MOBILE QUEUE] ready ... 2B queue only`. Jika storage fault, jangan
   erase journal untuk menyembunyikan fault; simpan log dan lakukan recovery/migrasi.

Compile via CLI di root proyek (PATH atau binary bundled Arduino IDE):

```powershell
$cli = 'C:\Users\LENOVO\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
# Menggunakan core/library lokal dengan versi di atas:
& $cli compile --fqbn esp32:esp32:esp32 --build-path .\field_node\.build-2b .\field_node
# Alternatif build profile terkunci; profile dapat mengunduh dependency jika belum cached:
& $cli compile --profile checkpoint_2b .\field_node
# Hanya setelah COM Field Node sudah diketahui, misalnya COM7 (ganti!):
& $cli upload --fqbn esp32:esp32:esp32 --port COM7 --input-dir .\field_node\.build-2b .\field_node
```

Tidak ada perangkat yang di-flash otomatis pada pengerjaan checkpoint ini.

## 5. Demo HP/laptop → node (tanpa Pi)

Hubungkan HP/laptop ke `RescueNet-Node1` (atau NODE_ID yang dipakai), pilih tetap
terhubung meski WiFi tidak ada internet. Matikan auto-switch ke WiFi/cellular/VPN
yang dapat merutekan192.168.4.1 ke jaringan lain. Terminal PowerShell laptop:

```powershell
$baseUrl = 'http://192.168.4.1'
Invoke-RestMethod "$baseUrl/api/status"
$eventTime = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$location = @{
  request_id='DEMO-LOC-1'; user_id='USR-DEMO'; name='Riko Dharmawan'; has_gps=$true
  lat=-6.364821; lon=106.828913; accuracy=6.8; fix_timestamp=$eventTime
} | ConvertTo-Json -Compress
$sosNoGps = @{
  request_id='DEMO-SOS-NOGPS'; user_id='USR-DEMO'; name='Riko Dharmawan'
  sos=$true; has_gps=$false; event_timestamp=$eventTime
} | ConvertTo-Json -Compress
$sosWithGps = @{
  request_id='DEMO-SOS-GPS'; user_id='USR-DEMO'; name='Riko Dharmawan'
  sos=$true; has_gps=$true; lat=-6.364821; lon=106.828913; accuracy=6.8
  fix_timestamp=$eventTime; event_timestamp=$eventTime
} | ConvertTo-Json -Compress
Invoke-RestMethod "$baseUrl/api/location" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($location))
Invoke-RestMethod "$baseUrl/api/sos" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($sosNoGps))
# Retry gunakan string $sosNoGps yang SAMA, jangan regenerate timestamp/request_id:
Invoke-RestMethod "$baseUrl/api/sos" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($sosNoGps))
Invoke-RestMethod "$baseUrl/api/sos" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($sosWithGps))
Invoke-RestMethod "$baseUrl/api/status"
```

Angka koordinat di contoh adalah fixture, bukan hasil GPS nyata. Pengujian APK
harus mengirim hasil GPS HP sendiri. Tidak perlu mengubah server/flash Gateway.
APK Fase1 dapat probe/send karena marker/alias kompatibel; tulisan DELIVERED lama
masih berarti node accepted, belum command center. Perubahan wording APK di 2G.

Linux/macOS curl, cek status dan unknown API:

```bash
curl -i http://192.168.4.1/api/status
curl -i http://192.168.4.1/api/does-not-exist
curl -i http://192.168.4.1/api/sos -H 'Content-Type: application/json' -H 'Idempotency-Key: DEMO-SOS-2' --data-binary '{"request_id":"DEMO-SOS-2","user_id":"USR-DEMO","name":"Riko","sos":true,"has_gps":false,"event_timestamp":1789551230}'
```

Di PowerShell gunakan `curl.exe`, bukan alias `curl`; untuk JSON UTF8 paling aman
perintah Invoke-RestMethod di atas. Retry contoh curl memakai payload persis sama.

## 6. Matriks manual wajib (belum merupakan hasil hardware)

Uji pada node demo, jangan membuat SOS uji bercampur kejadian nyata.
**2B tidak drain SOS: setelah8 ID baru antrean penuh dan reboot tidak mengosongkannya.**
Uji penuh terakhir pada perangkat khusus. Jangan erase accepted SOS untuk melanjutkan demo.

| Test | Langkah / hasil yang harus diamati |
| --- | --- |
| 2B-1 | GET status:200 JSON, marker/API1/node benar, mobile_tx_enabled=false |
| 2B-2 | Lokasi valid:202 queued_for_lora, pending_locations bertambah; coords HP |
| 2B-3 | ID baru lat91:400 invalid_latitude, hitungan tidak berubah |
| 2B-4 | ID baru lon181:400 invalid_longitude, hitungan tidak berubah |
| 2B-5 | JSON terpotong/duplicate keys:400 JSON; status sesudahnya tetap bisa |
| 2B-6 | Content-Length1025+ dengan/tanpa body penuh:413, bukan reboot/HTML |
| 2B-7 | SOSGPS:202; event/fix/coords smartphone dipertahankan, NVS write berhasil |
| 2B-8 | SOSnoGPS tanpa coords/accuracy/fix:202, tidak memakai GPS T-Beam |
| 2B-9 | Retry SOS payload persis sama:200 duplicate=true, satu slot; ubah nama→409 |
| 2B-10 | Same user, ID baru, fix lebih baru:202, tetap satu slot; retry lama superseded; fix lama/sama ID baru409 |
| 2B-11 | Isi16 user lokasi, user17→503; SOS baru tetap202 bila SOSslot tersedia |
| 2B-12 | LAST: isi8 SOS baru, SOS9→503 queue_full/accepted=false; duplicate SOS lama tetap200, tidak tertimpa |
| 2B-13 | Unknown /api path404 JSON; GET /api/sos405 JSON; bukan302/HTML |
| 2B-14 | Browser / tampil portal lama; ordinary unknown path tetap302 menuju portal |
| 2B-15 | Form POST /submit: legacy11-field CSV masih terkirim, GPS onboard/report lama |
| 2B-16 | Browser GET /sos: legacySOS LoRa masih bekerja |
| 2B-17 | Tombol fisikGPIO38: legacySOS+OLED/log masih bekerja |
| 2B-18 | Setelah ACKSOS: power/reboot normal, pending_sos dipulihkan, retry ID sama200duplicate; lokasi RAM hilang |

Catat waktu, firmware/core, status/body HTTP, Serial log, free_heap idle/full,
latency NVS, hasil observed untuk tiap test. Jangan menyatakan lulus sebelum diamati.
Stress tambahan: request parsial terputus/deadline2s tidak enqueue; multipart/gzip/
chunked415; idempotency mismatch400; raw header flood; names Unicode/60units;
zero coords/null accuracy; konflik alias; HTTP retry setelah response hilang.
Pantau GPS, physicalSOS, OLED dan radio saat client API lambat. Uji RF legacy
direct/relay/MAX_HOP dengan Gateway lama; source inspection bukan bukti coverage.
Uji brownout/write interruption dan full-NVS pada board khusus sebelum deployment.

## 7. Pengujian otomatis dan hasil compile

Host Windows membutuhkan compiler C++17 (contoh Zig0.14.1), Node.js, library
ArduinoJson6.21.5. Stub Preferences/mbedTLS ada hanya di tests/stubs, tidak masuk
firmware. NVS commit/power-loss nyata dan koneksi WebServer hardware tidak disimulasikan
sebagai bukti deployment; stub menguji logika CRC/fail-closed/readback/dedupe.

```powershell
# Ganti sesuai instalasi Zig0.14.1 kamu; tool uji jangan ditaruh dalam sketch.
$zig = 'C:\Users\LENOVO\AppData\Local\Temp\rescuenet-checkpoint-2b-tools\zig-x86_64-windows-0.14.1\zig.exe'
$jsonInclude = 'C:\Users\LENOVO\OneDrive\Documents\Arduino\libraries\ArduinoJson\src'
New-Item -ItemType Directory -Force .\field_node\tests\.build | Out-Null
& $zig c++ -std=c++17 -Ifield_node/tests/stubs -I $jsonInclude field_node/tests/mobile_host_test.cpp -lbcrypt -o field_node/tests/.build/mobile_host_test.exe
& .\field_node\tests\.build\mobile_host_test.exe
node field_node/tests/check_vectors_and_legacy.cjs
```

Hasil otomatis pada source akhir:

- Host C++17: **PASS951 assertions**, termasuk10.000 mutasi JSON deterministik.
- Cross-language: **PASS8 fixture canonical+SHA256**, termasuk alias Fase1,
  Unicode, -0, nullaccuracy, batas koordinat/accuracy/timestamp dan precision.
- Regression source: **PASS21 fungsi legacy unchanged + PORTAL_HTML** dibanding
  `git show HEAD:field_node/field_node.ino`. Bukan uji RF/perangkat fisik.
- Actual NvsJournal diuji dengan stub Preferences: CRC/version/partial-record,
  node mismatch, orphan schema, put failure, readback failure; tidak auto erase.
- `sizeof(Message)=416`, `sizeof(MobileQueue)=18144` pada host Windows64.
  Symbol object source akhir ESP32 menunjukkan mobileApi18168byte dan
  MobileWebServer3192byte (termasuk base server legacy). Free_heap runtime
  tetap harus diukur di Serial perangkat.
- `git diff --check` scoped field_node dan dokumen2B bersih; warning LF→CRLF
  dari konfigurasi Git Windows bukan error firmware.

Build hardware-source memakai CLI1.1.1 + core/library pinned di atas:

| Build | Flash | Static RAM | Hasil |
| --- | ---: | ---: | --- |
| Baseline legacy sebelum 2B | 1.011.975 / 1.310.720 byte (77%) | 48.268 / 327.680 byte | PASS |
| Source akhir 2B | 1.037.671 / 1.310.720 byte (79%) | 69.260 / 327.680 byte (21%) | PASS, CLI exit0 |

Sisa RAM pada report compiler bukan free heap setelah WiFi/OLED aktif.
Tambahan static RAM terhadap baseline20.992byte (~20,5KiB), di bawah target48KiB.
Tool compiler host dipindahkan keluar sketch ke cache Temp agar Arduino tidak
memindai/menyalin ribuan file tool sebagai additional files. Build caches tetap
ignored; bukan source yang perlu disalin/upload ke Field Node.
File build, executable dan tool sementara diabaikan Git; yang dibagikan adalah
source dan instruksi reprodusibel. Tool Zig yang dipakai diverifikasi SHA256
terhadap index release resmi, tidak dijadikan dependency firmware.

## 8. Batas yang masih terbuka dan scope 2C

Belum physical-test/flash. AcceptedSOS tidak punya timeout penghapusan, hanya
kapasitas8; server down tidak mengubah batas ini. Location RAM hilang saat reboot
sesuai kontrak. Dedupe finite, AP tanpa autentikasi; tidak menjamin delivery.

2C setelah persetujuan: shared binary codec RNv1, scheduler async dengan airtime/
rate budget dan retries, transport identity/cache, binary RX/flooding relay,
persist completion sebelum release pending, last-sent high-water lokasi, seam
prioritas legacySOS yang tetap menjaga packet/radio lama. Gateway RNM1/serial,
Pi/database/dashboard/APK mengikuti checkpoint masing-masing, **bukan diam-diam
diterapkan pada 2B**.

## 9. Laporan akhir 19 poin Checkpoint 2B

| No | Topik | Ringkasan / rincian |
| --- | --- | --- |
| 1 | Files changed | Hanya field_node + supporting tests/build/docs; daftar bagian1 |
| 2 | API routes | GETstatus, POSTlocation, POSTsos; JSON unknown/method errors |
| 3 | Request schema | Bentuk GPSlocation, GPS-SOS, noGPS-SOS di bagian2 |
| 4 | Fase1 | timestamp/gps_timestamp aliases, ID/payload antrean APK tidak diubah |
| 5 | Validation | Body1024, ID40, UTF16nama60/UTF8byte240, lat/lon/accuracy/time ranges; bagian2 |
| 6 | Queue sizes | SOS8, lokasi16, history64, completed-history32read/prepared |
| 7 | Coalescing | One pending/user, newer replaces, stale/equal409, old retry superseded |
| 8 | Persistence | Preferences rn_mobile_b1, schema/node/version/size/CRC + SHA + readback sebelum ACK |
| 9 | Dedupe | Logical request_id globalL/S, SHA256 canonical full normalized values; pending pinned |
| 10 | ACK | 202baru durable/local, 200known; bukan Gateway/Pi/dashboard ACK |
| 11 | HTTP codes | 200/202,400,404,405,409,413,415,503; tidak ada429rate limiter2B |
| 12 | Memory | Fixed queues/buffers; hostqueue18144; static MCU pada tabelbuild; free_heap fisik belum diukur |
| 13 | Compile | ESP32 Dev Module/core3.3.3; lihat tabelbuild pada bagian7 |
| 14 | Legacy | 21fungsi + portal identik; radio/CSV/relay/HOP tidak diubah; hardware regression pending |
| 15 | Tests performed | 951assertions,10kJSONmutations,8cross-languagevectors,CRC/NVSfault-stubs,regression,diffcheck |
| 16 | Hardware tests | Seluruh18skenario bagian6 dan stress/powerloss/RF masih perlu perangkat |
| 17 | Limitations | Queue only/no mobileTX, SOSslot tidak drain, RAMlocation volatile, finite dedupe, AP terbuka |
| 18 | Flash/test | Versi/header lengkap, board/partition/port tepat, no erase, Serial115200; commands bagian4–5 |
| 19 | Scope2C | Codec+async scheduler+binaryrelay+completion persistence; bagian8; tunggu persetujuan |

## 10. Temuan kritis audit startup — STOP untuk review

Source lokal ESP32 core3.3.3 `cores/esp32/esp32-hal-misc.c` baris294–301:

```cpp
esp_err_t err = nvs_flash_init();
if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
  // find first data/NVS partition (default system NVS)
  // esp_partition_erase_range(partition, 0, partition->size)
  // nvs_flash_init() again
}
```

Ini berjalan **sebelum setup() dan MobileApi.begin()**, di luar NvsJournal kita.
Preferences saat ini membuka default NVS. Jika core melakukan recovery tersebut,
pendingSOS/schema/dedupe dapat hilang sebelum CRC/restore/fail-closed kita berjalan.
Namespace berbeda saja tidak memisahkan partisi: rn_mobile_b1 tetap ikut terhapus.
Unit fault injection menguji aplikasi journal, tidak menjalankan boot Arduino core.
Normal reboot/CRC-record handling tetap mempunyai implementasi, tetapi tidak boleh
diklaim menutup risiko penghapusan partisi sebelum setup.

Koreksi terkecil yang diusulkan, **belum diterapkan**:

1. Partisi data/NVS tersendiri untuk SOS/mobile journal (misalnya rn_sos), terpisah
   dari default nvs yang dikelola startup Arduino/WiFi.
2. Inisialisasi partisi tersebut secara eksplisit; jika gagal return503/degraded,
   **jangan erase/reformat**. Buka Preferences dengan partition label tersebut.
3. Tetap pertahankan schema/version/CRC/readback/dedupe, JSON/ACK/radio/CSV/AP lama.
4. Tambahkan test boot/init partition failure, capacity dan power interruption.
5. Konfirmasi flash-size/partition aktual T-Beam, backup flash, rencana migrasi
   jika sudah ada pending journal. Menambah partition table tidak boleh diam-diam
   menimpa SPIFFS/OTA/data lama. Tidak mengubah core global komputer sebagai jalan pintas.

Ini perubahan implementasi penyimpanan, bukan desain ulang HTTP/LoRa. Namun,
layout flash dan kemungkinan migrasi perlu persetujuan/review target sebelum
diterapkan. Sesuai instruksi STOP saat ditemukan kontradiksi unsafe, implementasi
dihentikan untuk persetujuan koreksi ini. **Jangan mulai 2C.**
