# RescueNet Live Leaflet Map — Raspberry Pi Deployment

## What this version provides

- OpenStreetMap basemap rendered by Leaflet 1.9.4.
- Latest valid Field Node position per `src_id`.
- Latest valid phone position per persistent `user_key`, including the saved full name.
- A five-second dashboard refresh without resetting the operator's current zoom/pan.
- Field Node, mobile user, optional Gateway, and SOS/critical visual states.
- Distance from a mobile user to the Field Node that received the event.
- Safe empty/error states; the server does not invent coordinates.

The map is near-real-time, not continuous GPS streaming: a marker changes after the
phone/Field Node sends a new coordinate, the Gateway delivers it, and the next
five-second dashboard poll completes.

## Copy the final server folder from Windows

Run in Windows PowerShell. Replace `10.10.10.22` if the Pi currently has another IP:

```powershell
scp -r D:\RescueNET\Resquenet-server raspi22@10.10.10.22:~/rescuenet-server-leaflet
```

This uses a new destination folder and does not overwrite the existing server.

## Prepare and verify on Raspberry Pi

```bash
cd ~/rescuenet-server-leaflet
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/init_db.py
python -m pytest -q
```

Expected automated result for this revision: `42 passed`.

No extra Python or npm package is required for Leaflet. The browser downloads the
Leaflet CSS/JavaScript and map tiles over HTTPS. The browser device therefore needs
working internet and DNS. RescueNet MQTT, SQLite, Serial, and GPS APIs remain local.

## Optional map configuration

The default center is Jakarta. Set a more relevant initial center before starting
Flask if desired:

```bash
export RESCUENET_MAP_DEFAULT_LAT=-6.2000
export RESCUENET_MAP_DEFAULT_LON=106.8167
export RESCUENET_MAP_DEFAULT_ZOOM=15
```

Only configure a Gateway marker when its actual installation coordinate is known:

```bash
export RESCUENET_MAP_GATEWAY_LAT=-6.2000
export RESCUENET_MAP_GATEWAY_LON=106.8167
export RESCUENET_MAP_GATEWAY_LABEL='Gateway Command Center'
```

When those two coordinates are absent, the Gateway marker is intentionally hidden.

## Start the demo

Terminal 1 — Serial Gateway to local MQTT:

```bash
cd ~/rescuenet-server-leaflet
source .venv/bin/activate
python -m services.serial_bridge
```

Terminal 2 — Flask, MQTT consumer, SQLite, dashboard, and map API:

```bash
cd ~/rescuenet-server-leaflet
source .venv/bin/activate
python app.py
```

Open:

```text
http://10.10.10.22:5000
```

Useful checks:

```bash
curl http://127.0.0.1:5000/api/health
curl http://127.0.0.1:5000/api/map/positions
```

The second response should contain `positions`, `links`, and `counts`. A blank
`positions` list means no valid GPS event has reached this database yet; it is not a
map rendering error.

## Live test order

1. Start Mosquitto, the Serial bridge, and Flask.
2. Open the dashboard and select **GPS Map**.
3. Power the Gateway and Field Node.
4. Connect the phone to the Field Node and allow precise browser/app location.
5. Submit or refresh a location event.
6. Wait up to five seconds after the event reaches the server.
7. Confirm the mobile and Field Node markers, popup timestamps, accuracy, and distance.
8. Move outside, send another location update, and confirm the marker moves without a page reload.

Public OpenStreetMap tiles are for normal interactive viewing only. Do not add bulk
download, offline prefetch, or tile scraping against `tile.openstreetmap.org`.
