# RescueNet V2 PWA — Test Plan and Results

Run from repository root. All commands here are local/source-only and avoid physical devices, firmware builds, production services, and production databases.

## Automated commands/results

| Check | Command | Result |
|---|---|---|
| JavaScript parse | `node --check Rescuenet-apk/pwa/app.mjs` plus `core.mjs` and `location-scheduler.mjs` | PASS |
| PWA unit/static tests | `node --test Rescuenet-apk/pwa/tests/*.test.mjs` | PASS (23 tests/subtests at final run; rerun after any edit) |
| Server API regressions | `$env:PYTHONPATH='Resquenet-server'; python -m pytest Resquenet-server/tests/test_api.py -q` | Covered by full suite below |
| Full server suite | `$env:PYTHONPATH='Resquenet-server'; python -m pytest Resquenet-server/tests -q` | PASS (60 tests at final run; rerun after any edit) |
| Static preview smoke | `$env:PORT='4175'; node Rescuenet-apk/pwa/server.mjs`, then GET `/`, modules, service worker and logo | PASS (HTTP 200 for each resource) |
| iPhone Safari / installed PWA | Manual plan below | REQUIRES IPHONE |
| Field Node / LoRa / Gateway / Raspberry Pi E2E | Manual plan below | REQUIRES HARDWARE |

PWA automated suite result: 23 tests/subtests passed, 0 failed. Server suite result: 60 passed. Syntax checks for app/core/scheduler/service worker/preview server and manifest JSON parsing passed. Local HTTP smoke returned 200 for the shell, JavaScript modules, service worker and logo. `git diff --check` passed; Git emitted only expected LF→CRLF working-copy notices for edited files. The final report should reflect the actual latest command output if files change after this table was written.

## Source scenarios covered

- API identity versus node readiness; degraded status; absent TX flag; offline, timeout, incompatible payload, HTTP error, and accepted-ACK ID match.
- GPS permission denied, packet payload validation, poor/stale coordinates, profile normalization/stable ID, URL origin validation and bounded retry delay.
- Scheduler coalescing while a request is in flight, old ACK not erasing a newer candidate, new GPS fix not resetting retry state, and bounded attempts/no unbounded timer.
- HTML IDs/screens/navigation uniqueness and service worker inclusion of scheduler while API requests remain network-only.
- Dashboard latest mobile fix ordering and far-future phone clock clamp.

## Manual iPhone checklist

1. On iPhone Safari, open the deployed HTTPS URL. Confirm installability and Add to Home Screen; launch the standalone PWA.
2. Clear only the test browser's PWA site data if a fresh-onboarding test is needed. Confirm welcome → profile → Wi-Fi instructions → API check → optional location permission. Edit profile and verify its stable ID remains unchanged.
3. Connect to the real Field Node AP. Test “Periksa koneksi” repeatedly, with node off, then on. Confirm no stale result and distinguish API from mesh/Gateway status.
4. Test location permission granted, denied, and later enabled. Enable consent and sharing, observe one watcher and no updates while hidden/locked; foreground resume should revalidate. Confirm no stale location is sent and Stop disables updates.
5. Test 30/60/120-second stationary choices and movement while monitoring node queue/LoRa airtime. Validate the minimum 60-second app-side spacing and that emergency traffic remains independent.
6. Test SOS with fresh GPS, without GPS, offline, online, timeout/unknown response, retry same ID, and a second SOS while an earlier one is unresolved. Confirm wording never implies Gateway/server/operator receipt based on Field Node ACK.
7. Install shell while online, reopen offline. UI shell may load; API must show unavailable and must not use cached success. Test service-worker update across a version bump without losing local profile.
8. Specifically test the deployment origin (HTTPS) → private HTTP Field Node API on the actual iOS version. Record Safari console/network evidence. If blocked, document as an infrastructure/platform blocker; do not try to bypass browser security.

## Hardware / dashboard end-to-end checklist

1. Capture Field Node serial logs for `/api/status`, accepted POST request ID, queue counts, retries, and stored ACK.
2. Capture Gateway serial logs showing corresponding mobile packet RX and server ACK RX; do not infer radio success from node UI alone.
3. On Raspberry Pi, confirm serial bridge parse/forward log, MQTT event, Flask response, and `mobile_events` row with request key, fix time, received time and source node.
4. Refresh `/api/map/positions` and dashboard. Verify one stable mobile marker updates, accuracy/fix time/receipt time/freshness and source node are correct. Send an older delayed fix and a future-clock test record in an isolated test DB only.
5. Confirm duplicates are idempotent and database event is not duplicated.

These device tests were not run by this local coding task.
