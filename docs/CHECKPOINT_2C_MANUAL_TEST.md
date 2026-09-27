# RescueNet Checkpoint 2C — manual one-Field/one-Gateway/Pi test

**Gate:** Do not upload until the final progress report explicitly says both firmware builds PASS, generated partition tables were decoded, and `rn_sos` stayed at `0x3e8000/0x8000`. Codex has not flashed either board. You perform all physical steps. Keep both LoRa antennas attached whenever powered. The 2C firmware exceeds this board profile's hard-coded 1.25 MiB size limit, although the verified custom OTA slots are 0x1a0000 bytes. Use the exact Arduino CLI compile/upload commands below; ordinary Arduino IDE Verify/Upload would reject the firmware on size metadata alone.

Software gate recorded 2026-09-21: Field **PASS, 1,565,867/1,703,936 bytes**; Gateway **PASS, 1,463,115/1,703,936 bytes**; both generated partition binaries decoded and matched their CSV; `rn_sos` unchanged; Field host **1,134 assertions PASS**, backend **41 tests PASS**. This is not a claim that radio joins or physical ACK delivery have passed. Confirm the Gateway has 4 MB physical flash before upload.

Hardware/IDE: T-Beam V1.2 AXP2101/SX1276; Arduino IDE board **TTGO LoRa32-OLED**, Revision **V1 (No TFCard)**, ESP32 core **3.3.3**, `Erase All Flash Before Sketch Upload = Disabled`. Field USB port was COM17 at the last test, but re-check the current port. Install/pin LoRaMesher 1.0.0 (commit `31561e0c3b31f2af332ec339a728ed977cf65e37`), RadioLib 7.1.2, XPowersLib 0.3.3, ArduinoJson 6.21.5, U8g2 2.36.19. The Sandeep LoRa library may remain installed but **must not be included** by the 2C sketches. Review `CHECKPOINT_2C_WIRE.md` before interpreting serial records. Field's app0 remains at `0x10000`, `rn_sos` remains at `0x3e8000/0x8000`, and the previously erased/unused SPIFFS is relocated/shrunk. Do not use this 2C layout if you later stored files in old SPIFFS.

## A–D. Prepare Raspberry Pi, Mosquitto, backend, serial bridge

On the laptop, copy only changed server source to `raspi22@10.10.10.22:~/rescuenet-server-v2/`; do **not** replace the Pi's `rescuenet.db`, `.venv`, or configuration containing local credentials. If the Pi Ethernet IP changed, use `hostname -I` on Pi. From PowerShell in `D:\RescueNET`:

```powershell
scp .\Resquenet-server\config.py raspi22@10.10.10.22:~/rescuenet-server-v2/
scp .\Resquenet-server\services\mobile_wire.py .\Resquenet-server\services\serial_bridge.py .\Resquenet-server\services\mqtt_service.py .\Resquenet-server\services\database.py raspi22@10.10.10.22:~/rescuenet-server-v2/services/
scp .\Resquenet-server\routes\api.py raspi22@10.10.10.22:~/rescuenet-server-v2/routes/
scp .\Resquenet-server\requirements.txt raspi22@10.10.10.22:~/rescuenet-server-v2/
```

On Pi, back up the existing database **without removing it** before starting the new backend:

```bash
cd ~/rescuenet-server-v2
cp -p rescuenet.db "rescuenet.db.pre-2c-$(date +%Y%m%d-%H%M%S)"
source .venv/bin/activate
python -c "import flask, serial, paho.mqtt.client, psutil; print('Dependencies ready')"
# Hanya jika pemeriksaan di atas gagal dan Pi sedang memiliki internet:
# python -m pip install -r requirements.txt
python scripts/init_db.py
sudo systemctl start mosquitto
systemctl is-active mosquitto
mosquitto_sub -h 127.0.0.1 -t 'rescuenet/mobile/#' -v
```

The last command occupies a monitoring terminal. Open a second Pi terminal:

```bash
cd ~/rescuenet-server-v2
source .venv/bin/activate
python app.py
```

Open a third Pi terminal after the Gateway is connected by USB (step G):

```bash
cd ~/rescuenet-server-v2
source .venv/bin/activate
ls -l /dev/serial/by-id/
python -m services.serial_bridge
```

Only one program may own the Gateway serial port at once; close Arduino Serial Monitor before starting the Pi bridge. If Mosquitto is not active, stop and fix that first. Python dependencies are installation-time requirements; RescueNet does not require public internet during the test.

## E–J. Gateway first, then Field, then status

E. On your laptop in PowerShell, compile Gateway with the exact TTGO profile and custom-slot size metadata. Then validate both generated partition binaries. **Only you** run the upload command with the Gateway's actual COM port (replace `COM_GATEWAY`); this is an upload, not a command for Codex to execute:

```powershell
cd D:\RescueNET
$cli = 'C:\Users\LENOVO\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$fqbn = 'esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none'
& $cli compile --fqbn $fqbn --build-property 'upload.maximum_size=1703936' --build-path 'D:\RescueNET-tools\build-gateway-2c' 'D:\RescueNET\gateway_node'
& $cli compile --fqbn $fqbn --build-property 'upload.maximum_size=1703936' --build-path 'D:\RescueNET-tools\build-field-2c' 'D:\RescueNET\field_node'
node field_node/tests/check_generated_partitions.cjs
& $cli upload --fqbn $fqbn --port COM_GATEWAY --input-dir 'D:\RescueNET-tools\build-gateway-2c' 'D:\RescueNET\gateway_node'
```

Do not upload Field sketch to Gateway. Confirm the Gateway has 4 MB flash before this step. The Arduino CLI upload command writes bootloader/partition/otadata/app segments, not `rn_sos`; EraseFlash is disabled.

F. On the Gateway Serial Monitor at 115200, require `[MESH] NETWORK_MANAGER ready address=...` followed by `GATEWAY_READY`. A PMU/ALDO2 failure is a hard stop. Record its mesh address. Close Serial Monitor.

G. Move Gateway USB to Raspberry Pi. Check `ls -l /dev/serial/by-id/` and your user has `dialout` (`groups`). Start the serial bridge in the third Pi terminal. Require `Gateway firmware ready` after any boot/reset. Use the stable `/dev/serial/by-id/...` device if `RESCUENET_SERIAL_PORT` is set.

H. Ensure `NODE_ID=1` and that no other Field uses 1. Use the same `$cli` and `$fqbn` in PowerShell, with the Field's actual port (`COM17` was previously observed). Do this only after the readiness gate at the top of this guide is satisfied. Never use `erase-flash` on this board: it contains pending SOS in `rn_sos`.

```powershell
node field_node/tests/check_generated_partitions.cjs
& $cli upload --fqbn $fqbn --port COM17 --input-dir 'D:\RescueNET-tools\build-field-2c' 'D:\RescueNET\field_node'
```

I. Open Field Serial Monitor at 115200. Require `[MESH] started address=...`, then a synchronized status in `GET /api/status`, and `[MESH] gateway found address=... hops=1` for today's direct link. Gateway should be powered first. Join timing is not a fixed SLA; allow discovery/slot assignment and inspect logs rather than assuming exactly N seconds.

J. Connect a phone/laptop to `RescueNet-Node1`, open `http://192.168.4.1/api/status`. Require `mobile_tx_enabled:true`, `mesh_started:true`, `mesh_synchronized:true`, `gateway_found:true`, `gateway_address` equal to step F, and `pending_sos` readable. `ready` only denotes local readiness, not server delivery.

## K–U. End-to-end LOCATION and SOS

K. Send one location through the existing mobile app HTTP contract (or from a laptop connected to the Field AP). Use a **new request_id** and a current Unix-second timestamp:

```bash
curl -s -H 'Content-Type: application/json' -d '{"request_id":"LOC-2C-001","user_id":"USR-2C-001","name":"Riko Dharmawan","has_gps":true,"lat":-6.364821,"lon":106.828913,"accuracy":6.8,"fix_timestamp":1789551200}' http://192.168.4.1/api/location
```

L. Send SOS without GPS using a different request ID. The returned HTTP202/`queued_for_lora` means accepted **by Field only**:

```bash
curl -s -H 'Content-Type: application/json' -d '{"request_id":"SOS-2C-001","user_id":"USR-2C-001","name":"Riko Dharmawan","sos":true,"has_gps":false,"event_timestamp":1789551230}' http://192.168.4.1/api/sos
```

Run `GET /api/status` immediately: `pending_sos` should increase. Repeat with fresh IDs for further tests; same ID with changed payload must return conflict. If using PowerShell, use `curl.exe` rather than the `curl` alias and quote JSON for PowerShell appropriately. The existing Android app may be used instead; no APK redesign is required.

M. Field Serial Monitor must show `[MOBILE TX] request=<32-hex-key> type=SOS attempt=...`, followed by `queued by mesher; awaiting server STORED ACK`. `Send()` success is **not** a delivery pass.

N–O. Gateway forwards an `RNM1,<key>,<mesh_source>,<hops>,<payload_hex>` line. With Gateway plugged into Pi, watch the serial bridge log for `Mobile event request=...`; don't open a second serial monitor simultaneously.

P. The separate `mosquitto_sub` terminal must show `rescuenet/mobile/events` with the same request key. The legacy topic `rescuenet/reports` remains for portal reports.

Q. Confirm exactly one SQLite row for the key (copy key from Field/bridge logs):

```bash
cd ~/rescuenet-server-v2
sqlite3 rescuenet.db "SELECT request_key,event_type,name,has_gps,lat,lon,delivery_state FROM mobile_events ORDER BY id DESC LIMIT 5;"
curl -s http://127.0.0.1:5000/api/mobile/events?limit=5
```

R. Backend log and MQTT monitor must show `rescuenet/mobile/ack` with `status=STORED` **after** row insertion or existing-row confirmation.

S–T. Bridge writes `RNACK1,<key>,STORED` to Gateway; Gateway logs `[SERVER ACK RX]` and `[MESH ACK TX]`, then Field logs `[SERVER ACK] ... STORED` and `[MOBILE QUEUE] completed ...`.

U. `GET /api/status` now shows `pending_sos` decreased. **Only this full sequence is an end-to-end SOS PASS.** If the Field retries after lost ACK, the SQLite row count for the same `request_key` must remain one, and backend must re-ACK the duplicate.

## V–Z. Persistence, legacy, evidence

V–W. For a new SOS, temporarily keep Gateway/bridge unavailable, submit SOS, verify `pending_sos=1`, then manually reset and later power-cycle Field. It must still show that pending SOS. Restore Gateway/bridge; wait for STORED ACK and verify it drains. Do not erase flash or the `rn_sos` partition. Power-cycle tests are performed **by you**, not Codex.

X. Test portal `GET /`, `POST /submit`, and `GET /sos` from a phone attached to Field AP. A successful page says **entered queue**, not server stored. The Gateway should reconstruct legacy CSV and Pi should show new rows in `reports`; direct mesh route should display legacy `HOP=0`. RSSI/SNR may be `NULL` because LoRaMesher 1.0.0 does not expose packet measurements to the application callback.

Y. Press Field's physical SOS GPIO38 button, check queue/bridge/server `reports` row with `sos=1`. If legacy queue is full, Field must log failure; this portal/physical path is currently best-effort, unlike durable mobile SOS.

Z. Record Field/Gateway firmware build hashes, partition layouts, board/revision, COM ports, Field/Gateway mesh addresses, Pi serial device, each request key, MQTT logs, SQLite query output, pending count before/after, and observed reboot/power-cycle results. Share the logs if a step fails; do not call hardware PASS based on compile alone.
