# Kontrak yang diusulkan untuk Fase 2 — BELUM diimplementasikan

## Hasil inspeksi implementasi sekarang

- `field_node/field_node.ino`: AP `RescueNet-Node{NODE_ID}`, IP `192.168.4.1`; portal `/`, POST form `/submit`, GET `/sos`; route tidak dikenal dialihkan ke portal. Lokasi laporan memakai GPS node, bukan GPS HP. GPS onboard ditoleransi sampai 5 menit; aplikasi mobile memakai batas 2 menit untuk GPS HP.
- LoRa CSV legacy berisi 11 field: `PKT_ID,SRC_ID,HOP,MAX_HOP,LAT,LON,HAS_GPS,KONDISI,JUMLAH,SOS,PESAN`. Origin hop=0, relay menambah hop, MAX_HOP=5. ID 16-bit terdiri dari node ID 4-bit dan counter 12-bit; counter berulang/reset saat boot. Cache dedup node 25 ID.
- Radio firmware: 923 MHz, SF9, BW125 kHz, CR4/5, sync word 0xF3, CRC aktif. Jangan diubah untuk menambahkan API mobile.
- `gateway_node/gateway_node.ino`: dedup cache 40 ID, paket pertama yang diterima dipakai; gateway meneruskan CSV asli dengan prefiks RSSI,SNR via serial 115200. Ini bukan ACK ke HP. Hop0 wajar jika paket langsung diterima lebih dulu.
- Backend aktual di workspace bernama `Resquenet-server` (huruf q): app.py/config.py, routes/api.py, services/serial_bridge.py, mqtt_service.py, database.py, template/static dashboard diperiksa. Bridge membaca 13 field dengan split maksimal 12; MQTT lokal meneruskan laporan ke SQLite/API dashboard. Belum ada kontrak identitas pengguna/lokasi mobile.

Tidak ada file tersebut yang diubah oleh Fase 1. Perubahan gateway yang sudah ada di working tree bukan hasil implementasi aplikasi ini.

## HTTP lokal yang diharapkan aplikasi

Base URL `http://192.168.4.1`. JSON UTF-8 dengan Content-Type `application/json`. Tambahan terhadap contoh awal adalah `request_id`, `gps_timestamp` SOS, endpoint status, dan format ACK eksplisit. Ini kontrak usulan untuk firmware berikutnya, bukan klaim API sudah tersedia.

### GET /api/status

```json
{"service":"rescuenet-field-node","api_version":1,"node_id":1}
```

Untuk identifikasi node tanpa akses SSID. Status ini tidak mengonfirmasi jangkauan gateway/command center. Gagal probe tidak mencegah aplikasi mencoba POST.

### POST /api/location

```json
{
  "request_id":"UUID-yang-stabil",
  "user_id":"USR-UUID-profil",
  "name":"Riko Dharmawan",
  "lat":-6.364821,
  "lon":106.828913,
  "accuracy":6.8,
  "has_gps":true,
  "timestamp":1789551200
}
```

`timestamp` adalah waktu fix HP (Unix detik), accuracy meter atau null jika tidak tersedia. Koordinat harus finite dan dalam rentang valid. Field node tidak boleh mengganti koordinat ini dengan GPS onboard.

### POST /api/sos

```json
{
  "request_id":"UUID-SOS-yang-stabil",
  "user_id":"USR-UUID-profil",
  "name":"Riko Dharmawan",
  "has_gps":true,
  "lat":-6.364821,
  "lon":106.828913,
  "accuracy":6.8,
  "sos":true,
  "timestamp":1789551230,
  "gps_timestamp":1789551200
}
```

Tanpa fix valid:

```json
{
  "request_id":"UUID-SOS-yang-stabil",
  "user_id":"USR-UUID-profil",
  "name":"Riko Dharmawan",
  "has_gps":false,
  "sos":true,
  "timestamp":1789551230
}
```

Tidak ada lat/lon/accuracy/gps_timestamp bila has_gps=false. SOS timestamp adalah waktu tombol ditekan; retry mengirim snapshot yang sama, bukan posisi terkini diam-diam.

### Acknowledgement dan idempotensi

Semua POST membawa `Idempotency-Key: <request_id>`. Node perlu memvalidasi payload, panjang nama/ID/body, mengelola batas kapasitas, dan menyimpan deduplikasi request_id sebelum mengakui penerimaan.

```json
{"service":"rescuenet-field-node","accepted":true,"request_id":"UUID-yang-sama"}
```

Balas HTTP 200/202 dengan JSON ini hanya setelah data diterima ke mekanisme pengiriman yang jelas. Request duplikat dengan payload sama mengembalikan ACK yang sama, tanpa LoRa SOS baru. Bila ID sama tetapi body berbeda, tolak; saat kapasitas penuh/radio gagal menerima antrean, jangan kirim accepted=true. Definisikan durasi/ketahanan cache dedup terutama setelah reset; cache ID LoRa legacy saja tidak memenuhi idempotensi UUID HTTP.

Aplikasi menganggap 2xx tanpa body ACK yang valid, HTML portal, JSON rusak, wrong request_id, accepted=false, non-2xx, dan timeout sebagai belum terkonfirmasi. SOS tetap QUEUED. Jangan redirect `/api/*` ke portal; balas JSON error berstatus tepat.

ACK ini hanya berarti **diterima Field Node**, bukan paket sampai gateway, Raspberry Pi, atau petugas. Jaminan end-to-end memerlukan protokol ACK terpisah, dan tidak diimplementasikan sekarang.

## Protokol LoRa berikutnya: keputusan sebelum implementasi

Jangan memasukkan UUID/nama ke CSV legacy secara ambigu atau memotongnya diam-diam. Proposal arah desain: tipe/version eksplisit yang berbeda untuk `legacy report`, `mobile location`, `mobile SOS`, misalnya discriminator biner/versioned envelope untuk paket baru sementara CSV legacy tetap diterima. Tentukan encoding, panjang maksimum, identitas pengguna ringkas yang tidak tabrakan, fragmentasi bila perlu, timestamp, sumber node, TTL/hop, dan dedup tahan reboot. Uji anggaran airtime di SF9/BW125 sebelum menetapkan format final.

Gateway yang sekarang meneruskan CSV memerlukan parser versi baru yang kompatibel; backend bridge juga perlu dapat membedakan versi **sebelum** split legacy. Jangan mengirim paket baru ke pipeline lama dan mengklaim dashboard otomatis mendukungnya.

Backend berikutnya dapat memiliki `user_locations` dengan user_id, name, lat/lon, accuracy, has_gps, src_node, hop, rssi/snr dan received_at, plus endpoint lokasi pengguna. Bedakan waktu fix HP dan received_at server serta risiko jam HP salah. Tampilkan Recently Active/Last Seen, bukan klaim online tanpa heartbeat. Desain final dan implementasi hanya setelah izin Fase 2.

## Urutan pengujian integrasi nanti

1. JSON POST HP diterima node dengan ACK request_id benar, tanpa merusak portal/tombol fisik.
2. Timeout setelah penerimaan dan retry tidak menghasilkan SOS ganda.
3. Paket GPS HP/SOS tanpa GPS melewati LoRa langsung dan relay; verifikasi hop tanpa mengarang jalur relay.
4. Gateway/bridge menerima legacy dan mobile tanpa salah parsing.
5. Database/API/dashboard menampilkan identitas dan posisi HP; non-GPS tetap menjadi SOS.
6. Uji kapasitas, beberapa HP per node, banyak node, restart, kehabisan ruang, clock skew dan kegagalan radio. Jangan mengasumsikan UUID HTTP otomatis menyelesaikan keterbatasan ID LoRa legacy.
