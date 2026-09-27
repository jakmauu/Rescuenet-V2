# Checkpoint 2C — progress recovered from interrupted workspace

Status: **software build/partition/test gate PASS; ready for user-controlled manual Gateway -> Field -> Raspberry Pi testing**. No hardware was flashed by Codex. The local files under `D:\RescueNET` are the source of truth. Existing user changes were not reset or discarded.

## Recovered state

Before this continuation, `field_node/field_node.ino` and `gateway_node/gateway_node.ino` had already been modified. The active server is the untracked `Resquenet-server/`, not the deleted legacy `server/` directory. Unrelated pre-existing workspace changes include `Rescuenet-apk/`, the deleted `server/` tree, and earlier 2B/2B.1 docs. Do not restore/delete those as part of 2C.

Prior 2C work had added `field_node/RescueNetWire.h`, `field_node/RescueNetMeshTransport.h`, `gateway_node/RescueNetWire.h`, and `Resquenet-server/services/mobile_wire.py`; it had edited mobile queue/journal/API, serial bridge, MQTT service, database, config, and API routes. It had *not* produced passing builds, new partitions, comprehensive golden tests, or a manual deployment guide. The previous gateway source was copied without modification to `D:\RescueNET-tools\gateway_node_pre2c.ino` before replacement. The prior 2B.1 full-flash backups at `D:\RescueNET-backups\20260920-180551\` remain untouched.

## Dependency and hardware decisions

- LoRaMesher **1.0.0**, Git tag `v1.0.0`, commit `31561e0c3b31f2af332ec339a728ed977cf65e37`, local source `D:\RescueNET-tools\LoRaMesher-v1.0.0`, installed as an Arduino sketchbook library. Upstream 1.x `LoraMesher::Builder`, `PinConfig`, `RadioConfig`, `LoRaMeshProtocolConfig`, `Send`, callback, `GetClosestGateway` APIs were inspected.
- RadioLib **7.1.2** installed. ESP32 Arduino Core **3.3.3** C++ flags include `-std=gnu++2a`. Arduino IDE deployment FQBN: `esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none` (TTGO LoRa32-OLED, V1 No TFCard), even though physical Field hardware is T-Beam V1.2.
- Both radio configurations in current code: SX1276, explicit NSS18/RST23/DIO0 26/DIO1 33/SCK5/MISO19/MOSI27, 923 MHz, SF9, BW125 kHz, CR 4/5, sync `0xF3`, CRC enabled, preamble 8, TX power 17 dBm. Gateway `NETWORK_MANAGER` + `GATEWAY` capability; Field `NODE_ONLY`. DIO1 GPIO33 still needs physical confirmation on this exact board.
- Sandeep `LoRa.h` is no longer included in active firmware. The Field's old direct radio functions are disabled under `#if 0`; no second radio driver runs concurrently.

## Wire, server and ACK state

- `RNM1`: explicit big-endian mobile frame, 16-byte first-half SHA-256 canonical request digest as key, 8-byte user-id digest prefix, second-resolution timestamps, signed coordinate microdegrees, accuracy decimeters, UTF-8 name up to 48 bytes, CRC16-CCITT. Maximum **100** application bytes; actual frame is `52 + name_bytes`.
- `RNL1`: compact portal/physical-SOS report frame, CRC16; condition text (including `BERAT`) is carried verbatim up to 10 bytes and message text is bounded/truncated at a UTF-8 boundary. Maximum 100 application bytes.
- `RNA1`: 23-byte mesh `STORED` ACK frame with 16-byte request key and CRC16. Gateway USB event: `RNM1,<key_hex>,<mesh_source>,<mesh_hops_or_dash>,<payload_hex>`. Pi-to-Gateway ACK: `RNACK1,<key_hex>,STORED` followed by LF. Serial 115200.
- MQTT legacy `rescuenet/reports` remains. Mobile topics are `rescuenet/mobile/events` and `rescuenet/mobile/ack` (QoS1). Active server adds `mobile_events` table, unique `request_key`, `INSERT OR IGNORE` plus existing-row verification, a debug `GET /api/mobile/events`, and ACK publish **only after database commit/duplicate confirmation**. Serial bridge returns ACK through the same USB device.
- Field's SOS stays in the dedicated NVS journal until a matching mesh `RNA1` ACK arrives from the discovered gateway. Completion writes and verifies a durable completed marker before removing one pending SOS slot. On reboot, a committed marker plus still-present SOS is reconciled; no whole-partition erase is used. A persistent `next_sos` cursor restores FIFO after slot reuse across reboot (covered by the passing host test). Location is RAM/coalesced and removed only on matching ACK; newer fixes supersede older ones. Field retries unacked mobile messages after 15 seconds. Gateway rebuilds key-to-source mapping when a retry arrives after reboot.

## Partition and validation state

- The first complete compile reached linking for both sketches but failed **only** the default 0x140000-byte app slot: Field **1,564,927 bytes**, Gateway **1,462,863 bytes**, maximum **1,310,720 bytes**. The 4 MB dual-OTA layout uses 0x1a0000-byte slots with the matching `upload.maximum_size=1703936` CLI override. **Final Field build PASS: 1,565,867 bytes (91%)**; **final Gateway build PASS: 1,463,115 bytes (85%)**. Exact TTGO LoRa32-OLED V1 (No TFCard) FQBN was used for both; `EraseFlash=none`.
- Field 2C layout: `nvs 0x9000/0x5000`, `otadata 0xe000/0x2000`, `app0 0x10000/0x1a0000`, `app1 0x1b0000/0x1a0000`, `spiffs 0x350000/0x98000`, **`rn_sos 0x3e8000/0x8000` unchanged**, `coredump 0x3f0000/0x10000`. The app0 offset, system NVS, otadata, rn_sos, and coredump stay fixed; both OTA slots grow. Previously erased/unused SPIFFS shifts and shrinks. Backup otadata entry has sequence 1 (selecting app0); manual flashing still requires partition-binary review.
- Gateway 2C layout: same dual OTA app slots; `spiffs 0x350000/0xa0000`, `coredump 0x3f0000/0x10000`; no rn_sos on Gateway. **Both generated `.partitions.bin` files decoded by Espressif's `gen_esp32part.exe --flash-size 4MB` and matched the active CSV byte entries via `node field_node/tests/check_generated_partitions.cjs` (PASS).** No overlap; last partition ends at `0x400000`. The original Field backup was read-only inspected; `rn_sos` remains at `0x3e8000/0x8000` and was neither flashed nor erased.
- Final artifact SHA-256: Field app `9C95FE3EB4BBEFF22D539B209067F7438C1BFA9B980E8A4DD22635DB7316CFF3`, Field partition `0D5FA30544EE1B9E727AB1AC6B784D14420339229B56916FEFD4C77B5CA5ABBE`; Gateway app `95977A09C466D042210E195A2A077E0D3CB62B9B6D56D13F6DF0B682A966CD29`, Gateway partition `E1D0C2C121B9BB6218FD8BF1DED42271D1AF87BA586E583FAF1B3BC75C46FAA7`.
- `node field_node/tests/check_storage_isolation.cjs`: **PASS**, including 2C partition bounds, default-first recovery, and no whole-partition erase. `node field_node/tests/check_vectors_and_legacy.cjs`: **PASS**, 8 cross-language vectors and preserved portal/legacy functions. Fresh 2C C++ host build with Zig 0.14.1: **PASS, 1,134 assertions**, including SOS FIFO after reboot/slot reuse, durable DONE marker, ACK failure handling, and wire golden vectors.
- Server pytest: **41 passed** using the separately installed `D:\RescueNET-tools\Python311\python.exe`. This includes mobile wire, DB idempotency, and MQTT/serial/backend ACK roundtrip tests. The original system Python was unusable.

## Files touched in 2C (including recovered interrupted edits)

`field_node/field_node.ino`, `field_node/MobileApi.h`, `field_node/MobileQueue.h`, `field_node/MobileJournal.h`, `field_node/RescueNetMeshTransport.h`, `field_node/RescueNetWire.h`, `field_node/partitions.csv`, `field_node/sketch.yaml`, `field_node/tests/stubs/Preferences.h`, `field_node/tests/mobile_host_test.cpp`, `field_node/tests/check_storage_isolation.cjs`, `field_node/tests/check_generated_partitions.cjs`, `field_node/tests/check_vectors_and_legacy.cjs`, `gateway_node/gateway_node.ino`, `gateway_node/RescueNetWire.h`, `gateway_node/partitions.csv`, `Resquenet-server/config.py`, `Resquenet-server/services/mobile_wire.py`, `Resquenet-server/services/serial_bridge.py`, `Resquenet-server/services/mqtt_service.py`, `Resquenet-server/services/database.py`, `Resquenet-server/routes/api.py`, `Resquenet-server/tests/test_mobile_wire.py`, `docs/CHECKPOINT_2C_WIRE.md`, `docs/CHECKPOINT_2C_MANUAL_TEST.md`, and this checkpoint. Most of these are untracked because the older worktree already used an untracked new server and 2B.1 files.

## Next exact actions

1. **User** confirms Gateway physical flash is 4 MB and both LoRa antennas are attached. Use `CHECKPOINT_2C_MANUAL_TEST.md` to compile/upload with Arduino CLI and the exact TTGO FQBN; plain Arduino IDE Verify/Upload rejects the firmware because the board's hard-coded size metadata is still 1.25 MiB. Never use whole-flash erase.
2. **User** performs manual Gateway -> Field -> Raspberry Pi test and shares serial/MQTT/SQLite/ACK evidence. Verify DIO1 GPIO33 on physical boards and `rn_sos` pending SOS persistence; those are hardware-only checks still open.
3. No dashboard/mobile-app redesign in 2C. Mobile data is available through `/api/mobile/events`; physical end-to-end delivery is not claimed until the user completes the manual guide.

Resume commands (PowerShell from `D:\RescueNET`):

```powershell
$cli = 'C:\Users\LENOVO\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
& $cli compile --fqbn 'esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none' --build-property 'upload.maximum_size=1703936' --build-path 'D:\RescueNET-tools\build-field-2c' 'D:\RescueNET\field_node'
& $cli compile --fqbn 'esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none' --build-property 'upload.maximum_size=1703936' --build-path 'D:\RescueNET-tools\build-gateway-2c' 'D:\RescueNET\gateway_node'
node field_node/tests/check_generated_partitions.cjs
node field_node/tests/check_storage_isolation.cjs
node field_node/tests/check_vectors_and_legacy.cjs
& 'D:\RescueNET\field_node\tests\.build\mobile_host_test.exe'
& 'D:\RescueNET-tools\Python311\python.exe' -m pytest -q Resquenet-server/tests
```

No physical flash, upload, erase, reboot, or power cycle has been performed by Codex. Software is **ready for user-controlled manual upload and hardware test** using the exact CLI commands in `CHECKPOINT_2C_MANUAL_TEST.md`; do not use the ordinary Arduino IDE Upload button with the hard-coded 1.25 MiB limit.
