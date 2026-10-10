# RescueNet iPhone PWA

Static PWA source for iPhone Safari and Add to Home Screen, separate from the Expo app in `../src/`.

## Current behavior

- First-use onboarding collects a local display name, role, optional team, Wi-Fi guide, API verification, and optional location permission. The stable random `user_id` is retained when the profile is edited; it is not authentication.
- Main navigation has Beranda, Peta, Status, and Profil. The map page displays the latest GPS fix and accuracy without downloading third-party map tiles; an explicit Apple Maps link opens only when the user chooses it.
- Default Field Node API origin is `http://192.168.4.1`. The PWA reads `GET /api/status` and sends the existing payloads to `POST /api/location` or `POST /api/sos`, using `request_id` as `Idempotency-Key`.
- API identity/readability is shown separately from radio/mobile transmit readiness and mesh/Gateway status. HTTP accepted ACK is only proof the Field Node enqueued a request; Gateway, server storage, and responder action are not confirmed by that ACK.
- Location sharing requires explicit consent, a secure browser context, and one foreground `watchPosition`. Stationary sample interval is selectable (30/60/120 seconds; default 120); the scheduler applies at least 60 seconds between accepted fixes, one pending latest fix, one in-flight request, bounded retry/backoff, and a two-minute freshness limit.
- SOS works without GPS and may be saved locally when the node is offline. Up to ten local events are retained best-effort; retry reuses the same request ID. Browser storage is not equivalent to the Field Node's durable NVS journal.

## iPhone and offline limitations

Reliable browser geolocation and service workers require HTTPS or another secure context. The Field Node currently exposes plain HTTP on its private Wi-Fi AP. Firmware CORS/preflight support alone cannot guarantee that Safari/iOS allows an HTTPS page to call an HTTP local-network endpoint. Browser errors do not consistently distinguish mixed content, CORS, local-network policy, and connectivity. An iPhone test on the target iOS version remains required.

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
