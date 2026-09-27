# Checkpoint 2B.1 — panduan flash dan uji manual Field Node

Status: firmware dikompilasi dengan profil TTGO LoRa32-OLED V1 untuk pengujian manual,
**belum di-upload oleh Codex**. Build final memakai
`esp32:esp32:ttgo-lora32` (default Revision V1 No TFCard; EraseFlash none),
ESP32 Arduino Core 3.3.3. Compile PASS: 1.037.783/1.310.720 byte program (79%)
dan 69.260/294.912 byte RAM statis (23%); angka heap runtime belum diketahui.
Binary partisi hasil build cocok byte-for-byte dengan `partitions.csv`.
Pin dan inisialisasi periferal sketch **tidak diubah dari firmware legacy**:
LoRa RST GPIO23, OLED I2C 21/22, GPS RX34/TX12, dan percobaan PMU AXP2101.
Varian `ttgo-lora32-v1` dalam core menyediakan default berbeda (LoRa RST14,
OLED SDA4/SCL15), tetapi sketch memakai definisi eksplisitnya sendiri. Pengguna
melaporkan firmware awal berfungsi pada papan TTGO LoRa32 V1 yang sama; karena
itu jangan mengganti pin hanya untuk menyamai default varian. Tetap uji boot
PMU/LoRa/OLED/GPS setelah upload manual; keberhasilan compile bukan bukti
periferal fisik berfungsi. Bila suatu periferal tidak pernah berfungsi pada
firmware awal, jangan menganggap masalahnya disebabkan 2B.1.
Gunakan hanya pada Field Node ESP32-D0WDQ6-V3, flash 4 MB, NODE_ID 1 yang
cadangan penuhnya berada di `D:\RescueNET-backups\20260920-180551`. Dua backup
harus tetap ber-hash SHA-256 `DF5195A4FF125BC6B609470F453CAA14E18D4DB130BF86F465D307AACC6A2AB3`.
Jika perangkat/COM/ukuran flash berbeda, berhenti. Semua SOS dalam pengujian ini
hanya antre di node; `mobile_tx_enabled=false`, belum dikirim via LoRa mobile.

## A. Flash manual dengan Arduino IDE

1. Pastikan COM17 masih Field Node TTGO LoRa32 V1 yang sama dengan firmware
   awal yang telah berhasil dipakai (cabut/colok bila perlu), bukan Gateway. Tutup
   Serial Monitor/aplikasi lain yang memakai COM17. Simpan kedua backup di luar
   repository; jangan unggah `.bin` ke GitHub karena mungkin berisi data pribadi.
2. Buka `D:\RescueNET\field_node\field_node.ino` dari Arduino IDE. Enam berkas
   `MobileApi.h`, `MobileHttpHeaders.h`, `MobileJournal.h`, `MobileModel.h`,
   `MobileQueue.h`, `MobileWebServer.h` **dan** `partitions.csv` harus tetap di
   folder `field_node` yang sama. Jangan membuka salinan `.ino` yang terpisah.
3. Pilih **TTGO LoRa32-OLED** (`esp32:esp32:ttgo-lora32`), port **COM17**.
   Pastikan **Tools → Revision** sama dengan build yang tervalidasi: default CLI
   ialah **TTGO LoRa32 V1 (No TFCard)**. Bila Arduino IDE menunjukkan V2/V2.1,
   **berhenti dulu** dan minta build/validasi ulang untuk revisi tersebut.
   Profil ini memakai flash **4 MB**, flash mode DIO, dan default 80 MHz; core
   ESP32 3.3.3; ArduinoJson 6.21.5, LoRa 0.8.0, XPowersLib 0.3.3, U8g2 2.36.19.
   Jangan ubah `NODE_ID=1`, pin, frekuensi 923 MHz atau parameter radio.
   Profil board tidak mengubah pin/periferal eksplisit sketch; bandingkan log
   boot PMU/LoRa/GPS dengan firmware awal setelah upload manual.
4. TTGO LoRa32-OLED memakai tabel partisi bawaan `default` bila tidak ada
   override. Pada core 3.3.3, `field_node/partitions.csv` di folder sketch
   otomatis dipilih **lebih dulu** daripada tabel bawaan saat Verify/Upload.
   Pastikan build dari folder ini, bukan sketch lain.
   **Erase All Flash Before Sketch Upload = Disabled**. Jangan gunakan
   `Erase Flash`, `Burn Bootloader`, atau merged image.
5. Klik **Verify** lebih dulu. Kompilasi harus berhasil (referensi CLI TTGO V1:
   program 1.037.783 byte/79%, RAM statis 69.260 byte/23%). Jika ada error,
   jangan upload. Binary tabel partisi hasil build lokal sudah dicocokkan byte-for-byte
   dengan `partitions.csv`; bila Arduino IDE memakai board/core/sketch berbeda,
   verifikasi ini tidak otomatis berlaku untuk binary baru.
6. Klik **Upload**. Harapkan `Writing at ...` lalu `Hash of data verified` dan
   `Hard resetting via RTS pin...` (teks akhir dapat berbeda menurut IDE).
   Jika upload gagal, **jangan** memilih opsi erase untuk memperbaikinya.
7. Buka Serial Monitor **115200 baud**; tekan RESET sekali jika boot log terlewat.
   Simpan keluaran boot. Jangan melakukan uji SOS sebelum status siap.

## B. Boot dan koneksi

Log nyata yang perlu dicari: `RescueNet FIELD NODE`, `NODE ID : 1`,
`[PMU] AXP2101 berhasil.`, `[PMU] ALDO2 / LoRa : ON`,
`[PMU] ALDO3 / GPS  : ON`, `[GPS] NEO-M8N onboard aktif...`,
`[LORA] SX1276 siap.`, `[WIFI] SSID : RescueNet-Node1`,
`[WIFI] IP   : 192.168.4.1`, `[WEB] Captive Portal aktif.`, dan
`[MOBILE QUEUE] ready recovered_sos=0 static_bytes=... free_heap=...; 2B queue only`.
Nilai `recovered_sos` boleh lebih dari nol setelah uji sebelumnya. Jika tertulis
`storage fault`, berhenti, simpan log, **jangan erase rn_sos**. Tidak ada log
literal `[rn_sos]` atau `SOS storage ready`; sinyal yang tersedia ialah log
`[MOBILE QUEUE] ready`, status API `ready`, dan keberhasilan uji persistensi.
`mobile_tx_enabled=false` hanya tampak di JSON status. OLED menampilkan
`RescueNet Node 1`, jumlah TX/RX, dan `GPS:FIX` atau `GPS:NO FIX`; tidak ada
jaminan GPS langsung fix di dalam gedung.

Hubungkan Wi-Fi laptop ke **RescueNet-Node1** (AP terbuka). Saat Windows berkata
**No Internet**, pilih tetap terhubung; matikan VPN/auto-switch jaringan jika
`192.168.4.1` tak terjangkau. Portal: `http://192.168.4.1/`.

## C. API dasar — PowerShell

Jalankan blok ini dalam **satu jendela PowerShell** dan biarkan jendela tetap
terbuka hingga tes reboot/power-cycle; `$sosJson` disimpan untuk retry identik.
`Invoke-NodeApi` menampilkan kode HTTP dan isi JSON termasuk saat server
menjawab 400/409/413/503 (Windows PowerShell 5.1).

```powershell
$baseUrl = 'http://192.168.4.1'
function Invoke-NodeApi([string]$path, [string]$method = 'GET', [string]$json = $null) {
  $parameters = @{ Uri = "$baseUrl$path"; Method = $method; UseBasicParsing = $true; ErrorAction = 'Stop' }
  if ($null -ne $json) {
    $parameters.ContentType = 'application/json; charset=utf-8'
    $parameters.Body = [Text.Encoding]::UTF8.GetBytes($json)
  }
  try {
    $response = Invoke-WebRequest @parameters
    [pscustomobject]@{ HTTP = [int]$response.StatusCode; Body = $response.Content }
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) { throw }
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
    [pscustomobject]@{ HTTP = [int]$response.StatusCode; Body = $body }
  }
}
Invoke-NodeApi '/api/status'
```

Harapan: HTTP 200 JSON `service=rescuenet-field-node`, `api_version=1`,
`node_id=1`, `device=field_node`, `status=ready`, `mobile_protocol=1`,
`mobile_tx_enabled=false`, `pending_sos`, `pending_locations`,
`sos_capacity=8`, `location_capacity=16`. **Tidak ada field `storage` tersendiri**;
`degraded` berarti radio atau queue belum siap. Catat angka awal pending.

Lokasi ini adalah **fixture GPS smartphone**, bukan GPS T-Beam. Gunakan ID unik
setiap percobaan. Timestamp Unix detik dibuat dari waktu laptop.

```powershell
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$locId = 'LOC-' + [guid]::NewGuid().ToString('N')
$locJson = @{ request_id=$locId; user_id='USR-DEMO-2B1'; name='Riko Dharmawan'; has_gps=$true; lat=-6.364821; lon=106.828913; accuracy=6.8; fix_timestamp=$now } | ConvertTo-Json -Compress
Invoke-NodeApi '/api/location' 'POST' $locJson
Invoke-NodeApi '/api/status'
```

Harapan: HTTP 202, `accepted=true`, `state=queued_for_lora`,
`duplicate=false`; `pending_locations` naik satu bila user ini belum punya
lokasi. Log nyata: `[MOBILE LOCATION] accepted request=... pending_sos=...
pending_location=...`.

SOS **tanpa GPS**: jangan menambahkan koordinat/accuracy/fix palsu.

```powershell
$sosId = 'SOS-' + [guid]::NewGuid().ToString('N')
$sosJson = @{ request_id=$sosId; user_id='USR-DEMO-2B1'; name='Riko Dharmawan'; sos=$true; has_gps=$false; event_timestamp=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) } | ConvertTo-Json -Compress
Invoke-NodeApi '/api/sos' 'POST' $sosJson
Invoke-NodeApi '/api/status'
Invoke-NodeApi '/api/sos' 'POST' $sosJson
```

Harapan: kirim pertama HTTP 202, `accepted=true`, `queued_for_lora`,
`pending_sos` naik satu, log `[MOBILE SOS] accepted ...`. Kirim kedua **string
yang sama persis**: HTTP 200, `duplicate=true`, pending tidak naik, log
`[MOBILE SOS] duplicate ...`. HTTP 202 bukan bukti diterima Gateway/Pi.

## D. Reset biasa dan putus daya

Setelah SOS pertama mendapat 202, **jangan ubah `$sosJson`**. Tekan tombol RESET
Field Node sendiri, tunggu boot lengkap, sambungkan lagi Wi-Fi ke AP node, lalu:

```powershell
Invoke-NodeApi '/api/status'
Invoke-NodeApi '/api/sos' 'POST' $sosJson
```

Harapan: boot `[MOBILE QUEUE] ready recovered_sos=...` dengan hitungan tidak
berkurang; retry HTTP 200 `duplicate=true`. Lokasi RAM boleh hilang setelah
reset. Bila `storage fault`/503, hentikan pengujian dan kirim log.

Untuk power-cycle, buat SOS **baru** (butuh satu slot tambahan), pastikan 202,
lalu lepas daya Field Node beberapa detik dan pasang kembali secara manual:

```powershell
$powerId = 'SOS-' + [guid]::NewGuid().ToString('N')
$powerJson = @{ request_id=$powerId; user_id='USR-DEMO-2B1'; name='Riko Dharmawan'; sos=$true; has_gps=$false; event_timestamp=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) } | ConvertTo-Json -Compress
Invoke-NodeApi '/api/sos' 'POST' $powerJson
```

Setelah daya dipasang lagi, boot dan Wi-Fi siap:

```powershell
Invoke-NodeApi '/api/status'
Invoke-NodeApi '/api/sos' 'POST' $powerJson
```

Harapan: pending SOS pulih dan retry HTTP 200 `duplicate=true`. Jangan lanjut
capacity test jika pemulihan gagal.

## E. Coalescing lokasi dan API invalid

Untuk menguji coalescing, pakai **user baru**. Status hanya memperlihatkan
jumlah, bukan isi koordinat; log `coalesced` dan retry ID lama `superseded`
menunjukkan perilaku yang teramati. Nilai lokasi terbaru tidak dapat dibaca
langsung dari endpoint 2B.1.

```powershell
$coUser = 'U-' + [guid]::NewGuid().ToString('N')
$t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$co1 = @{request_id=('LOC-'+[guid]::NewGuid().ToString('N'));user_id=$coUser;name='Riko Dharmawan';has_gps=$true;lat=-6.364821;lon=106.828913;accuracy=6.8;fix_timestamp=$t} | ConvertTo-Json -Compress
$co2 = @{request_id=('LOC-'+[guid]::NewGuid().ToString('N'));user_id=$coUser;name='Riko Dharmawan';has_gps=$true;lat=-6.364822;lon=106.828914;accuracy=6.8;fix_timestamp=($t+1)} | ConvertTo-Json -Compress
$co3 = @{request_id=('LOC-'+[guid]::NewGuid().ToString('N'));user_id=$coUser;name='Riko Dharmawan';has_gps=$true;lat=-6.364823;lon=106.828915;accuracy=6.8;fix_timestamp=($t+2)} | ConvertTo-Json -Compress
Invoke-NodeApi '/api/location' 'POST' $co1
Invoke-NodeApi '/api/location' 'POST' $co2
Invoke-NodeApi '/api/location' 'POST' $co3
Invoke-NodeApi '/api/location' 'POST' $co1
Invoke-NodeApi '/api/status'
```

Harapan: tiga kiriman baru 202, retry lama 200 `duplicate=true` dengan
`state=superseded`; log kedua/ketiga `[MOBILE LOCATION] coalesced` dan jumlah
pending lokasi untuk user ini tetap satu. History lokasi bersifat RAM/terbatas.

Contoh negatif berikut memakai ID baru dan tidak boleh menambah antrean:

```powershell
$badLat = @{request_id=('BAD-'+[guid]::NewGuid().ToString('N'));user_id='USR-DEMO-2B1';name='Riko';has_gps=$true;lat=91;lon=106.8;accuracy=6.8;fix_timestamp=$t} | ConvertTo-Json -Compress
$badLon = @{request_id=('BAD-'+[guid]::NewGuid().ToString('N'));user_id='USR-DEMO-2B1';name='Riko';has_gps=$true;lat=-6.3;lon=181;accuracy=6.8;fix_timestamp=$t} | ConvertTo-Json -Compress
Invoke-NodeApi '/api/location' 'POST' $badLat       # 400 invalid_latitude
Invoke-NodeApi '/api/location' 'POST' $badLon       # 400 invalid_longitude
Invoke-NodeApi '/api/location' 'POST' '{bad json'    # 400 invalid_json
Invoke-NodeApi '/api/not-found'                 # 404 api_not_found
Invoke-NodeApi '/api/sos'                       # 405 method_not_allowed
$conflict = $sosJson | ConvertFrom-Json
$conflict.name = 'Nama Berbeda'
Invoke-NodeApi '/api/sos' 'POST' ($conflict | ConvertTo-Json -Compress) # 409 request_conflict
$oversized = '{"request_id":"' + ('X' * 1100) + '"}'
Invoke-NodeApi '/api/sos' 'POST' $oversized      # 413 payload_too_large
Invoke-NodeApi '/api/status'                    # tetap 200 JSON
```

Jika JSON invalid tetap berstatus 202, atau unknown `/api/*` mengembalikan
redirect HTML, hentikan dan kirim hasilnya. `SOS has_gps=false` yang valid telah
diuji pada bagian C.

## F. Kapasitas SOS — jalankan **terakhir** pada board uji

Queue SOS 2B.1 berisi **8 slot persisten dan tidak dikuras**. Jangan jalankan tes
ini pada node operasional yang masih perlu menerima SOS. Tidak ada prosedur
erase otomatis setelah tes. Gunakan node uji/keadaan yang memang boleh tetap
penuh sampai fase pengurasan disetujui. Jika `pending_sos` sudah 8, lewati tes.

```powershell
$before = (Invoke-RestMethod "$baseUrl/api/status").pending_sos
$capacityIds = @()
for ($i = [int]$before; $i -lt 8; $i++) {
  $id = 'SOS-' + [guid]::NewGuid().ToString('N')
  $body = @{request_id=$id;user_id='USR-CAP-2B1';name='Riko';sos=$true;has_gps=$false;event_timestamp=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())} | ConvertTo-Json -Compress
  $capacityIds += $body
  Invoke-NodeApi '/api/sos' 'POST' $body
}
Invoke-NodeApi '/api/status'
$ninth = @{request_id=('SOS-'+[guid]::NewGuid().ToString('N'));user_id='USR-CAP-2B1';name='Riko';sos=$true;has_gps=$false;event_timestamp=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())} | ConvertTo-Json -Compress
Invoke-NodeApi '/api/sos' 'POST' $ninth
Invoke-NodeApi '/api/sos' 'POST' $sosJson
```

Harapan: hingga penuh, tiap ID baru 202; `pending_sos=8`; ID ke-9 HTTP 503
`accepted=false,error=queue_full`; retry `$sosJson` tetap 200 duplicate=true.
Jika `$sosJson` tidak tersedia (jendela PowerShell baru), simpan salah satu body
yang diterima dari `$capacityIds` sebelum menutup jendela.

## G. Legacy regression

1. Buka `http://192.168.4.1/`: portal HTML lama tampil. Isi dan kirim form
   `/submit`; harapkan halaman `Laporan terkirim` dan log `[LORA TX]` berisi
   legacy CSV 11 field (`PKT_ID,SRC_ID,HOP,MAX_HOP,LAT,LON,HAS_GPS,...`).
2. Tekan tombol SOS pada portal (`GET /sos`): halaman `SOS terkirim!`, log
   `[LORA TX] ... KRITIS,1,1,SOS-TOMBOL-PORTAL`.
3. Tekan tombol fisik GPIO38: log `[SOS] Tombol SOS fisik ditekan!`,
   `[LORA TX] ... SOS-TOMBOL-FISIK`; OLED sempat menampilkan `SOS!`.
4. Catat `[GPS] ...`, OLED `GPS:FIX`/`GPS:NO FIX`; bila fix ada, laporan legacy
   memakai GPS T-Beam. Mobile API tetap memakai koordinat payload HP.
5. Jika Gateway/node relay tersedia, bandingkan paket TX/RX dan HOP di Serial
   masing-masing. Direct HOP0 atau relay HOP1 harus **diamati**, bukan diasumsikan.
   Pengujian ini tidak mengaktifkan mobile LoRa.

## H. Kirim hasil kembali

Isi template berikut. Tempel JSON status, HTTP status/body untuk tes penting,
log boot `[PMU]`, `[GPS]`, `[LORA]`, `[WIFI]`, `[MOBILE QUEUE]`, log
`[MOBILE SOS/LOCATION]`, serta error jika ada. Redaksi nama/lokasi/SSID privat
jika perlu; jangan kirim file backup `.bin`.

```text
FIELD NODE TEST RESULTS — Checkpoint 2B.1
Arduino Verify / Upload: PASS / FAIL / BELUM
Boot PMU / GPS / LoRa / AP / OLED: ...
Boot [MOBILE QUEUE] log + free_heap: ...
GET /api/status (awal): ...
POST /api/location: ...
POST SOS tanpa GPS: ...
Retry SOS identik: ...
Reset — status/recovered_sos/retry: ...
Power-cycle — status/recovered_sos/retry: ...
Location coalescing + superseded: ...
Invalid API (400/404/405/409/413): ...
Queue capacity (opsional/terakhir): ...
Portal /submit, /sos, tombol fisik: ...
Legacy LoRa TX/RX/HOP + GPS/OLED: ...
Runtime free_heap idle/penuh (jika ada): ...
Error dan potongan Serial log: ...
```

Gate 2B tetap terbuka sampai hasil perangkat, terutama persistensi setelah
putus daya dan legacy regression, benar-benar dicatat dan diperiksa.
