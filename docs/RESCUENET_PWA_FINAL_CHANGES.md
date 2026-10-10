# RescueNet V2 PWA — Final Source Changes

## Summary and confirmed root causes

- The identity form was selected by `.identity-card`, which also styled/identified the network guide. The source now uses the unique `#identity-card` for the real profile form.
- Each GPS fix previously replaced the pending packet and reset retry attempts. Retry timing was calculated but no dedicated timer owned the deadline, and `finally` immediately re-entered the send routine. This could either starve newer fixes or retry too quickly. A bounded scheduler now owns one pending location, one request in flight, and one retry timer.
- The old connection check treated `mobile_tx_enabled` / mesh readiness as API identity. `/api/status` is now validated separately from transmission readiness; mesh and Gateway fields remain separate UI facts.
- The first PWA was one long page. It now has a five-step first-use flow, four main tabs, and separate map/status/profile functions.
- Repeated SOS events previously had one overwrite-prone local slot. The PWA now retains up to ten local events, displays history, saves before network send, and retries an uncertain event with the same request ID.
- The map selected by client fix time but did not guard a wrong phone clock or malformed legacy row. Dashboard ordering treats timestamps more than five minutes ahead of receipt as untrusted, falls back to server receipt for malformed values, and bounds displayed fix time.

## Files changed in this task

- `Rescuenet-apk/pwa/index.html`, `styles.css`: accessible blue/white mobile layout, onboarding, four-tab UI, map coordinates, status, profile/settings, SOS history.
- `Rescuenet-apk/pwa/app.mjs`: screen/navigation and state recovery, safe local storage writes, connection state, foreground watcher lifecycle, SOS event retention, explicit ACK language.
- `Rescuenet-apk/pwa/core.mjs`: separate API verification/readiness, abortable connection request, truthful browser-network error wording.
- `Rescuenet-apk/pwa/location-scheduler.mjs` (new): latest-fix coalescing, single-flight transmission, persisted request ID, bounded exponential retry, one timer, stale drop, stop/resume.
- `Rescuenet-apk/pwa/service-worker.js`: cache version bump and scheduler module in the app shell. API requests remain network-only.
- `Rescuenet-apk/pwa/manifest.webmanifest`, `README.md`: brand colors and accurate runtime/deployment limitations.
- `Rescuenet-apk/pwa/tests/core.test.mjs`, `location-scheduler.test.mjs` and `ui-contract.test.mjs`: API, identity/payload, scheduler, static UI and service-worker checks.
- `Resquenet-server/services/map_service.py`, `tests/test_api.py`: future client-time ordering/display guard and a regression test.
- Five final handoff documents in this directory.

## Protocol and integration

No firmware API, JSON packet schema, LoRa wire format, database schema, or server route was changed by this PWA work. The code continues using `GET /api/status`, `POST /api/location`, and `POST /api/sos`. `202 accepted` is reported only as Field Node acceptance; the PWA does not claim Gateway, server commit, or responder receipt.

The working tree already contained unrelated/uncommitted firmware, gateway, server, and documentation edits before this task. They were preserved. `routes/api.py` already contained the `config` import and Gateway staleness handling that address the previously observed `/api/health` `NameError`; that pre-existing local edit was reviewed but not rewritten here.

## Deliberate limits

Local SOS persistence uses browser storage as a best-effort journal, with a cap and visible failure handling. It is not durable like the ESP32 NVS queue. When offline, the user can create a local SOS record but it is not described as sent; retry needs a reachable node. PWA background GPS and HTTPS-to-HTTP local Wi-Fi access cannot be guaranteed by JavaScript changes alone.
