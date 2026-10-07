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

This repository is public and contains no runtime secrets. The simplest no-cost publish is GitHub Pages directly from the existing `main` branch—no workflow or new repository is needed. In repository **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/(root)**, then **Save**. The app URL will be `https://jakmauu.github.io/Rescuenet-V2/Rescuenet-apk/pwa/`. Wait for GitHub Pages to finish publishing before opening it. The service worker caches only the app shell; it never caches `/api/status` or SOS requests. Later the installed app can reopen its cached shell with no internet.

## Browser and hardware verification status

The Field Node source now implements origin-restricted CORS and OPTIONS for the deployed PWA origin. The firmware must be compiled and uploaded to the Field Node before browser requests can pass CORS. Some browser versions may still block an HTTPS-page → private HTTP device request; desktop tests cannot establish behavior on the user's iPhone/Safari version. Successful iPhone-to-node communication is therefore **not claimed until the physical test passes**.

If the target iPhone still blocks the local HTTP API after the updated firmware is flashed, frontend code cannot bypass that browser security restriction. The robust alternatives are a trusted HTTPS API reachable over the local network or a native iOS client.

GPS permission only appears in a secure context and after the user taps the location button. This follows the browser permission model; the PWA cannot silently grant location access.

## Current PWA → Field Node integration

The Field Node HTTP server now permits CORS only from `https://jakmauu.github.io`, handles the browser's `OPTIONS` preflight for `/api/sos` and `/api/location`, and answers the optional Private Network Access preflight header. Requests from other browser origins are not granted CORS. This is required because GitHub Pages serves this app over HTTPS while the node API uses local HTTP. It does not bypass browser mixed-content policy; verify on the actual iPhone/Safari version after flashing the updated Field Node firmware.

To send repeated phone GPS updates, save the reporter name, allow GPS, and explicitly tap **Mulai bagikan lokasi**. The PWA uses the Android cadence (30 seconds, or movement of at least 25 m after 15 seconds), stores one latest pending update locally, and retries it with the same request ID until the node ACKs. It only runs while the PWA is foregrounded; iOS may pause it when the app is backgrounded or the screen is locked. Stop sharing with **Hentikan berbagi lokasi**. A Field Node ACK means accepted into its local mesh queue, not that the Gateway/Raspberry Pi has stored it; the existing gateway/server STORED ACK is the downstream confirmation.

### Required Field Node update before testing

Pushing this repository updates the hosted PWA only if GitHub Pages is enabled and deployed from this branch. It does **not** update the ESP32. Compile the Field Node sketch with the same TTGO profile/partition metadata used by this project, then upload it manually to the Field Node (not the Gateway):

```powershell
$cli = 'C:\Users\LENOVO\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$fqbn = 'esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none'
& $cli compile --fqbn $fqbn --build-property 'upload.maximum_size=1703936' --build-path 'D:\RescueNET-tools\build-field-pwa-cors' 'D:\RescueNET\field_node'
node D:\RescueNET\field_node\tests\check_generated_partitions.cjs D:\RescueNET-tools\build-field-pwa-cors D:\RescueNET-tools\build-gateway-2c
# Upload only after reviewing a successful compile and partition check; replace COM_PORT with the Field Node's current port.
& $cli upload --fqbn $fqbn --port COM_PORT --input-dir 'D:\RescueNET-tools\build-field-pwa-cors' 'D:\RescueNET\field_node'
```

Keep **Erase All Flash Before Sketch Upload disabled**. Do not erase flash or `rn_sos`. Then close/reopen the installed PWA while online once so its service worker installs the new app shell; afterward connect the iPhone to the Field Node AP and test **Periksa koneksi**. If it still fails, share the exact message and iOS/Safari version—the remaining issue may be browser HTTP-to-local-network policy, which frontend code cannot override.
