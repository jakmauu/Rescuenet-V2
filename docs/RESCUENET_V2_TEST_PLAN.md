# RescueNet V2 reliability test plan

This file prepares tests and procedures only. **None of the tests below were executed as part of this source change.** No firmware compile or physical device test was performed.

## Source tests prepared

### Field Node host-source harness (`field_node/tests/mobile_host_test.cpp`)

- RNH1 encode/decode and invalid flags.
- Durable legacy report queue initialization, ordinary/SOS enqueue, SOS selection, in-flight bound, queue-full backpressure, timed retry, restart restore, invalid ACK, valid STORED removal, capacity rejection, and corruption fail-closed behavior.
- Existing mobile journal and wire vectors remain present.

The C++ harness is Windows-host-specific (BCrypt shim). It is not an Arduino firmware build and must be run by the user only after review.

### Python source tests

- `tests/test_serial_parser.py`: ANSI-wrapped heartbeat envelope, parsed fields, and malformed heartbeat rejection.
- `tests/test_reliability_status.py`: duplicate report/mobile events do not advance report activity; heartbeat updates online/stale device state without a report; stale Gateway status is surfaced.
- Existing `test_mobile_wire.py` and server tests cover RNL1/RNM1/RNA1 validation, duplicate re-ACK, and parser cases.

## Manual hardware acceptance sequence

Use one Field Node (Node 2), one Gateway, and the Pi with exactly one process owning the Gateway USB serial port. Never open Arduino Serial Monitor/miniterm at the same time as `services.serial_bridge`.

1. Back up the Pi server folder and SQLite database using the deployment guide. Confirm there are no pending SOS records that must be preserved before firmware work.
2. Compile and review both firmware sketches locally. Do not erase flash. Upload Gateway and Field Node only after reviewing diffs/build results; heartbeat requires both updated sketches.
3. Start Mosquitto, backend, and bridge. Confirm serial bridge reports `GATEWAY_READY`, MQTT connected, and `/api/health` gateway serial ready with a fresh status age.
4. Boot Field Node. Confirm `[LEGACY JOURNAL] ready`, `mesh_started`, and a discovered/synchronized Gateway. Verify an idle `RNH1` produces `/api/nodes` heartbeat state after at most one interval plus mesh delay.
5. Submit one normal captive-portal report. Follow logs by its `RNL1` delivery key: `[LEGACY QUEUED]` -> `[LEGACY TX]` -> Gateway `RNL1` -> bridge parsed/published -> backend inserted -> STORED ACK -> Gateway ACK TX -> Field `[LEGACY STORED]`. Confirm exactly one DB row and pending count decrements only after Field ACK.
6. Replay the same frame/key (or simulate lost ACK). Confirm the backend logs duplicate, returns STORED again, creates no second report, and leaves `last_new_report_at` unchanged.
7. Repeat with SOS while the ordinary queue has entries. SOS should be selected first, with ordinary reports still getting turns after the configured SOS burst.
8. Fill a test outbox to capacity in a controlled lab. Verify a new portal submission receives a truthful failure and existing entries remain intact. Do not fill a real incident node with synthetic reports.
9. Reset the Field Node with an unconfirmed report. Confirm the journal restores it and retries; do not erase flash.
10. Hold the mesh queue at high occupancy / make Gateway unavailable. Confirm `[MESH BACKPRESSURE]`, no retry flood, and backlog stays bounded; restore connectivity and confirm eventual ACK.
11. Disconnect Gateway USB, wait >20 seconds, and confirm `/api/health` reports `stale` or disconnected. Reconnect it and confirm bridge reconnect + fresh `GATEWAY_READY`.
12. Stop/restart Mosquitto in a lab. Confirm MQTT reconnect; retry a report and confirm idempotent storage/re-ACK.
13. On Safari iPhone, verify PWA local HTTP requests, CORS preflight, location permission, and denied-location SOS behavior. This requires same-network conditions and cannot be inferred from server unit tests.

## Latency and reliability measurement

Log monotonic elapsed times on the Field for queue->mesher acceptance and STORED ACK receipt. The server records wall-clock receive/commit time. Do not subtract ESP32 uptime from Raspberry Pi wall clock; their clocks have unrelated origins. For end-to-end wall latency, add a synchronized test-only timestamp or use a single external stopwatch/packet capture. Collect at least 100 messages per scenario and calculate P50/P95/P99, delivery success, retry count, ACK success, max/mean TX queue depth, and recovery time.

Suggested initial lab scenarios: clear line-of-sight and one-hop, moderate obstruction, Gateway/USB interruption, MQTT restart, Field reboot with pending queue, and burst load. Agree operational latency targets only after this baseline; the earlier ~39-minute report delay is a failure baseline, not a promise that the source changes already meet a new target.

## Not executed

- Python tests and C++ host harness: NOT RUN.
- Arduino/PlatformIO/CMake firmware compile: NOT RUN.
- Field/Gateway radio, USB serial, PWA/iPhone, and Pi tests: NOT RUN.
