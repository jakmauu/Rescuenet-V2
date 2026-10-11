# RescueNet PWA iPhone — Deployment & Rollback Guide

**Status: source only.** This change has not been built, tested on an iPhone, published, pushed, or deployed. Follow these steps only after reviewing the diff and explicitly authorizing the appropriate release.

## Source and endpoint

- PWA directory: `Rescuenet-apk/pwa/` (static HTML/CSS/JS; no bundler required).
- Current public PWA origin assumed by Field Node CORS code: `https://jakmauu.github.io`.
- Field Node default API origin: `http://192.168.4.1`; SSID derives from `RescueNet-Node` plus node ID.
- API contract: `GET /api/status`, `POST /api/location`, `POST /api/sos`.
- Dashboard receives mobile map positions from existing `/api/map/positions`; latest position ordering was updated in server source.

## Before release

1. Review source changes and ensure unrelated local edits are not included. Do not use destructive Git commands.
2. Run the documented unit/source checks only after separate approval; they were intentionally not run in this task.
3. Review firmware origin allowlist and exact deployment hostname before publishing. Do not broaden CORS to `*`.
4. Decide the actual offline HTTPS/local-API architecture. GitHub Pages HTTPS plus CORS does not guarantee Safari/iOS will permit an HTTP private-IP API.
5. Decide dashboard access controls and location-data retention before operational use.
6. Obtain explicit authorization before commit/push/publish, firmware upload, Pi deployment, or database/server changes.

## Local source review (no build)

From the repository root, inspect `git status --short` and `git diff --check`. The static PWA may later be served for a desktop UI review with the existing `npm run pwa:serve` script from `Rescuenet-apk`; localhost preview is not an iPhone/API integration test and is not part of the work performed here.

## Publish after approval

The repository README documents GitHub Pages publishing from the repository root. A user-authorized branch update is required for GitHub Pages to see the modified `Rescuenet-apk/pwa` sources. After the site reports the new version published:

1. Open the HTTPS PWA while internet is available and allow the v5 service worker/app shell/logo to install.
2. If installing fresh, use Safari Share → Add to Home Screen. Existing installs may need close/reopen after the new worker activates.
3. Switch Wi-Fi manually to the appropriate `RescueNet-Node<N>` SSID; accept the iPhone prompt to remain connected without internet.
4. Return to PWA, check Field Node, and record exactly whether Safari permits `/api/status` and POST preflight. Do not infer from desktop.
5. Grant location only after consent; start sharing in foreground. Confirm Gateway, server STORED ACK, database row, and dashboard marker separately.
6. Test stop/revoke, SOS without GPS, node loss/recovery, and stale-location display before any operational use.

Publishing the PWA does not update ESP32 firmware. No firmware upload is prescribed by this guide; confirm firmware version and CORS settings with a separate reviewed deployment plan.

## iPhone/network limitations

- HTTPS is needed for reliable Geolocation API and PWA install. HTTP `192.168.4.1` is not an equivalent replacement for GPS-enabled PWA.
- An HTTPS page fetching HTTP local API may be blocked by Safari/WebKit even with correct CORS. If it fails, do not disable security or claim it can be fixed by changing only frontend code.
- A trusted HTTPS local proxy requires a network path from phone to proxy and from proxy to Field Node. The current isolated AP topology must be verified before adopting this option.
- iOS can pause browser/PWA GPS in background or with locked screen. Persistent tracking needs native/hybrid iOS investigation and device tests.

## Rollback

1. Pause use of this release if SOS or location states are misleading or the app cannot reach a verified node.
2. Roll the hosted PWA source back to the reviewed prior PWA files through the normal authorized GitHub Pages process; do not roll back unrelated server/firmware reliability changes.
3. The previous service worker used cache `rescuenet-pwa-v4`; the v5 worker only deletes cache keys starting with `rescuenet-pwa-`. Deploying the prior source lets its worker repopulate the previous shell after the next page load. If the installed PWA remains stale, close it, reopen while online, and use Safari website data controls only after confirming the correct site origin (clearing site data also removes the local profile/consent).
4. Do not erase Field Node NVS/SPIFFS or database records as a PWA rollback step.
5. Reconfirm SOS idempotency, live-location freshness, and dashboard markers after rollback. Data already accepted/stored is not removed by frontend rollback.
