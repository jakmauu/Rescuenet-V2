# RescueNet incident and location latency check

## Changes in this check

- The dashboard now polls legacy reports (including captive-portal SOS) and PWA SOS independently every 2 seconds. It also shows a short notification when a *new* SOS is committed to the server.
- Map positions now refresh on their own 5-second loop. Slow health, chart, or system-metrics requests no longer block incident lists or GPS markers.
- Field Node mesh scheduling temporarily permits an urgent captive-portal SOS to pass an already in-flight normal report and a slot reserved for PWA location traffic. Mobile SOS still has priority over other application traffic.
- Missing end-to-end ACKs trigger a 15-second retry for SOS; routine reports/locations retain a 60-second retry. Queue-depth backpressure remains active to avoid flooding LoRa with duplicates.

“Stored on server” means the server database committed the request. It does not confirm that a responder has seen or handled it. A successful `mesh->Send()` means the frame was accepted by the local mesh library, not delivered over radio.

## Expected location behavior

The PWA now defaults to a 60-second stationary interval; users may select 30, 60, or 120 seconds. A fresh GPS fix must be available, accuracy must be within the app's limit, and at least 60 seconds must separate sends. The PWA explicitly stops its location watcher while the page is hidden. iOS can suspend a Safari/PWA page in the background, so it cannot promise continuous background GPS delivery. Keep the PWA visible during a live-location test. A genuinely continuous locked-screen/background tracker needs a native iOS app with the appropriate background-location entitlement and user permission.

The map displays only GPS observations committed to the server. The marker's age comes from the phone fix time; the popup also exposes server receipt time. If these differ greatly, investigate radio/mesh delivery. If both are recent in the database but the map is stale, investigate the dashboard/map deployment.

## Trace one SOS end to end

Use the same 32-character `request`/`key` from the serial output where available:

1. Field Node: `[MOBILE SOS] accepted` means HTTPS/API accepted it locally. `[MOBILE TX] ... attempt=...` and `queued by mesher` mean transmission was requested, not delivered.
2. Gateway serial: `[MESH RX]` followed by an `RNM1,<key>,...` line means Gateway received the mesh frame.
3. Raspberry Pi serial-bridge log: `Mobile event ... stage=gateway_serial_ingress ... queued=true` means it parsed the frame and handed it to MQTT.
4. MQTT service log: `Mobile inserted ... stage=database_committed ... ack_queued=true` means the durable server write succeeded. Only now should the dashboard show the record.
5. Gateway serial: `[SERVER ACK RX] request=<key>` and `[MESH ACK TX] request=<key>` mean the server ACK came back through Gateway.
6. Field Node: `[SERVER ACK] key=<key>` followed by `[MOBILE QUEUE] completed request=<key>` means its durable outbox was cleared.

For captive-portal reports, follow Field Node `[LEGACY QUEUED]` / `[LEGACY TX]`, Gateway `[LEGACY RX]` and `RNL1,...`, Pi `Report forwarded to MQTT`, database/`STORED ACK` logs, then Field Node `[LEGACY STORED]`. If an expected stage is absent, the delay is upstream of the next stage. Compare keys before drawing conclusions; the mobile SOS request UUID in the HTTP response is not necessarily the wire's shortened/digested key.

The browser-side 2-second polling only applies while the dashboard is open and its Flask server is reachable. It cannot make a frame arrive sooner over a sleeping, unsynchronized, congested, or disconnected mesh.
