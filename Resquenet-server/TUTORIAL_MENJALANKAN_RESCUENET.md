# Tutorial Menjalankan RescueNet di Raspberry Pi

Dokumen ini berisi urutan lengkap untuk menyalakan RescueNet secara manual dari
terminal Raspberry Pi. Perintah disesuaikan dengan instalasi berikut:

- user Raspberry Pi: `raspi22`
- folder proyek: `~/rescuenet-server-v2`
- IP Ethernet Raspberry Pi: `10.10.10.22`
- IP Ethernet laptop operator: `10.10.10.1`
- port dashboard: `5000`
- Gateway T-Beam: USB Serial `115200` baud
- alamat MQTT lokal: `127.0.0.1:1883`

RescueNet tidak membutuhkan internet saat digunakan. Internet hanya diperlukan
ketika pertama kali memasang paket atau ketika memperbarui kode/dependency.

## 1. Alur sistem

```text
Field Node -> LoRa -> T-Beam Gateway -> USB -> Raspberry Pi
                                               |
                                               v
                               Serial Bridge -> Mosquitto MQTT
                                                       |
                                                       v
                                      Flask -> SQLite -> Dashboard
                                                       |
                                                       v
                                           Ethernet -> Laptop
```

Ada dua program RescueNet yang harus tetap berjalan:

1. `python app.py` untuk database, MQTT subscriber, API, dan dashboard.
2. `python -m services.serial_bridge` untuk membaca Gateway melalui USB.

Mosquitto berjalan sebagai service Linux di latar belakang.

## 2. Persiapan sekali saja

Bagian ini tidak perlu diulang setiap demo apabila sebelumnya sudah berhasil.

### 2.1 Masuk ke folder proyek

```bash
cd ~/rescuenet-server-v2
ls
```

Folder yang benar akan menampilkan antara lain `app.py`, `config.py`,
`requirements.txt`, `routes`, `services`, `static`, dan `templates`.

### 2.2 Memasang paket sistem

Langkah ini memerlukan internet dan hanya dilakukan saat instalasi awal:

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip mosquitto mosquitto-clients sqlite3
```

### 2.3 Membuat virtual environment dan memasang dependency Python

```bash
cd ~/rescuenet-server-v2
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/init_db.py
```

Tulisan `(.venv)` di awal prompt menandakan virtual environment sudah aktif.
Periksa dependency dengan:

```bash
python -c "import flask, serial, paho.mqtt.client, psutil; print('Semua dependency siap')"
```

Hasil yang benar:

```text
Semua dependency siap
```

### 2.4 Mengaktifkan Mosquitto otomatis saat Pi menyala

```bash
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
systemctl is-active mosquitto
```

Hasil perintah terakhir harus `active`.

### 2.5 Memberikan izin akses USB Serial

```bash
sudo usermod -aG dialout raspi22
```

Setelah menjalankan perintah tersebut, logout lalu login kembali, atau reboot:

```bash
sudo reboot
```

Sesudah masuk kembali, periksa grup user:

```bash
groups
```

Pastikan `dialout` terdapat dalam hasilnya.

## 3. Urutan menyalakan RescueNet untuk demo

Ikuti bagian ini setiap kali RescueNet akan digunakan.

### Langkah 1 — Hubungkan perangkat

1. Hubungkan Raspberry Pi dan laptop menggunakan kabel Ethernet.
2. Hubungkan T-Beam Gateway ke port USB Raspberry Pi.
3. Nyalakan Field Node dan pastikan pengaturan radio sama dengan Gateway.
4. Tutup Arduino Serial Monitor agar tidak ada program lain yang memakai port
   Gateway.

### Langkah 2 — Periksa jaringan Raspberry Pi

Jalankan di terminal Pi:

```bash
ip -4 address show eth0
```

Pastikan terdapat alamat:

```text
10.10.10.22/24
```

Jika ingin melihat seluruh alamat IP Pi:

```bash
hostname -I
```

Di laptop Windows, alamat Ethernet harus `10.10.10.1` dengan subnet mask
`255.255.255.0`. Uji dari Command Prompt laptop:

```powershell
ping 10.10.10.22
```

### Langkah 3 — Periksa Gateway USB

Jalankan di terminal Pi:

```bash
ls -l /dev/serial/by-id/
```

Gateway yang sudah pernah terdeteksi pada sistem ini adalah:

```text
/dev/serial/by-id/usb-1a86_USB_Single_Serial_5887019360-if00
```

Periksa jalur tersebut secara langsung:

```bash
ls -l /dev/serial/by-id/usb-1a86_USB_Single_Serial_5887019360-if00
```

Apabila folder `by-id` tidak ada, gunakan pemeriksaan berikut:

```bash
ls -l /dev/ttyACM* 2>/dev/null
ls -l /dev/ttyUSB* 2>/dev/null
dmesg | tail -n 30
```

### Langkah 4 — Pastikan MQTT aktif

```bash
sudo systemctl start mosquitto
systemctl is-active mosquitto
```

Hasilnya harus `active`. Untuk melihat status lebih lengkap:

```bash
systemctl status mosquitto --no-pager
```

### Langkah 5 — Jalankan server dashboard di Terminal 1

Buka terminal atau sesi SSH pertama, lalu jalankan:

```bash
cd ~/rescuenet-server-v2
source .venv/bin/activate
python app.py
```

Biarkan terminal ini tetap terbuka. Server yang berhasil berjalan akan
menampilkan alamat `0.0.0.0:5000` dan koneksi MQTT.

### Langkah 6 — Jalankan Serial Bridge di Terminal 2

Buka terminal atau sesi SSH kedua, lalu jalankan:

```bash
cd ~/rescuenet-server-v2
source .venv/bin/activate
python -m services.serial_bridge
```

Biarkan terminal ini tetap terbuka. Kondisi yang benar akan menampilkan log
seperti:

```text
Connecting to local MQTT broker 127.0.0.1:1883
Opening serial /dev/serial/by-id/usb-1a86_USB_Single_Serial_5887019360-if00 @ 115200
MQTT connected at 127.0.0.1:1883
```

Jika deteksi otomatis memilih perangkat yang salah, jalankan dengan port
Gateway secara eksplisit:

```bash
python -m services.serial_bridge --port /dev/serial/by-id/usb-1a86_USB_Single_Serial_5887019360-if00
```

Setelah bridge aktif, tekan tombol reset pada T-Beam Gateway satu kali bila
dashboard belum menampilkan `Firmware Ready`.

### Langkah 7 — Buka dashboard dari laptop

Buka browser pada laptop dan kunjungi:

```text
http://10.10.10.22:5000
```

Jangan gunakan `localhost:5000` dari laptop karena `localhost` akan menunjuk ke
laptop, bukan ke Raspberry Pi.

### Langkah 8 — Kirim laporan dari Field Node

1. Tunggu Field Node selesai menyala dan terhubung ke sistem LoRa.
2. Jika ingin menampilkan lokasi, bawa node ke tempat terbuka dan tunggu layar
   menampilkan `GPS:FIX`.
3. Isi laporan atau tekan tombol SOS pada Field Node.
4. Perhatikan Terminal 2. Log harus menunjukkan laporan diterima.
5. Dashboard memperbarui data secara otomatis. Tombol **Refresh** juga dapat
   ditekan untuk memeriksa segera.

Koordinat hanya muncul apabila laporan dikirim setelah GPS mendapatkan fix.
Payload dengan `HAS_GPS=0` dan koordinat `0,0` memang tidak ditampilkan pada
peta.

## 4. Terminal pemantauan tambahan

Bagian ini opsional. Buka Terminal 3 tanpa menghentikan Terminal 1 dan 2.

### Melihat semua pesan MQTT RescueNet

```bash
mosquitto_sub -h localhost -t 'rescuenet/#' -v
```

Untuk keluar dari pemantauan, tekan `Ctrl+C`.

Laporan GPS yang benar akan memuat nilai `lat`, `lon`, dan `has_gps: 1`.

### Memeriksa API dan kesehatan sistem

```bash
curl http://127.0.0.1:5000/api/health
curl http://127.0.0.1:5000/api/system
curl http://127.0.0.1:5000/api/reports
curl http://127.0.0.1:5000/api/nodes
```

Tambahkan `| python -m json.tool` agar JSON lebih mudah dibaca, misalnya:

```bash
curl -s http://127.0.0.1:5000/api/health | python -m json.tool
```

### Melihat proses dan port yang aktif

```bash
ps aux | grep -E 'app.py|serial_bridge' | grep -v grep
ss -ltnp | grep ':5000'
ss -ltnp | grep ':1883'
```

## 5. Cara menghentikan RescueNet

Pada Terminal 2 yang menjalankan Serial Bridge, tekan:

```text
Ctrl+C
```

Pada Terminal 1 yang menjalankan Flask, tekan:

```text
Ctrl+C
```

Mosquitto boleh tetap aktif. Jika memang ingin menghentikannya:

```bash
sudo systemctl stop mosquitto
```

Untuk keluar dari virtual environment:

```bash
deactivate
```

## 6. Troubleshooting cepat

### Error `ModuleNotFoundError: No module named 'flask'`

Virtual environment belum aktif atau dependency belum terpasang:

```bash
cd ~/rescuenet-server-v2
source .venv/bin/activate
pip install -r requirements.txt
```

Perintah `pip install` memerlukan internet jika paket belum tersimpan di Pi.

### MQTT `Connection refused` atau dashboard menunjukkan MQTT terputus

```bash
sudo systemctl restart mosquitto
systemctl status mosquitto --no-pager
mosquitto_sub -h localhost -t 'rescuenet/#' -v
```

### Gateway tidak ditemukan

Cabut dan pasang kembali kabel USB Gateway, lalu jalankan:

```bash
lsusb
ls -l /dev/serial/by-id/ 2>/dev/null
ls -l /dev/ttyACM* 2>/dev/null
dmesg | tail -n 30
```

### Error `Permission denied` pada `/dev/ttyACM0`

```bash
groups
ls -l /dev/ttyACM0
sudo usermod -aG dialout raspi22
```

Jika `dialout` baru ditambahkan, reboot Pi lalu coba kembali.

### Error port serial sedang dipakai

Cari proses yang memakai port:

```bash
sudo fuser -v /dev/ttyACM0
```

Pastikan tidak ada Serial Monitor, program bridge kedua, atau program serial lain
yang sedang berjalan. Satu perangkat serial hanya boleh dibaca oleh satu program.

### Dashboard tidak dapat dibuka dari laptop

Di Pi:

```bash
ip -4 address show eth0
curl http://127.0.0.1:5000/api/health
ss -ltnp | grep ':5000'
```

Di Command Prompt laptop Windows:

```powershell
ipconfig
ping 10.10.10.22
```

Pastikan IP laptop `10.10.10.1/24`, IP Pi `10.10.10.22/24`, dan browser membuka
`http://10.10.10.22:5000`.

### Dashboard terbuka tetapi laporan tidak masuk

1. Pastikan Terminal 1 dan Terminal 2 masih berjalan tanpa error.
2. Jalankan pemantau MQTT:

   ```bash
   mosquitto_sub -h localhost -t 'rescuenet/#' -v
   ```

3. Kirim laporan baru dari Field Node.
4. Cocokkan pengaturan frekuensi, spreading factor, bandwidth, coding rate, sync
   word, dan CRC antara Field Node dan Gateway.

### Peta tidak menampilkan lokasi

1. Letakkan Field Node di luar ruangan dengan antena GPS menghadap langit.
2. Tunggu hingga layar Field Node menunjukkan `GPS:FIX`.
3. Baru kirim laporan setelah fix didapat.
4. Periksa MQTT dan pastikan `has_gps` bernilai `1`, sedangkan `lat` dan `lon`
   bukan nol.

Lokasi yang tampil adalah lokasi Field Node ketika laporan dikirim, bukan pelacak
GPS yang bergerak secara terus-menerus.

## 7. Ringkasan perintah demo

Urutan singkat jika semua persiapan awal sudah selesai:

```bash
# Periksa broker dan Gateway
systemctl is-active mosquitto
ls -l /dev/serial/by-id/

# Terminal 1
cd ~/rescuenet-server-v2
source .venv/bin/activate
python app.py

# Terminal 2
cd ~/rescuenet-server-v2
source .venv/bin/activate
python -m services.serial_bridge

# Terminal 3 (opsional)
mosquitto_sub -h localhost -t 'rescuenet/#' -v
```

Kemudian buka `http://10.10.10.22:5000` pada laptop dan kirim laporan dari
Field Node.
