# RescueNet iPhone captive portal and local HTTPS

This is a **local-network** workflow, not internet service from the Field Node:

1. Join the Field Node AP (`RescueNet-Node1`, or the configured node SSID).
2. iPhone may open the HTTP captive portal. The portal says the AP has no internet; if iOS asks, choose **Stay Connected / Without Internet (Tanpa Internet)**. Close the Wi-Fi sign-in sheet after choosing to stay connected.
3. Open the already-installed RescueNet PWA from the Home Screen (or Safari) and test `https://192.168.4.1/api/status`.

The PWA app shell must have been loaded/installed while the phone had internet. A first load from GitHub Pages cannot be fetched while connected to this internet-less AP. The portal remains on HTTP port 80; the PWA API is HTTPS only on port 443. HTTP connectivity-check requests are deliberately answered with the portal page, not a fabricated internet-success response. HTTPS requests for unrelated hostnames are not redirected.

## Portal and AP behavior

Field Node uses `WiFi.softAPConfig(192.168.4.1, 192.168.4.1, 255.255.255.0, 192.168.4.2, 192.168.4.1)`: AP address/gateway are `192.168.4.1`, DHCP leases start at `.2`, and DHCP explicitly offers `.1` as DNS. The wildcard `DNSServer` listens on port 53, and `MobileWebServer` serves port 80. This explicit DHCP DNS offer matters: ESP32 Arduino core 3.3.3 only enables the DHCP DNS option when a nonzero DNS argument is supplied to `softAPConfig`; a wildcard DNS process alone does not advertise itself to iPhone clients. The firmware also registers common Apple, Android, and Windows HTTP probe paths to show the portal page. `/api/...` on port 80 remains a not-found response; it is not a PWA API fallback. HTTPS uses a separate ESP-IDF `esp_https_server` listener on port 443.

Check boot output for `[WIFI] AP address=192.168.4.1 gateway=192.168.4.1 dhcp_start=192.168.4.2 dns=192.168.4.1 captive_dns=ready`, `[WEB] Captive Portal aktif.`, and `[HTTPS] API listening ...`. In the iPhone Wi-Fi details, the assigned address should be in the AP subnet (`192.168.4.x`) and router/DNS should be `192.168.4.1`. AP/DNS messages describe local network setup only, not internet access.

## Local certificates

The server needs the mkcert **leaf certificate and matching private key**:

- `C:\RescueNet\cert\192.168.4.1.pem`
- `C:\RescueNet\cert\192.168.4.1-key.pem`

The local helper verifies UTF-8 PEM shape, IP SAN, validity dates, key-pair match, and (when supplied) the leaf signature against the public root CA. It writes the ignored `field_node/tls_secrets.h` atomically and never reads the CA private key. Supply the public root CA explicitly:

```powershell
Set-Location 'D:\Rescuenet-V2'
$mkcertRoot = (& 'C:\Tools\mkcert\mkcert.exe' -CAROOT).Trim()
node field_node\tools\prepare_tls_secrets.mjs `
  'C:\RescueNet\cert\192.168.4.1.pem' `
  'C:\RescueNet\cert\192.168.4.1-key.pem' `
  (Join-Path (Get-Location).Path 'field_node\tls_secrets.h') `
  (Join-Path $mkcertRoot 'rootCA.pem') --check-only
node field_node\tools\prepare_tls_secrets.mjs `
  'C:\RescueNet\cert\192.168.4.1.pem' `
  'C:\RescueNet\cert\192.168.4.1-key.pem' `
  (Join-Path (Get-Location).Path 'field_node\tls_secrets.h') `
  (Join-Path $mkcertRoot 'rootCA.pem')
git check-ignore -v field_node\tls_secrets.h
```

Do not put `rootCA.pem`, the server certificate, the server private key, generated header, or especially `rootCA-key.pem` in Git. The Field Node firmware contains the leaf certificate/private key because it must terminate TLS; the CA private key is never installed on a device. Transfer only public `rootCA.pem` to the iPhone. Install its profile and enable **Settings > General > About > Certificate Trust Settings > Enable Full Trust**. A mkcert message that the Java trust store was not changed is irrelevant to Safari/iOS. The supplied leaf certificate was reported as valid through **10 January 2029**; renew before that date. If the CA changes, install and fully trust the new public root too.

## Build and USB-serial upload notes

Field Node is TTGO LoRa32 V1, ESP32 Arduino core 3.3.3 (`field_node/sketch.yaml`, profile `checkpoint_2c`). The active `field_node/partitions.csv` is a reviewed 4 MB dual-app-slot layout; each app slot is `0x1A0000` bytes, and the Field Node journal remains at `0x3E8000` (`rn_sos`). USB serial upload is compatible with this layout; OTA capability in the partition table does not require using OTA. Do not switch to `no_ota` or erase flash as part of HTTPS setup: changing the partition map can affect existing persistent data. Do not use a made-up `upload.maximum_size` value to hide a partition mismatch. Build from the `field_node` sketch folder so its active `partitions.csv` is selected, then inspect/compare the generated partition binary against that CSV before any upload. This task does not compile or upload firmware.

The HTTPS server uses one concurrent TLS socket intentionally: the bundled ESP-IDF `esp_https_server.h` documents roughly 40 kB per secure socket. The captive HTTP server and DNS remain active separately. Logs now report free, minimum-free, and largest-block **internal heap** separately; these are heap measurements, not task stack sizes.

## Manual test sequence (after you build and flash by USB serial)

1. Join the AP from iPhone Settings > Wi-Fi. Confirm the portal appears; if asked, select **Without Internet / Stay Connected** and close the captive sign-in sheet. If it does not appear, visit `http://192.168.4.1/` in Safari while joined.
2. With the iPhone still on the AP, open `https://192.168.4.1/api/status` in Safari. Confirm JSON appears and there is no certificate interstitial. `https://192.168.4.1/` may return an API 404; the captive portal is intentionally HTTP, not an HTTPS fallback.
3. Open the installed PWA, choose **Periksa koneksi**, then separately test location/SOS only after status succeeds.
4. From a laptop on the same AP, verify the cert and status endpoint:

```powershell
$mkcertRoot = (& 'C:\Tools\mkcert\mkcert.exe' -CAROOT).Trim()
curl.exe --cacert (Join-Path $mkcertRoot 'rootCA.pem') https://192.168.4.1/api/status
```

An HTTP `accepted` from the node confirms only local queue acceptance, not delivery to Gateway/server.

## Reading handshake logs

`[HTTPS] API listening` means the listener started, **not** that a client completed TLS. The new `[HTTPS ERROR]` log includes ESP error, mbedTLS code, certificate flags, and current/minimum/largest internal heap. `MBEDTLS_ERR_SSL_CONN_EOF` (`-0x7280`) means the client closed the connection during the handshake; an iOS captive check that is abandoned can do this, but the code alone cannot prove that. `MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE` (`-0x7780`) means the peer sent a fatal alert; the callback does not expose its alert description, so do not infer “untrusted root” from that code alone. Compare Safari direct status test, AP/captive state, certificate trust, and heap logs. A server handshake timeout is logged as a distinct category.

Actual portal behavior, TLS compatibility with Safari, and end-to-end API delivery still require flashing and testing this physical Field Node/iPhone pair. Source inspection cannot certify the live handshake.
