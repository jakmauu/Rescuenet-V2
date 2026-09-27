# RescueNet Raspberry Pi Server

Panduan langkah demi langkah untuk menyalakan sistem dan menjalankan demo tersedia
di [TUTORIAL_MENJALANKAN_RESCUENET.md](TUTORIAL_MENJALANKAN_RESCUENET.md).

RescueNet is an off-grid emergency communication and monitoring system. LILYGO
T-Beam field nodes send reports through LoRa mesh/flooding to a T-Beam Gateway.
The Gateway forwards newline-delimited records over USB Serial to a Raspberry Pi.
The Pi provides ingestion, durable storage, a REST API, and a local command-center
dashboard to an operator laptop over Ethernet. Radio ingestion, storage, and the REST
API remain local; the Leaflet/OpenStreetMap basemap requires internet in the browser
that opens the dashboard.

The application never fabricates reports, node availability, radio metrics, routes,
Gateway state, or system metrics. An empty installation remains empty until real
Gateway data arrives.

## Architecture

```text
Field Node 1 ─┐
Field Node 2 ─┼─ LoRa mesh/flooding ─> T-Beam Gateway
Field Node 3 ─┘                              │
                                            │ USB Serial @ 115200
                                            v
Raspberry Pi 4 (10.10.10.22/24)
  services.serial_bridge ─> local Mosquitto MQTT
                                  │
                                  v
  services.mqtt_service ─> SQLite ─> Flask REST API ─> Dashboard
                                                              │
                                                              │ Ethernet
                                                              v
                                             Operator (10.10.10.1/24)
```

MQTT is an internal Raspberry Pi bus. The Gateway does **not** connect to MQTT
directly, and the serial bridge does not write SQLite directly.

## Project structure

```text
rescuenet-server/
├── app.py
├── config.py
├── requirements.txt
├── README.md
├── .env.example
├── routes/
│   └── api.py
├── services/
│   ├── database.py
│   ├── mqtt_service.py
│   ├── serial_bridge.py
│   └── system_service.py
├── scripts/
│   └── init_db.py
├── templates/
│   └── index.html
├── static/
│   ├── css/style.css
│   ├── js/app.js
│   ├── assets/icons/rescuenet-mark.svg
│   └── vendor/README.md
└── tests/
    ├── test_api.py
    └── test_serial_parser.py
```

## Raspberry Pi requirements and installation

Raspberry Pi 4 with Raspberry Pi OS, Python 3.10 or newer, a T-Beam Gateway
connected by USB, and an Ethernet interface are expected.

```bash
sudo apt update
sudo apt install -y \
  python3-venv \
  python3-pip \
  mosquitto \
  mosquitto-clients \
  sqlite3

cd ~/rescuenet-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/init_db.py
```

The initialization command is idempotent. It creates `rescuenet.db` when absent,
adds missing supported columns/indexes when present, and does not drop existing
tables or reports.

Copy `.env.example` to `.env` only if an external environment loader is used.
The application reads `RESCUENET_*` environment variables directly; it does not
require `python-dotenv`.

## Local Mosquitto

```bash
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
sudo systemctl status mosquitto
```

The default configuration is intentionally addressed through `127.0.0.1:1883`.
Do not add a public listener for this prototype. The topics are:

- `rescuenet/reports` — normalized JSON reports from the serial bridge.
- `rescuenet/status/gateway` — retained, real Gateway/serial state.

Optional local diagnostics:

```bash
mosquitto_sub \
  -h localhost \
  -t 'rescuenet/#' \
  -v
```

## Ethernet configuration

Configure the Pi Ethernet interface as `10.10.10.22/24` and the operator laptop
as `10.10.10.1/24`. On current Raspberry Pi OS releases using NetworkManager, first
find the wired connection name and then assign the address:

```bash
nmcli connection show
sudo nmcli connection modify "Wired connection 1" \
  ipv4.method manual \
  ipv4.addresses 10.10.10.22/24 \
  ipv4.gateway "" \
  ipv4.dns ""
sudo nmcli connection up "Wired connection 1"
ip address show eth0
```

Use the actual connection name shown by `nmcli`. Set the laptop Ethernet address
manually to `10.10.10.1`, netmask `255.255.255.0`; no gateway or DNS is needed for
the isolated link.

## Serial permissions and device discovery

Add the runtime user to the serial-device group:

```bash
sudo usermod -aG dialout $USER
```

Log out and log back in, or reboot, before using the new group membership. Find the
Gateway device with:

```bash
ls -l /dev/serial/by-id/
ls /dev/ttyUSB*
ls /dev/ttyACM*
```

Prefer a stable path such as `/dev/serial/by-id/usb-...`:

```bash
export RESCUENET_SERIAL_PORT=/dev/serial/by-id/usb-YOUR_GATEWAY_ID
```

If the variable is not set, the bridge searches `/dev/serial/by-id/*`, then
`/dev/ttyUSB*`, then `/dev/ttyACM*`.

## Running RescueNet

Terminal 1 — USB Serial to MQTT bridge:

```bash
cd ~/rescuenet-server
source .venv/bin/activate
python -m services.serial_bridge
```

An explicit device can be supplied temporarily with
`python -m services.serial_bridge --port /dev/ttyUSB0`.

Terminal 2 — Flask, MQTT subscriber, database, API, and dashboard:

```bash
cd ~/rescuenet-server
source .venv/bin/activate
python app.py
```

The server binds to `0.0.0.0:5000`, with Flask debug mode and its reloader disabled
so the MQTT subscriber starts only once. Open this URL on the operator laptop:

```text
http://10.10.10.22:5000
```

The RescueNet data path remains local. For the live street-map background, keep an
internet connection active on the device running the browser. If internet is lost,
the locally stored GPS markers continue to refresh but new OpenStreetMap tiles may
not load. Leaflet 1.9.4 is loaded from its official documented CDN URL.

## Gateway Serial protocol

The Gateway firmware uses LoRa at 923 MHz, spreading factor 9, 125 kHz bandwidth,
coding rate 4/5, sync word `0xF3`, and CRC enabled. These settings are firmware
configuration; the Raspberry Pi does not configure the radio.

The field report payload contains 11 logical fields:

```text
PKT_ID,SRC_ID,HOP,MAX_HOP,LAT,LON,HAS_GPS,KONDISI,JUMLAH,SOS,PESAN
```

The Gateway prepends reception RSSI and SNR, producing 13 logical fields:

```text
RSSI,SNR,PKT_ID,SRC_ID,HOP,MAX_HOP,LAT,LON,HAS_GPS,KONDISI,JUMLAH,SOS,PESAN
```

Example:

```text
-72,8.4,4097,1,1,3,-6.2001,106.8167,1,KRITIS,3,1,Butuh bantuan segera
```

`PESAN` is last and may contain commas. The parser splits at most 12 times so the
remaining text stays intact. `GATEWAY_READY`, `[DROP] ...`, and known OLED/PMU/LoRa
firmware lines are logged as status/information and are never published as reports.
Malformed lines are skipped without ending the process. USB disconnects trigger an
automatic retry.

Packet IDs are not permanent identities: the Gateway's 40-entry in-memory duplicate
cache is volatile and node counters can reset. SQLite `reports.id` is authoritative;
there is deliberately no unique constraint on `pkt_id` or `(src_id, pkt_id)`.

## Telemetry semantics

- `lat`/`lon` is received GPS telemetry and is never fabricated by the server. The
  live map shows the newest valid GPS observation per Field Node and mobile identity.
- RSSI/SNR is the final LoRa transmission received by the Gateway (Gateway RX or
  last-hop reception), not guaranteed source-to-Gateway end-to-end signal quality.
- `hop` is a count. The current packet has no full relay history, so the UI never
  invents an exact node-to-node path.
- `recently_active` means a report was seen within the configured threshold (default
  300 seconds). Without firmware heartbeat, it is not proof that a node is online.

## REST API

All endpoints return JSON except `/`, which serves the local dashboard.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/reports` | Newest reports; optional `status`, `sos`, `src_id`, `limit` |
| `GET` | `/api/reports/<id>` | One report by SQLite database ID |
| `PATCH` | `/api/reports/<id>/status` | Set `BARU`, `DITANGANI`, or `SELESAI` |
| `GET` | `/api/nodes` | Real last-report node activity |
| `GET` | `/api/map/positions` | Latest Field Node/mobile positions, freshness, links, and distances |
| `GET` | `/api/stats` | Dashboard counts and latest report |
| `GET` | `/api/activity?hours=6` | Real hourly report buckets (1–168 hours) |
| `GET` | `/api/health` | Flask, SQLite, MQTT, and Gateway state |
| `GET` | `/api/system` | CPU, RAM, disk, temperature, and uptime |

Example status update:

```bash
curl -X PATCH http://10.10.10.22:5000/api/reports/12/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"DITANGANI"}'
```

`limit` is bounded to 1000. Invalid filters, JSON bodies, and statuses receive a
consistent `{"error":"..."}` response with HTTP 400. Unknown records receive 404.

## Database schema and diagnostics

`reports` stores the serial/MQTT report fields plus an autoincrementing database ID,
handling status, and server receive time. `node_status` is updated atomically with
each inserted report. `service_state` records observed MQTT and Gateway status.
SQLite uses short-lived per-operation connections, a busy timeout, WAL mode, and
parameterized values.

```bash
sqlite3 rescuenet.db
```

Useful SQLite commands:

```text
.tables
.schema reports
.schema node_status
.schema service_state
.headers on
.mode column
SELECT * FROM reports ORDER BY id DESC LIMIT 10;
.quit
```

Indexes are created on `reports.received_at`, `status`, `src_id`, and `sos`.

## Tests

Tests use temporary SQLite files and require neither Mosquitto nor a physical
Gateway:

```bash
cd ~/rescuenet-server
source .venv/bin/activate
python -m compileall .
pytest -q
```

`python -m pytest -q` is equivalent and can be used if a host's user-level Python
scripts directory is not present in `PATH`.

The suite covers fixed-field parsing, messages containing commas, firmware log
classification, validation boundaries, API filters/status updates, real health and
system response shapes, repeat packet IDs, static assets, and additive migration
preservation.

## Configuration

Environment variables and defaults are centralized in `config.py`:

| Variable | Default |
| --- | --- |
| `RESCUENET_HOST` | `0.0.0.0` |
| `RESCUENET_PORT` | `5000` |
| `RESCUENET_DATABASE` | `<project>/rescuenet.db` |
| `RESCUENET_MQTT_HOST` | `127.0.0.1` |
| `RESCUENET_MQTT_PORT` | `1883` |
| `RESCUENET_SERIAL_PORT` | automatic discovery |
| `RESCUENET_SERIAL_BAUD` | `115200` |
| `RESCUENET_SERIAL_RECONNECT_SECONDS` | `5` |
| `RESCUENET_NODE_ACTIVE_THRESHOLD_SECONDS` | `300` |
| `RESCUENET_MAP_TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| `RESCUENET_MAP_DEFAULT_LAT` / `RESCUENET_MAP_DEFAULT_LON` | `-6.2` / `106.8167` |
| `RESCUENET_MAP_DEFAULT_ZOOM` | `13` |
| `RESCUENET_MAP_RECENT_SECONDS` | `30` |
| `RESCUENET_MAP_STALE_SECONDS` | `300` |
| `RESCUENET_MAP_GATEWAY_LAT` / `RESCUENET_MAP_GATEWAY_LON` | unset; Gateway marker hidden |
| `RESCUENET_MAP_GATEWAY_LABEL` | `RescueNet Gateway` |
| `RESCUENET_LOG_LEVEL` | `INFO` |

## Troubleshooting

**Gateway device not found** — verify the USB cable carries data, inspect the three
device patterns above, verify `dialout` membership with `groups`, and set the stable
serial path explicitly.

**Permission denied opening serial** — run the `usermod` command, then fully log out
or reboot. Do not run the whole stack as root.

**MQTT shows disconnected** — confirm `systemctl status mosquitto`, then use
`mosquitto_sub -h localhost -t 'rescuenet/#' -v`. Keep the broker address at
`127.0.0.1` unless the architecture is deliberately revised.

**Dashboard opens but has no reports** — this is the safe empty state. Check bridge
logs, subscribe to `rescuenet/#`, and verify Gateway lines match the 13-field
contract. RescueNet never generates startup sample reports.

**GPS markers appear but the basemap is blank** — the local position API is working,
but the browser cannot reach the Leaflet CDN or OpenStreetMap tile server. Check the
browser device's internet/DNS connection and reload. Do not bulk-download or prefetch
tiles from the public OpenStreetMap service.

**Gateway connected but not ready** — USB Serial is open but no `GATEWAY_READY` has
been observed since connection. Inspect firmware OLED/PMU/LoRa messages.

**Database locked** — normally the 10-second busy timeout and WAL mode resolve short
contention. Check for long-running manual SQLite transactions and close them.

**CPU temperature says Not available** — the OS/platform does not expose a supported
temperature sensor. Other system metrics continue to work; no replacement value is
invented.

## Hardware-dependent validation

Automated tests validate software parsing, storage, API behavior, and UI delivery.
Final field validation still requires the target Raspberry Pi and T-Beam Gateway:

1. Stable `/dev/serial/by-id` selection and `dialout` permission after reboot.
2. Real `GATEWAY_READY`, report, malformed-line, USB disconnect, and reconnect flow.
3. Mosquitto reconnect behavior under a broker restart while both processes run.
4. Actual LoRa reception, multi-hop hop counts, Gateway RX RSSI/SNR, and report GPS.
5. Raspberry Pi CPU temperature exposure and wired access from `10.10.10.1`.
6. Presentation-resolution and small-screen visual verification in the target browser.
