# RescueNet iPhone PWA

Static PWA source for iPhone Safari and Add to Home Screen, separate from the Expo app in `../src/`.

## Current behavior

- First-use onboarding collects a local display name, role, optional team, Wi-Fi guide, API verification, and optional location permission. The stable random `user_id` is retained when the profile is edited; it is not authentication.
- Main navigation has Beranda, Peta, Status, and Profil. The map page displays the latest GPS fix and accuracy without downloading third-party map tiles; an explicit Apple Maps link opens only when the user chooses it.
- Default Field Node API origin is `https://192.168.4.1`. The connection button reads `GET /api/status` without using a cached response. The actual firmware status fields (`service`, `api_version`, `device`, `node_id`, `status`, `mobile_protocol`, and `mobile_tx_enabled`) are checked. A valid API response shows the Field Node as connected even when its radio is temporarily not ready to accept a report.
- Existing payloads go to `POST /api/location` or `POST /api/sos`, using `request_id` as `Idempotency-Key`. Plain HTTP is rejected by the PWA. A Field Node ACK means only that the Field Node accepted the request. A locally saved SOS is shown as waiting to send; an uncertain response is shown as uncertain; a rejected request is shown as failed.
- API identity/readability is shown separately from radio/mobile transmit readiness and mesh/Gateway status. HTTP accepted ACK is only proof the Field Node enqueued a request; Gateway, server storage, and responder action are not confirmed by that ACK.
- Location sharing requires explicit consent, a secure browser context, and one foreground `watchPosition`. Stationary sample interval is selectable (30/60/120 seconds; default 120); the scheduler applies at least 60 seconds between accepted fixes, one pending latest fix, one in-flight request, bounded retry/backoff, and a two-minute freshness limit.
- SOS works without GPS and may be saved locally when the node is offline. Up to ten local events are retained best-effort; retry reuses the same request ID. Browser storage is not equivalent to the Field Node's durable NVS journal.

## iPhone HTTPS setup

The Field Node serves its captive portal on HTTP port 80 and the mobile API on HTTPS port 443. Open/install the PWA once while internet is available. Join the RescueNet AP, follow the captive portal, choose **Without Internet / Tanpa Internet** if iOS offers that choice, close the Wi-Fi sign-in sheet, then return to the installed PWA and tap **Periksa koneksi**. If the check fails, test `https://192.168.4.1/api/status` directly in Safari. HTTPS is provided by ESP-IDF `esp_https_server` in the ESP32 Arduino 3.3.3 package. The leaf certificate and matching private key are embedded into a local, ignored `field_node/tls_secrets.h` before compiling; the root CA is never put on the Field Node. HTTP connectivity-check probes intentionally receive the portal page; they are not told that internet is available.

See [`docs/RESCUENET_LOCAL_HTTPS_SETUP.md`](../../docs/RESCUENET_LOCAL_HTTPS_SETUP.md) for certificate preparation, build, API checks, and iPhone root CA trust steps. The PWA production origin is explicitly CORS-allowed by the Field Node.

## iPhone and offline limitations

Reliable browser geolocation and service workers require HTTPS or another secure context. The PWA app shell must be loaded/installed while internet is available before using the internet-less AP; first loading GitHub Pages cannot work with no internet. The GitHub Pages service worker precaches the HTML, JavaScript modules, CSS, manifest, and icons under the repository path. The home screen renders immediately; the API check runs separately and does not gate app startup. The cache version is `rescuenet-pwa-v9`, and installation refetches the shell files. After a new deployment, open the PWA once while online, then close and reopen it before switching to the RescueNet AP. The GitHub-hosted PWA-to-Field-Node API path uses HTTPS; iPhone Safari must fully trust the local mkcert root CA. Browser fetch errors do not reliably distinguish a lost AP, captive portal state, TLS, and CORS failure, so the UI avoids asserting one cause. An iPhone test on the target iOS version remains required.

Foreground tracking only: iOS may suspend a PWA in background or with the screen locked. Persistent background tracking requires a native iOS app using Core Location. The app shell is available offline only after successful service-worker installation; SOS/location requests are never served from cache.

## Local checks

From the repository root:

```powershell
node --check Rescuenet-apk/pwa/app.mjs
node --check Rescuenet-apk/pwa/core.mjs
node --check Rescuenet-apk/pwa/location-scheduler.mjs
node --test Rescuenet-apk/pwa/tests/*.test.mjs
```

For a local visual preview from the repository root, run `node Rescuenet-apk/pwa/server.mjs` and open `http://localhost:4173`. Alternatively, run `npm run pwa:serve` from `Rescuenet-apk`. Desktop preview is not proof of iPhone Safari, local AP connectivity, mesh delivery, or production deployment.

## Review documentation

- `../../docs/RESCUENET_PWA_FINAL_CHANGES.md`
- `../../docs/RESCUENET_PWA_FINAL_ARCHITECTURE.md`
- `../../docs/RESCUENET_PWA_FINAL_TEST_PLAN.md`
- `../../docs/RESCUENET_PWA_FINAL_DEPLOYMENT.md`
- `../../docs/RESCUENET_PWA_GITHUB_READINESS.md`
