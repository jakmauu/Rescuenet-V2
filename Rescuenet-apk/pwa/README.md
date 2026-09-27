# RescueNet PWA

Mobile-first PWA page that follows the Android API contract in `src/services/RescueNetApi.ts` and `field_node/MobileApi.h`:

- Field Node base URL: `http://192.168.4.1` (`src/config/settings.ts`)
- Verification: `GET /api/status`, validating `service`, `api_version`, positive `node_id`, `device`, `status=ready`, `mobile_protocol=1`, and `mobile_tx_enabled=true` from the current firmware.
- SOS: `POST /api/sos`, JSON payload generated using the same fields/freshness rules as `src/utils/location.ts`, `Idempotency-Key: request_id`, and confirmation only for HTTP success plus JSON `{service:"rescuenet-field-node", accepted:true, request_id:<same id>}`.
- Browser GPS is requested only after the user presses “Izinkan / perbarui lokasi”. If permission/fix is unavailable, the existing Android protocol permits `has_gps:false`; no coordinates are invented.

## Local preview and tests

From `D:\RescueNET\Rescuenet-apk`:

```powershell
npm.cmd run pwa:test
npm.cmd run pwa:serve
```

Open `http://localhost:4173` on the development computer. This is only a UI/API-mock preview; on non-local HTTP origins iPhone geolocation and PWA installation are not available. The browser tests mock HTTP responses and do not claim Field Node hardware was tested.

## Hosting and iPhone installation

Publish the `pwa/` directory as a static site over HTTPS (for example, GitHub Pages using the repository's Actions deployment workflow). Open that HTTPS URL in iPhone Safari while the iPhone has internet, use Share → Add to Home Screen, then open RescueNet from its Home Screen before connecting to the Field Node. The service worker caches only the app shell; it never caches `/api/status` or SOS requests. Later the installed app can reopen its cached shell with no internet.

## Important integration limit — do not flash this as “ready” yet

The ESP32 firmware API is HTTP on `192.168.4.1`, while an installed web app must be loaded from a secure HTTPS origin for GPS and service-worker installation. A request from that public HTTPS origin to the node is cross-origin, and current `field_node/MobileWebServer.h` / `MobileHttpHeaders.h` does **not** implement CORS/OPTIONS. Some iOS/WebKit versions also block HTTPS-page → private HTTP device requests as mixed content; browser Local Network Access support is not a portable PWA capability. Consequently this source has a truthful fail-closed error for blocked local-network access, but successful iPhone-to-node communication is **not established** by desktop tests.

Before physical use, select the permanent HTTPS hosting origin and implement/test an origin-restricted CORS + OPTIONS policy in Field Node firmware, then test the exact iOS/Safari version with the node's AP. Do not use `Access-Control-Allow-Origin: *` for SOS endpoints. If the target iPhone cannot make a secure PWA request to the local HTTP API even with the user's local-network permission, the correct solution is to serve a trusted HTTPS origin/API through the local network (with a valid certificate and routing) or use a native iOS client; frontend-only changes cannot bypass WebKit security.

GPS permission only appears in a secure context and after the user taps the location button. This follows the browser permission model; the PWA cannot silently grant location access.
