# RescueNet iPhone PWA

Static PWA source for iPhone Safari/Home Screen, separate from the Expo app in `../src/`.

## Current contract

- Field Node origin defaults to `http://192.168.4.1`; its current SSID format is `RescueNet-Node<N>`.
- The PWA verifies `GET /api/status` (`rescuenet-field-node`, API v1, node ID, device, readiness, mobile protocol and TX capability).
- It sends the existing JSON wire contract to `POST /api/location` or `POST /api/sos`, with `Idempotency-Key` equal to `request_id`.
- HTTP 202/accepted is only a Field Node enqueue ACK. Gateway forwarding, server database commit, and responder action are separate stages.
- Live location requires explicit consent and runs in foreground. Rate control is movement/30-second default cadence (selectable 30/60/120), one coalesced pending fix, 2-minute freshness, 250 m accuracy threshold, and up to five total POST attempts (initial plus four retries). SOS is independent and may omit GPS.

## iPhone browser constraints

The PWA needs a trusted HTTPS context for reliable Geolocation API and Add to Home Screen. Field Node currently exposes HTTP on a private Wi-Fi AP. Firmware CORS/preflight support is necessary but does not guarantee Safari permits an HTTPS page to call an HTTP private-network API. Opening the HTTP portal directly is useful for API diagnosis, but is not a supported substitute for a GPS-capable installed PWA. Do not claim background GPS while the PWA is hidden or the screen is locked.

The PWA shell can open offline only after its service worker and assets were installed while reachable. API calls are network-only and do not succeed from cache. A reliable offline HTTPS-to-Field-Node path remains an architecture/device validation blocker; see `../../docs/RESCUENET_PWA_LIVE_LOCATION_ARCHITECTURE.md`.

## Local preview

`npm run pwa:serve` serves the static page on localhost for desktop UI inspection. It does not validate iPhone Safari, the private Wi-Fi API, mesh delivery, or production hosting. This task did not run the preview, tests, build, firmware upload, or deployment.

## Review docs

- `../../docs/RESCUENET_PWA_IPHONE_CHANGES.md`
- `../../docs/RESCUENET_PWA_IPHONE_TEST_PLAN.md`
- `../../docs/RESCUENET_PWA_LIVE_LOCATION_ARCHITECTURE.md`
- `../../docs/RESCUENET_PWA_DEPLOYMENT_GUIDE.md`
