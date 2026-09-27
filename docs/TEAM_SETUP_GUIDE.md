# RescueNet V2 — Panduan untuk Teman Satu Tim

Panduan ini menjelaskan isi repository, cara menyiapkan tool, dan urutan menjalankan
setiap bagian RescueNet. Jalankan perintah dari folder yang sesuai dengan sistem
operasi masing-masing.

## 1. Ambil source code

```bash
git clone https://github.com/jakmauu/Rescuenet-V2.git
cd Rescuenet-V2
```

Jika menggunakan ZIP dari GitHub, ekstrak dahulu lalu masuk ke folder `Rescuenet-V2`.

## 2. Isi repository

- `field_node/`: firmware ESP32 Field Node. Menerima SOS/lokasi dari aplikasi dan
  meneruskannya melalui LoRa mesh.
- `gateway_node/`: firmware ESP32 Gateway. Menerima paket mesh dan meneruskannya
  melalui USB Serial ke Raspberry Pi.
- `Rescuenet-apk/`: source aplikasi React Native/Expo untuk profil pengguna, GPS,
  pelacakan lokasi, dan SOS.
- `Resquenet-server/`: server Flask, penyimpanan SQLite, MQTT lokal, API, dashboard,
  dan peta Leaflet.
- `docs/`: detail format wire, storage, checkpoint, dan pengujian manual.

## 3. Perangkat dan software yang diperlukan

### Hardware

- Dua board ESP32 TTGO LoRa32-OLED V1 (No TFCard): satu Field Node dan satu Gateway.
- Antena LoRa terpasang sebelum board dinyalakan.
- Raspberry Pi dengan Raspberry Pi OS dan kabel USB data untuk Gateway.
- HP Android untuk aplikasi. iOS dapat digunakan untuk pengembangan yang sesuai.
- Koneksi Wi-Fi lokal Field Node dan jaringan/internet untuk setup awal.

### Laptop / firmware

- Arduino IDE 2.x atau Arduino CLI.
- ESP32 Arduino Core 3.3.3.
- Library Arduino yang tercatat di output build: LoRaMesher 1.0.0, RadioLib 7.1.2,
  XPowersLib 0.3.3, U8g2, dan ArduinoJson 6.21.5.
- Board di Arduino IDE: **TTGO LoRa32-OLED**, revision **TTGO LoRa32 V1 (No
  TFCard)**, flash 4 MB. Pastikan `Erase All Flash Before Sketch Upload` tidak aktif.

### Aplikasi HP

- Node.js 22.14 atau lebih baru sesuai konfigurasi aplikasi.
- npm; dependency dipasang dari `package-lock.json` dengan `npm ci`.
- Akun Expo/EAS hanya diperlukan untuk build APK cloud.

### Server Raspberry Pi

- Python 3.10+, `venv`, pip, Mosquitto, dan Mosquitto clients.
- Rincian deployment ada di `Resquenet-server/README.md` dan
  `Resquenet-server/LEAFLET_MAP_DEPLOY.md`.

## 4. Compile firmware dari Windows PowerShell

Arduino IDE dapat menampilkan `Sketch too big` karena profil board membatasi app
menjadi 1,310,720 byte, sedangkan partisi RescueNet menyediakan app slot 1,703,936
byte. Untuk memvalidasi ukuran terhadap partisi yang dipakai, gunakan Arduino CLI
dan set `upload.maximum_size=1703936`.

Sesuaikan lokasi Arduino IDE CLI bila Arduino IDE dipasang di tempat lain:

```powershell
$cli = 'C:\Users\<NAMA_USER>\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$fqbn = 'esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none'
```

Compile Field Node:

```powershell
& $cli compile --fqbn $fqbn --build-property 'upload.maximum_size=1703936' --build-path 'D:\RescueNET-tools\build-field' 'D:\RescueNET\field_node'
```

Compile Gateway:

```powershell
& $cli compile --fqbn $fqbn --build-property 'upload.maximum_size=1703936' --build-path 'D:\RescueNET-tools\build-gateway' 'D:\RescueNET\gateway_node'
```

Ganti `<NAMA_USER>` dan path `D:\RescueNET` sesuai lokasi di laptop. Compile
berhasil bila Arduino CLI selesai tanpa `text section exceeds available space`; hasil
akan menampilkan penggunaan maksimum 1,703,936 byte. Build ini tidak mengunggah
firmware. Sebelum upload manual, pastikan board dan COM port sudah benar. Jangan
aktifkan **Erase All Flash** karena Field Node memakai partisi penyimpanan SOS.

Partition CSV berada di masing-masing folder firmware. Jangan menghapus atau
memindahkan baris `rn_sos` di `field_node/partitions.csv` tanpa validasi migrasi dan
backup hardware yang sesuai.

## 5. Siapkan aplikasi RescueNet

Di PowerShell, dari laptop dengan Node.js terpasang:

```powershell
cd D:\RescueNET\Rescuenet-apk
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
```

Build APK preview menggunakan akun Expo tim:

```powershell
npm.cmd run eas -- login
npm.cmd run build:apk
```

Perintah build mengunggah source aplikasi ke layanan EAS. Jangan memasukkan
credentials personal ke GitHub. Ikuti `Rescuenet-apk/README.md` untuk demo aplikasi,
perizinan GPS, dan tracking background.

## 6. Siapkan server di Raspberry Pi

Contoh asumsi: user Linux `raspi22`, folder clone `~/Rescuenet-V2`, Pi
terhubung internet untuk instalasi dependency dan untuk tile peta.

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip mosquitto mosquitto-clients sqlite3
cd ~/Rescuenet-V2/Resquenet-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/init_db.py
python -m pytest -q
```

Jalankan pada dua terminal Raspberry Pi.

Terminal 1, Gateway Serial ke MQTT:

```bash
cd ~/Rescuenet-V2/Resquenet-server
source .venv/bin/activate
python -m services.serial_bridge
```

Terminal 2, Flask API dan dashboard:

```bash
cd ~/Rescuenet-V2/Resquenet-server
source .venv/bin/activate
python app.py
```

Buka dashboard dari laptop/HP yang dapat mengakses jaringan Pi, misalnya
`http://10.10.10.22:5000`. Koneksi internet pada browser dibutuhkan untuk Leaflet
dan tile OpenStreetMap; pertukaran laporan, MQTT, dan penyimpanan tetap lokal.
Jangan melakukan bulk download atau prefetch tile dari server publik OSM.

## 7. Urutan demo hardware

1. Pastikan antena terpasang dan kedua board menggunakan firmware kompatibel.
2. Nyalakan Gateway lebih dahulu. Serial Monitor 115200 baud harus menampilkan
   `GATEWAY_READY`.
3. Nyalakan Field Node dan tunggu status `gateway found` serta
   `mesh_synchronized:true` pada `/api/status` Field Node.
4. Sambungkan HP ke SSID RescueNet milik Field Node.
5. Berikan izin GPS dan buat SOS atau aktifkan tracking dari aplikasi.
6. Pastikan Gateway menerima event, Raspberry Pi menyimpannya, lalu ACK kembali ke
   Field Node. Cek pending SOS sudah berkurang setelah ACK `STORED`.
7. Buka GPS Map di dashboard dan konfirmasi marker bergerak setelah data lokasi
   terbaru diterima.

Lihat `docs/CHECKPOINT_2C_MANUAL_TEST.md` untuk langkah rinci dan bukti yang perlu
dicatat. Status compile/test tidak sama dengan status hardware end-to-end.

## 8. File yang sengaja tidak disimpan di GitHub

`.gitignore` mengecualikan database runtime/test, virtual environment, `node_modules`,
folder `.expo`, cache Python, hasil build firmware, dan file konfigurasi rahasia.
File `.env.example`, `package-lock.json`, source firmware, source aplikasi, source
server, test, serta panduan tetap disertakan. Database pada laptop atau Raspberry Pi
tidak perlu dibagikan untuk meng-clone proyek; server akan membuat database ketika
inisialisasi.
