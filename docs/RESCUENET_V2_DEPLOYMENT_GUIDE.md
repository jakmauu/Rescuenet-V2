# RescueNet V2 compile and deployment guide (manual, not executed)

This guide is for a later operator-approved deployment. Nothing here was run by the coding agent. Do not erase flash or run these steps against a live incident without confirming pending SOS records are safe.

## 1. Review and prepare local compile

From PowerShell, use the current checkout and the exact Arduino CLI installed on that computer. The user's previously observed standalone CLI path was `D:\arduino-cli.exe`; verify it exists before use. Use TTGO LoRa32-OLED / V1 No TFCard, ESP32 core 3.3.3, and FQBN `esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none`.

```powershell
Set-Location 'D:\Rescuenet-V2'
$ErrorActionPreference = 'Stop'
$cli = 'D:\arduino-cli.exe'
$fqbn = 'esp32:esp32:ttgo-lora32:Revision=TTGO_LoRa32_V1,EraseFlash=none'
if (-not (Test-Path -LiteralPath $cli)) { throw "Arduino CLI not found: $cli" }
& $cli version
& $cli core list
& $cli lib list
```

Ensure the exact libraries are installed and discoverable by this CLI: LoRaMesher 1.0.0 at commit `31561e0c3b31f2af332ec339a728ed977cf65e37`, RadioLib 7.1.2, XPowersLib 0.3.3, U8g2 2.36.19, and ArduinoJson 6.21.5. If CLI reports missing headers, pass `--libraries` with a directory whose immediate child folders are those library folders, or fix the CLI sketchbook location; do not copy unrelated library directories into the repository blindly.

Compile commands (compile only; review sizes and warnings before any upload):

```powershell
$buildRoot = Join-Path $env:TEMP 'rescuenet-v2-review'
$fieldBuild = Join-Path $buildRoot 'field-node'
$gatewayBuild = Join-Path $buildRoot 'gateway-node'
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$mkcertRoot = (& 'C:\Tools\mkcert\mkcert.exe' -CAROOT).Trim()
node .\field_node\tools\prepare_tls_secrets.mjs `
  'C:\RescueNet\cert\192.168.4.1.pem' `
  'C:\RescueNet\cert\192.168.4.1-key.pem' `
  (Join-Path $PWD 'field_node\tls_secrets.h') `
  (Join-Path $mkcertRoot 'rootCA.pem') --check-only
if ($LASTEXITCODE -ne 0) { throw 'Field Node certificate validation failed.' }
node .\field_node\tools\prepare_tls_secrets.mjs `
  'C:\RescueNet\cert\192.168.4.1.pem' `
  'C:\RescueNet\cert\192.168.4.1-key.pem' `
  (Join-Path $PWD 'field_node\tls_secrets.h') `
  (Join-Path $mkcertRoot 'rootCA.pem')
if ($LASTEXITCODE -ne 0) { throw 'Local TLS header generation failed.' }
& $cli compile --fqbn $fqbn --build-path $fieldBuild "$PWD\field_node"
if ($LASTEXITCODE -ne 0) { throw 'Field Node compile failed.' }
& $cli compile --fqbn $fqbn --build-path $gatewayBuild "$PWD\gateway_node"
if ($LASTEXITCODE -ne 0) { throw 'Gateway compile failed.' }
node .\field_node\tests\check_generated_partitions.cjs $fieldBuild $gatewayBuild
if ($LASTEXITCODE -ne 0) { throw 'Generated partition binaries do not match the reviewed CSV files.' }
```

The gateway and field sketches must be reviewed and compiled together because RNH1 heartbeat requires the updated Gateway decoder and Field sender. The active `field_node/partitions.csv` has two `0x1a0000` app slots and retains `rn_sos` at offset `0x3e8000`, size `0x8000`; its actual table, not an `upload.maximum_size` override, is the capacity source. Compare generated partition binaries against both reviewed CSVs. USB serial upload works with this existing OTA-capable table; do not switch to `no_ota` or alter layout as routine maintenance. Never choose Erase All Flash Before Sketch Upload.

## 2. Back up Raspberry Pi before server deployment

First verify the target hostname/account/path and available disk space interactively. Stop no service until backup has completed and been verified. Use timestamped copies in the same project directory, and copy the SQLite database separately while the service is quiescent or use SQLite's online backup mechanism. Do not assume user `rescuenet`, `raspi22`, an IP, or a path; confirm them on the target machine.

Example inspection (read only):

```bash
whoami
pwd
df -h .
systemctl --type=service --state=running | grep -i rescuenet
```

After confirming paths, make a timestamped backup of the server source and DB. Transfer only the reviewed `Resquenet-server` source files. Do not recursively overwrite the whole Pi project or its database. Verify copied files with `sha256sum` against hashes computed locally. Take a second backup immediately before restart.

## 3. Apply server changes

Review the actual service unit and virtualenv first. Install dependencies only if the requirements changed (this source change adds no Python dependency). Run database migration through the app's normal startup only after backup; migration is additive and should report added nullable heartbeat columns. Run the prepared tests in a staging/local copy first. For operator-approved production rollout, stop the actual service, copy reviewed files, start it, then check `systemctl status`, `journalctl`, `/api/health`, `/api/nodes`, and `/api/stats`. Do not run duplicate Flask or serial-bridge processes.

The serial bridge is the sole USB serial owner. Stop miniterm/Arduino Serial Monitor before starting it. Its configured path should use `/dev/serial/by-id/...` where available, baud 115200. After startup, confirm retained gateway state freshness; a status older than 20 seconds appears stale.

## 4. Rollback

If server startup or ingestion fails, stop the RescueNet service, restore only the source files from the timestamped source backup, and restore the database only if a verified pre-migration DB backup exists and the operator accepts losing reports committed since that backup. Preserve both current and backup DB files; never delete or overwrite the only copy. Restart the service and verify `/api/health` and report count. For firmware rollback, compile the prior known source revision with the same board settings and upload only after confirming the pending-report/partition implications; never erase the Field Node flash.

## 5. One-report acceptance check

Use `docs/RESCUENET_V2_TEST_PLAN.md`. Expected sequence: Field journal commit before portal success; bounded mesh send; Gateway RNL1 envelope; bridge MQTT publish; backend DB insert/duplicate resolution; STORED ACK; Gateway RNA1 TX; Field removal of the matching journal entry. A gateway USB connection or `Send()` return alone is not proof of end-to-end success.
