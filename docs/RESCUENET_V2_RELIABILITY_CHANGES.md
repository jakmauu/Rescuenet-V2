# RescueNet V2 reliability changes

Status: source changes prepared for review only. No firmware compilation, test execution, hardware test, Pi deployment, or Git push was performed for this change set.

## Findings addressed

- Field logs showed the node was synchronized and had a gateway route, but `Send()` hit the LoRaMesher 10-entry TX queue. A successful `Send()` is only a local enqueue, not radio delivery or server storage. The application retry path must therefore bound in-flight frames and preserve reports until a valid STORED ACK.
- Captive-portal reports previously lived only in RAM. A reset could lose them. They now use a separate Preferences namespace, `rn_legacy_b1`, in the existing `rn_sos` partition. Existing `rn_mobile_b1` content and the `rn_sos` partition offsets are not changed.
- The previous scheduler could keep counting a timed-out frame as in flight, and could select an oldest report whose backoff had not elapsed instead of another eligible report. Expired frames can now be released for retry only after the mesher queue drains to a bounded level; queue depth >= 8 applies backpressure. SOS receives up to three consecutive eligible sends before an eligible normal report gets a turn.
- Database upserts updated `node_status.last_seen` even when the delivery key was a duplicate. Only a newly inserted report/mobile event now updates report activity. Duplicate keys still return the existing row and remain eligible for STORED re-ACK.
- Report activity and device liveness are distinct. An additive `RNH1` heartbeat reports node ID, protocol version, uptime, mesh synchronization, gateway discovery, and pending count. It is emitted only when report queues and the local TX queue are idle, at most once per 60 seconds. The original RNL1/RNM1/RNA1 frame bytes are unchanged.
- The bridge now deduplicates queued ACK keys, keeps an ACK queued if a USB serial write fails or is short, and republishes gateway status periodically. The API marks gateway status stale when its retained update is older than the configured freshness window.

## End-to-end path after these changes

Captive portal submit -> validate/encode -> durable local outbox -> bounded LoRaMesher send -> Gateway validates and writes RNL1 envelope -> bridge validates and publishes MQTT -> backend commits idempotently to SQLite -> STORED ACK on duplicate or new committed row -> bridge retries serial delivery after write failure -> Gateway schedules LoRa ACK with TX backpressure -> Field Node removes only the matching durable record.

`Send()` acceptance, Gateway receipt, MQTT publish, database commit, and Field STORED ACK are deliberately separate logged events. This is at-least-once delivery with idempotent persistence, not exactly-once radio transmission.

## Storage and compatibility

- The new legacy report queue is fixed at 8 ordinary reports plus 2 SOS reports. Full queues reject new entries; they do not overwrite unconfirmed reports.
- Each journal record includes a format version, stable SHA-256-derived 128-bit key, payload, monotonic sequence, and CRC32, with read-back verification before the portal is told it was accepted.
- Only a valid STORED key removes a queued report. Corrupt records fail closed and are retained for inspection; no automatic NVS erase/migration is performed.
- The journal shares the existing `rn_sos` partition but uses its own NVS namespace and short keys. The partition layout and mobile journal namespace are preserved.
- `RNH1` is additive. Both the updated Field Node and updated Gateway are required to see heartbeat status. Old Gateways safely ignore this new application frame; reports continue using their existing protocol.
- Existing SQLite tables are changed additively with nullable heartbeat columns; no table is dropped and old report rows remain. Report activity is still available as `last_seen` and is also exposed as `last_new_report_at`.
- If a pre-existing database already contains duplicate non-null delivery keys, migration logs a critical note and defers creating the unique index rather than deleting historical rows or preventing service startup. New report inserts use a serialized key lookup in that case. Resolve such historical conflicts only through an explicit reviewed data-repair procedure.
- iOS/PWA CORS behavior remains allow-list based in the Field Node web server. CORS does not bypass iOS HTTPS-to-local-HTTP mixed-content/local-network restrictions; verify those separately in Safari.

## Configuration and runtime interpretation

- Heartbeat cadence: 60 seconds, only with an empty report outbox and empty LoRaMesher TX queue. Device online timeout: 150 seconds (`RESCUENET_NODE_HEARTBEAT_STALE_SECONDS`).
- Gateway retained-state freshness: 20 seconds (`RESCUENET_GATEWAY_STATUS_STALE_SECONDS`); bridge refreshes every five seconds while serial is open.
- “Recently active” remains based on new report activity for backward-compatible dashboard statistics. “Device Online/Stale/Unknown” is heartbeat-derived. `Unknown` means no compatible heartbeat has been received, not offline.
- Gateway heartbeat cannot be sent while no Gateway route/synchronization exists; in that condition the dashboard eventually reports stale/unknown rather than claiming healthy radio connectivity.
- RSSI/SNR are not fabricated: the current LoRaMesher callback shown here does not supply per-packet measurements.

## Files changed for reliability

See the final handoff list. Firmware changes are in `field_node/LegacyReportQueue.h`, `field_node/RescueNetMeshTransport.h`, `field_node/RescueNetWire.h`, `field_node/MobileApi.h`, and `gateway_node/gateway_node.ino`. Server changes are in configuration, serial/wire parsing, MQTT ingestion, database schema/API, dashboard rendering, and tests.

## Known limits

- No firmware has been compiled against the exact locally installed LoRaMesher package in this pass. The `GetTxQueueSize()` / send/readiness usage is the same API already present in project code; the new heartbeat paths still require user compile review.
- NVS behavior must be checked on the actual board, especially with pending `rn_mobile_b1` SOS items and a full `rn_sos` partition. Do not select “Erase All Flash”.
- A lost Gateway ACK mapping is recoverable when a Field retry is received; mapping itself is RAM-only. Server delivery keys are the durable identity.
- Application-level STORED ACK is retried when the Field retransmits a report; the serial bridge cannot know whether the Field received the LoRa ACK.
- Timing and delivery-rate targets require repeated physical tests; no latency guarantee is claimed here.
