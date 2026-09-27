# RescueNet V2

RescueNet is an emergency communication and monitoring capstone project. This
repository contains the Field Node firmware, Gateway firmware, mobile application,
and Raspberry Pi server/dashboard in one project folder.

## Project folders

| Folder | Contents |
| --- | --- |
| `field_node/` | TTGO LoRa32-OLED Field Node firmware, SOS journal, mobile-to-mesh transport, and host tests |
| `gateway_node/` | TTGO LoRa32-OLED Gateway firmware and serial ACK bridge |
| `Rescuenet-apk/` | React Native / Expo Android and iOS application source |
| `Resquenet-server/` | Flask API, SQLite/MQTT services, live Leaflet map dashboard, and server tests |
| `docs/` | Protocol, storage, checkpoint, and manual hardware-test documentation |

Start with [the teammate setup guide](docs/TEAM_SETUP_GUIDE.md). It explains the
architecture, tools, firmware compile commands, application setup, Raspberry Pi
deployment, and the current validation boundary.

## Architecture

```text
RescueNet mobile app
        │ Wi-Fi + HTTP
        v
Field Node ── LoRa mesh ──> Gateway ── USB Serial ──> Raspberry Pi
                                                       ├─ Mosquitto MQTT
                                                       ├─ SQLite
                                                       ├─ Flask REST API
                                                       └─ Dashboard + Leaflet map
```

The server stores incoming reports and mobile events locally. The map gets the
latest received GPS fix for each Field Node and mobile user. Its interactive
OpenStreetMap background requires the browser device to have internet access.

## Firmware profile and build size

Both firmware sketches target `TTGO LoRa32-OLED`, revision `TTGO LoRa32 V1 (No
TFCard)`, using ESP32 Arduino Core 3.3.3. The custom dual-OTA partition table gives
each app slot 1,703,936 bytes. Arduino IDE's ordinary Verify/Upload size metadata
may still assume a 1,310,720-byte app limit, so use the Arduino CLI commands in the
team guide to compile with the validated slot size. Do not enable **Erase All
Flash**.

## Current validation status

- Field Node host tests and Gateway/Field partition layout checks are documented in
  `docs/CHECKPOINT_2C_PROGRESS.md`.
- The server test suite is run with `python -m pytest -q` inside
  `Resquenet-server/`.
- Hardware operation still needs to be validated with the actual two boards and
  Raspberry Pi. Use `docs/CHECKPOINT_2C_MANUAL_TEST.md`; a successful compile alone
  does not prove LoRa discovery or end-to-end ACK delivery.

## Sharing and safety

Do not commit `.env`, passwords, signing keys, live SQLite databases, full-flash
backups, generated builds, or `node_modules`. `.gitignore` excludes the local
runtime/build artifacts while retaining source, tests, package lockfiles, and
documentation. Keep this GitHub repository private if the project should not be
publicly visible.
