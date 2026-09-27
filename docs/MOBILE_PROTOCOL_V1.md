# RescueNet Mobile Protocol V1 — Checkpoint 2A

> Catatan 2C: kontrak HTTP di sini tetap berlaku, tetapi rancangan radio 171-byte/CSV/manual relay di bawah diganti oleh `CHECKPOINT_2C_WIRE.md` (RNM1/RNL1/RNA1, LoRaMesher, maksimum 100 byte, ACK STORED). Jangan gunakan bagian radio 2A untuk firmware 2C.

Status: **rancangan 2A disetujui melalui otorisasi 2B**. Tanggal review: 2026-09-18.
Implementasi 2B hanya HTTP/antrean lokal (catatan bagian12); LoRa mobile dan komponen berikutnya belum diimplementasikan.
Dokumen ini menggantikan usulan awal `Rescuenet-apk/docs/PHASE_2_API_CONTRACT.md` sebagai rancangan lintas komponen setelah disetujui. Tidak ada perubahan production pada Checkpoint 2A.

## 1. Implementasi yang ditemukan

Workspace aktual `D:\RescueNET`: `field_node/`, `gateway_node/`, `Rescuenet-apk/`, **`Resquenet-server/`** (q).

Alur aktual: portal/physical SOS → CSV LoRa → optional flooding relay → Gateway → USB 115200 → `SerialBridge.classify_serial_line` → MQTT `rescuenet/reports` → `MQTTService._handle_report` → SQLite `reports` + `node_status` → Flask `/api/reports` → dashboard polling. Status gateway memakai topic terpisah.

- Field Node: AP terbuka `RescueNet-Node{NODE_ID}`, 192.168.4.1, `/`, POST `/submit`, GET `/sos`; unknown route redirect HTTP302. Portal dan physical SOS memakai GPS onboard, freshness 300 s. `sendReport()` langsung memanggil pengiriman blocking; handler portal saat ini belum meneruskan kegagalan TX ke pengguna.
- Legacy LoRa tepat 11 field: `PKT_ID,SRC_ID,HOP,MAX_HOP,LAT,LON,HAS_GPS,KONDISI,JUMLAH,SOS,PESAN`. ID 16 bit = node 4 bit + counter 12 bit; cache node 25, gateway 40; reset/wrap mungkin. Jangan menambahkan UNIQUE(pkt_id) ke laporan lama.
- Relay `checkLoRaReceive()` membaca String, splitCSV 11 field, menambah hop lalu random delay 80–399 ms. Origin HOP0 valid; MAX_HOP pengirim 5. Gateway tidak menambah hop, hanya prefiks RSSI/SNR, paket pertama yang diterima menang dedup.
- Radio kedua sketch tetap: 923 MHz, SF9, BW125 kHz, CR4/5, sync0xF3, CRC aktif.
- Server `parse_report_line()` split maksimal 12 koma, mempertahankan koma dalam pesan terakhir. `classify_serial_line()` membedakan READY/log/legacy/invalid. Schema additive sudah tersedia; tidak ada users/user_locations/mobile_sos. `app.py:create_app` mendukung DB sementara dan tanpa MQTT untuk tes.
- Dashboard sekarang adalah **plot koordinat/grid HTML**, bukan tile satelit/OSM. `mapHtml()` menggunakan laporan legacy dan has_gps. Fase ini menambahkan layer/daftar mobile, bukan diam-diam mengubah penyedia peta.
- App: UUID request 36 karakter lowercase, user ID `USR-` + UUID (40 karakter), nama 2–60 UTF-16 code units. Lokasi memakai `timestamp`; SOS memakai `timestamp` event + `gps_timestamp` fix. SQLite menyimpan payload antrean lama; jangan menghapus/mengganti ID antrean saat upgrade. ACK sudah memerlukan service marker, accepted=true, request_id sama. Status internal DELIVERED bukan ACK command center.

### Lingkungan build yang ditemukan

ESP32 Arduino core **3.3.3** di Arduino15; library OneDrive/Documents/Arduino: LoRa0.8.0, XPowersLib0.3.3, U8g2 2.36.19. ArduinoJson tidak ditemukan pada dua direktori library yang diperiksa. `arduino-cli`/`pio` tidak ditemukan di PATH; belum berarti Arduino IDE tidak tersedia. FQBN board dan binary CLI bundled perlu dikonfirmasi di 2B; tidak mengklaim firmware sudah dikompilasi.

Usulan dependency baru: ArduinoJson **6.21.5**, fixed `StaticJsonDocument<1536>`, nesting limit2, input buffer1025 byte, response buffer512. Pin versi ini pada manifest build; jangan mencampur API v6 dengan dynamic document v7 tanpa review. Core3.3.3 mendukung raw request handler (`canRaw/raw`), penting karena `server.arg("plain")` biasa mengalokasikan seluruh body **sebelum** handler memeriksa panjang.

## 2. Kontrak HTTP API v1

Base `http://192.168.4.1`, JSON UTF-8, tanpa syarat akses internet. Marker service mengidentifikasi protokol, **bukan autentikasi kriptografis**.

### GET /api/status

HTTP200 `application/json`:

```json
{"service":"rescuenet-field-node","api_version":1,"node_id":1,"device":"field_node","status":"ready","mobile_protocol":1}
```

ready berarti subsystem lokal siap menerima, tidak berarti gateway/server terjangkau. Saat storage/radio gagal: status `degraded`; POST yang tidak bisa ditampung mendapat503. Respons status boleh menambahkan hitungan antrean, bukan nama/lokasi pengguna.

### POST /api/location — bentuk canonical baru

```json
{"request_id":"00000000-0000-4000-8000-000000000001","user_id":"USR-00000000-0000-4000-8000-000000000002","name":"Riko Dharmawan","has_gps":true,"lat":-6.364821,"lon":106.828913,"accuracy":6.8,"fix_timestamp":1789551200}
```

### POST /api/sos

```json
{"request_id":"00000000-0000-4000-8000-000000000003","user_id":"USR-00000000-0000-4000-8000-000000000002","name":"Riko Dharmawan","sos":true,"has_gps":true,"lat":-6.364821,"lon":106.828913,"accuracy":6.8,"fix_timestamp":1789551200,"event_timestamp":1789551230}
```

Tanpa GPS tetap sah:

```json
{"request_id":"SOS-0001","user_id":"USR-A81F","name":"Riko","sos":true,"has_gps":false,"event_timestamp":1789551200}
```

### Validasi dan kompatibilitas app Fase1

- Body maksimal1024 byte; hanya object datar, reject duplicate JSON keys, unknown fields, bool sebagai angka, NaN/Infinity, fractional timestamps. Content-Type application/json dengan optional charset UTF-8; Content-Length wajib dan masuk batas. Chunked/encoded/multipart untuk `/api/*` ditolak, tanpa mengubah form legacy.
- Terapkan bounded raw handler khusus `/api/*`: cek content length pada RAW_START sebelum menyalin body; max1024, tutup koneksi setelah413/415 agar tidak drain body raksasa; deadline baca2 s; abort parsial tidak enqueue. Core tetap memiliki parser header sendiri: header flood/slow client harus diuji, jangan mengklaim keseluruhan WebServer immune DoS.
- request_id dan user_id: 1–40 ASCII, regex `[A-Za-z0-9_-]+`; juga terima UUID canonical lowercase dengan hyphen. `Idempotency-Key` bila ada wajib sama dengan request_id. Nama: trim/normalize whitespace, 2–60 UTF-16 code units dan maksimal240 UTF-8 bytes; reject invalid UTF8/control character tersisa. Validasi keikutsertaan panjang berdasarkan string decoded, bukan jumlah byte JSON escape.
- Koordinat finite latitude[-90,90], longitude[-180,180]; angka0 sah. Accuracy finite0..6553.4 m atau null. Fix/event integer Unix detik1..4294967295. Timestamp bukan millis. Range clock HP belum membuktikan waktu benar.
- Location wajib has_gps=true dan fix time. SOS wajib sos=true, event time, has_gps boolean. SOS GPS=true wajib coords, accuracy/null, fix time; GPS=false menghilangkan coords/accuracy/fix. Tidak pernah fallback GPS onboard untuk mobile.
- Alias yang tetap diterima: location `timestamp` → fix_timestamp; SOS `timestamp` → event_timestamp dan `gps_timestamp` → fix_timestamp. Bila canonical+alias sama-sama ada harus sama; konflik400. Normalisasi alias sebelum dedupe. Ini memungkinkan app Fase1/antrean lama dipakai tanpa hilang data. App2G membuat field canonical hanya pada boundary HTTP, tidak mengganti request_id/history SQLite lama.
- Umur snapshot SOS tidak ditolak karena sudah antre lama; waktu fix asli dipertahankan. Node tanpa jam tersinkron hanya memeriksa tipe/range, bukan membandingkan dengan waktu node fiktif.

### ACK dan errors

HTTP202 untuk baru diterima:

```json
{"service":"rescuenet-field-node","accepted":true,"request_id":"SOS-0001","node_id":1,"state":"queued_for_lora","duplicate":false,"name_truncated":false}
```

Duplicate yang diketahui HTTP200 dengan duplicate=true, state sesuai catatan: queued_for_lora, lora_tx_completed, atau superseded (location yang diganti update lebih baru). accepted hanya menyatakan penerimaan historis/lokal, bukan janji masih pending. Jangan return queued_for_lora bila sudah TX. SOS baru ACK hanya setelah journal durable berhasil ditulis.

Error JSON `{"service":"rescuenet-field-node","accepted":false,"error":"queue_full"}` dengan400 invalid/missing/conflicting fields;409 reused ID berbeda payload atau stale_location;413 oversized;415 media/encoding;429 rate limit;503 queue/storage/radio unavailable. Unknown `/api/*`404 JSON; metode salah405 JSON; halaman portal lain tetap captive redirect.

UI 2G: **Accepted by RescueNet Node** / **Queued for RescueNet transmission**, bukan Command Center Received. DELIVERED di DB app lama tetap dapat dibaca sebagai node accepted; jangan mengirim ulang semua histori delivered karena rename UI.

## 3. LoRa binary mobile v1 — format eksak

Legacy CSV **tidak berubah**. Mobile diawali dua byte ASCII `RN` (`52 4e`), version byte1. Karena legacy valid diawali pkt_id desimal, discriminator tidak ambigu. Frame dengan RN tetapi versi salah/rusak harus drop, bukan fallback CSV. Gunakan buffer byte+length, bukan `String`, `strlen`, atau `.print()` untuk binary.

Semua integer multi-byte **big-endian**. Signed coordinate two's complement. Tidak mengirim raw C struct (padding/endian tidak portable).

| Offset | Byte | Field / ketentuan |
| --- | ---: | --- |
| 0 | 2 | magic RN |
| 2 | 1 | version=1 |
| 3 | 1 | type ASCII L=0x4c atau S=0x53 |
| 4 | 1 | original source node, 1..15 |
| 5 | 1 | hop, 0..max_hop |
| 6 | 1 | max_hop, 0..5; origin default5 |
| 7 | 1 | flags: bit0 has_gps, bit1 name_truncated; bit2..7 wajib0 |
| 8 | 8 | source boot_session random64 nonzero; bukan jam |
| 16 | 4 | source sequence1..0xffffffff |
| 20 | 4 | event_timestamp; L sama dengan fix_timestamp |
| 24 | 4 | fix_timestamp; S tanpa GPS=0 |
| 28 | 4 | lat_e7 signed: round(lat*1e7), ties away from zero |
| 32 | 4 | lon_e7 signed, aturan sama |
| 36 | 2 | accuracy_dm round(accuracy*10); 0xffff=null |
| 38 | 1 | user codec:1 compact UUID,2 ASCII |
| 39 | 1 | user byte length U |
| 40 | 1 | request codec:1 compact UUID,2 ASCII |
| 41 | 1 | request byte length R |
| 42 | 1 | name byte length N=1..48 |
| 43 | U | user identity |
| 43+U | R | request identity |
| 43+U+R | N | bounded UTF8 display name |

Exact frame size `43+U+R+N`, **max171 bytes**, no trailing data. GPS=false requires lat_e7=lon_e7=fix_timestamp=0, accuracy=0xffff. Parser emits null coordinates, not geographic(0,0). L requires GPS=true. GPS=true requires nonzero fix time and coordinate/accuracy range; S event/fix are independent, clock anomalies flagged later rather than inventing timestamps.

Codec1: U/R exactly16 raw UUID bytes in textual hex order (remove hyphens, parse successive pairs, not Windows GUID byte order). User reconstructed as `USR-` + canonical lowercase UUID; request reconstructed lowercase UUID without prefix. Only exactly matching input patterns use codec1. Codec2: exact ASCII string1..40; preserves short IDs such as USR-A81F / SOS-0001. Reject codec2 when its contents qualify for codec1 (one canonical encoding per ID). No hashing/truncation of request/user identity. UUID requests from the current app lose no identity information.

Name strategy: each packet carries first **48 UTF8 bytes at a codepoint boundary**; set name_truncated if more bytes existed. This avoids registration-packet dependencies and carries a readable name even if SOS is the first/only reception. Original full name stays on HP. Server stores `name` as display name plus explicit truncated flag; **cannot promise full names over48 bytes on dashboard** in this version. Do not show truncated name as verified full identity. No fragmentation/extra identity message in V1; future full-profile sync requires separate contract approval.

Typical app UUIDs: 43+16+16+14 for `Riko Dharmawan` = **89 bytes**; maximal app UUID frame123 bytes, fallbackASCII maximal171. JSON/UUID textual overhead does not go on air. Shared buffer cap171, RX legacy buffer255. LoRa library caps write at255 bytes: verify write count equals full frame, never accept silent truncation. Existing radio settings/CRC unchanged. These are byte budgets, not a regulatory airtime certification.

## 4. Identity, dedupe and relay

Transport identity `(source, boot_session, sequence)`, unchanged by relay/retry of local TX. New boot gets fresh random64 from ESP32 entropy, counter1; before wrap choose new session. Durable pendingSOS retains old encoded identity across reboot. Same logical request through another node can have different transport identity.

Logical identity `request_id` globally, with immutable owner user_id/type; UUID collision unlikely, manual short ID caller must ensure uniqueness. Reusing a request ID with different user/type/payload is conflict, not another incident. Database enforces uniqueness across L/S via mobile_requests registry, not solely within each table.

HTTP dedupe:

- Pin all pending requests in their bounded queues.
- SOS: persist up to8 active journal entries and32 completed logical identities + normalized payload SHA256 digest in NVS. Same ID+same digest returns prior ACK, different digest409. Completed history is FIFO last32 completedSOS, **not indefinite/time-based**, survives reboot. Pending entries never evicted for another request. Storage full/failure503, do not ACK.
- Location: RAM64 accepted-ID/digest entries,30-minute max age or oldest-eviction; pending entries pinned, no reset of pending entry age to evict it. Coalesced entry records superseded while retained. No reboot persistence for location cache. Expired retry can be accepted again; server dedupe still protects stored logical records.
- Digest over canonical, normalized HTTP values in fixed key order; include kind, original full normalized name, IDs, has_gps, unquantized valid numbers, relevant times; exclude aliases/header order/transport metadata. In 2B freeze cross-language canonical vectors, including -0 normalized0. Store full32-byte hash; no need to store arbitrary body on ESP32.
- After completedSOS cache eviction or flash erase, node may retransmit old request. Server logical dedupe remains the final incident boundary; do not promise forever node dedupe.

Relay/gateway: separate mobile transport cache128 entries,10-minute max age/FIFO eviction, independent of legacy25/40. Check valid frame before caching. Source marks emitted identity to prevent relaying own echo. Relay caches after successfully enqueueing, not before a queue-full rejection; queue entry suppresses duplicates while pending. Relay increments byte5 once only, preserves **every other byte**, rejects hop+1>max. First route wins; no forced hop, no exact path inference. Gateway validates and forwards current hop unchanged; marks identity once record emitted to serial (not server ACK). Bounded cache eviction can allow another copy, TTL still limits loops, server dedupe limits incidents.

## 5. Queue, TX ownership, failure and traffic control

One radio owner, cooperative loop; HTTP handlers enqueue only. Proposed fixed slots: local mobileSOS8 (durable), legacy reports8 including2 reserved physical/portalSOS, mobile locations16 (one pending per user), mobile relay16 (8 reservedS). Queues+identity caches target under48KiB RAM beyond existing WiFi/web/OLED stack; measure actual sizeof/free heap under load before accepting 2B/2C.

Priority on free radio: local/relay mobileSOS first, legacy SOS next, other legacy reports/relay, mobile locations last. Never interrupt an on-air packet. Fair FIFO/round-robin within class. Existing legacy route/radio format preserved; only submission → bounded scheduler seam changes when implemented. Failed legacy enqueue must show busy/failure, not current unconditional success HTML. PhysicalSOS gets reserved capacity and OLED/serial failure indication if unavailable; no claim of unlimited capacity.

Location coalescing: same user newer fix replaces unsent older frame; older/equal conflicting fix rejected409 stale_location; exact known request retry gets original ACK first. Maintain per-user last-sent high-water mark RAM64 entries (LRU), no eviction of active pending users. Dropping/coalescing ordinary history is intentional and not SOS behavior. After reboot/eviction a stale location can pass; server still selects by fix time.

Traffic limits for mobile frames, including relay: at least5 s between mobile TX starts; at most1 mobile location per user per30 s; round-robin users. Additional local mobile airtime budget6 s per rolling60 s (estimate conservatively before TX, account actual duration afterward), all mobile types obey; SOS preempts location spending, never bypasses budget. Relay jitter80–399 ms is a scheduled due time, not blocking delay. Legacy traffic remains working and is not counted as a promise that **total network** airtime is bounded; measure combined traffic/flooding and tune deployment limits before field use. Queue saturation returns503/429, not unlimited buffering. Values are engineering defaults for testing, **not legal duty-cycle claims**.

Use async LoRa TX + completion polling, verify beginPacket and write length; bound completion wait3 s then recover radio. Keep failed acceptedSOS durable; retry after2/4/8/16/30 s capped with jitter under scheduler limits. No attempt-count expiry for acceptedSOS. Persist local TX-completed state before releasing its journal slot; power loss before completion persistence may retransmit same identity (at-least-once). Queue/cached dedup update atomic at application level, fail closed on NVS write error. Reserve one extra recovery/journal metadata slot; validate version/CRC on boot, log storage fault instead of silently treating corruption as successful delivery. Do not reflash/erase journal automatically.

Once local radio TX completes, mark local completion; **this does not prove reception anywhere**. No repeating indefinitely after successful radio emission or invented end-to-end ACK. Flash wear budget/testing required for SOS-only journal; do not persist every tracking update. Original GPS immutable while waiting.

## 6. Gateway → Raspberry Pi serial

115200 baud, ASCII LF-terminated; accept optional CR before LF. Legacy remains byte-for-byte `RSSI,SNR,<11-field CSV>` and GATEWAY_READY/log lines unchanged.

Mobile exact format:

```text
RNM1,<rssi>,<snr>,<RFC4648-standard-base64-of-entire-mobile-frame>\n
```

rssi signed integer -200..0, snr finite decimal -40..40 (emit2 decimals to retain quarter-dB values). Base64 padded, no whitespace/newlines. Exactly4 CSV fields; strict decoding, canonical encoding, decoded length<=171 and frame validation again on server. Boot64 represented as16-digit hex string in JSON, not JS number. Gateway only changes representation, not payload/source/hop/GPS. Use bounded char buffer256 for mobile record; longest encoded payload228 bytes and line with prefix/RSSI/SNR/LF fits below256. Serial reader global limit1024 bytes including newline for legacy compatibility; oversize/partial line discard through next LF, never reinterpret tail as a new valid packet. Debug cannot use RNM1 prefix.

Bridge classifies RNM1 **before** legacy split. InvalidRNM1 does not fall back to legacy. New MQTT topic `rescuenet/mobile/v1`, QoS1 retain=false; payload decoded typed JSON with protocol_version, kind, request_id, user_id, name, name_truncated, has_gps, lat/lon/accuracy (nullable), fix_timestamp/event_timestamp, src_node, hop/max_hop, boot_session, sequence, rssi/snr and **received_at set by bridge clock**. Subscriber independently validates JSON again; malformed input logs reason without dumping personal data and continues.

QoS1 is not durable end-to-end delivery: current bridge/client/broker do not establish guaranteed offline spooling. Server/USB/broker down can lose packets despite phone node ACK. Durable bridge spool or reverseACK is separate scope, not assumed. Phone→node tests remain possible when Pi is down.

### Hand-checkable no-GPS SOS vector

source1, boot1, sequence1, HOP0/MAX5, event1789551200, user USR-A81F, request SOS-0001, name Riko, no GPS. Exactly63 bytes:

```text
524e0153010005000000000000000001000000016aaa6260000000000000000000000000ffff02080208045553522d41383146534f532d3030303152696b6f
RNM1,-103,5.75,Uk4BUwEABQAAAAAAAAAAAQAAAAFqqmJgAAAAAAAAAAAAAAAA//8CCAIIBFVTUi1BODFGU09TLTAwMDFSaWtv
```

Relay1 alters only byte5 from00→01. Gateway never increments this byte. Vector generated by Node Buffer during2A as layout arithmetic check, **not firmware interoperability proof**. 2B/2E must add independently encoded C++/Python vectors with negative coords, UUIDs, non-ASCII boundary names and GPS-SOS.

## 7. Database migration and server API

Keep `reports`, `node_status`, `service_state` and all rows. Back up live database via SQLite backup API (WAL-aware), run additive migration in transaction, record schema migration version; repeat init must be idempotent. Never DELETE/recreate legacy DB.

Proposed new tables:

- `mobile_users`: user_id TEXT PK, name TEXT display name, name_truncated INTEGER, name_timestamp INTEGER, created_at/updated_at REAL. Separate from login/auth identities. Use latest eligible message event/fix time to update name; no claim of verified identity.
- `mobile_requests`: request_id TEXT PK, user_id FK, kind L/S, wire_payload_digest TEXT, first_received_at REAL. Digest excludes source/session/sequence/hop/radio and includes exact decoded canonical logical mobile content. Full original HTTP name cannot be reconstructed from truncated wire name; use wire-level digest here, not node full-name HTTP digest.
- `user_locations`: id INTEGER PK, request_id TEXT UNIQUE FK mobile_requests, user_id FK, lat/lon REAL, accuracy REAL nullable, has_gps=1, fix_timestamp INTEGER, received_at REAL, src_node INTEGER, hop/max_hop INTEGER, boot_session TEXT, sequence INTEGER, rssi INTEGER, snr REAL.
- `mobile_sos`: id INTEGER PK, request_id TEXT UNIQUE FK mobile_requests, user_id FK, has_gps INTEGER, lat/lon/accuracy nullable, fix_timestamp nullable, event_timestamp INTEGER, received_at REAL, src_node/hop/max_hop, boot_session/sequence, rssi/snr, status TEXT defaultBARU, status_updated_at nullable. CHECK no-GPS has null coordinates/fix. CHECK status BARU/DITANGANI/SELESAI.
- `mobile_node_activity`: node_id PK, last_seen REAL, request_id TEXT, transport_id TEXT, hop/rssi/snr. Avoid forcing UUID into legacy node_status.last_pkt_id integer or pretending relay nodes were observed individually.

In one transaction: validate → insert/request conflict check → upsert user → insert L or S → update mobile node activity. Duplicate same logical wire content is no-op for incident/status/first_received_at. Same request ID different user/type/content is explicit conflict, leave original untouched, log and continue service. Do not blanket INSERT OR REPLACE incidents; that can reset handling status. Difference in route/RSSI is not payload conflict. Legacy pkt_id duplicates remain allowed.

Latest user position query unions valid GPS from locations and SOS, selects maximum **fix_timestamp**, not insertion ID. Tie order request_id lexical for deterministic results; do not rewrite old data. Index `(user_id,fix_timestamp DESC)` in both tables, SOS `(status,received_at DESC)`. Future fix >server time+300s flagged clock_suspect and excluded from latest-position selection; still preserve event/history, show warning. Stale age>120s; future/unknown time never presented as live. Equal timestamps from different request IDs stay separate history. Reset clock may need operator correction later; do not silently fake fix time.

New APIs following existing route style:

- GET `/api/users/locations?limit=200&offset=0`: `{items:[],total,limit,offset,server_time}`; maxlimit1000, validated nonnegative offset. Items include identity/truncated flag, latest fix, accuracy, received_at, source/hop/radio, stale/clock_suspect and last_seen from reception. User never claims Online.
- GET `/api/mobile-sos?status=BARU&limit=200&offset=0`: same pagination envelope, all SOS including noGPS and status. Include original event/fix and reception times.
- GET `/api/mobile-sos/<id>` detail; PATCH `/api/mobile-sos/<id>/status` JSON `{"status":"DITANGANI"}` same enum/error conventions as legacy. No route collision with legacy `/api/reports`.

Legacy stats/graphs remain legacy-labelled initially; add explicit mobile counters rather than silently changing old total semantics. `/api/nodes` may merge reception activity with explicit last_message_kind/last_request_id fields; do not overwrite legacy pkt_id field with a different data type. No auth added by this design; LAN/physical access and handling-status authorization remain deployment risks.

## 8. Dashboard and mobile alignment

Add separate mobile-users and mobile-SOS panels and typed marker IDs (`mobile-user:…`, `mobile-sos:…`, `legacy-report:…`). Preserve existing legacy modal/filter/status path. Escape names/IDs before HTML. Show smartphone location vs legacy node-origin report; no claim of actual relay route. ValidGPS-only markers, noGPS SOS prominent list entry, old fix visibly stale and separate received time. Coordinate-grid remains honestly labelled; basemap provider is out of scope of this checkpoint.

Poll new endpoints independently with allSettled so failure doesn't blank legacy panels. MobileSOS counts must include noGPS and items outside first page; noGPS must never be converted from null to0 by JS numeric coercion. UI includes via original Field Node, HOP, RSSI/SNR from last-hop Gateway reception.

App2G transport adapter normalizes queued old payloads to canonical contract preserving identity/event snapshot, validates ACK state/node_id, and maps internal DELIVERED to accepted by node. Retry409 validation conflict must be visible actionable failure with durable record retained (no silent deletion);503/429 timeout remain queued/backoff. Body schema upgrade does not require clearing installed app storage. Keep old service marker in ACK to support existing APK while newer APK rolls out.

## 9. Planned file changes AFTER approval

| Area | Existing files | New files proposed |
| --- | --- | --- |
| Field Node | `field_node/field_node.ino` routes, binary dispatch, queue seams, loop | `field_node/MobileApi.h`, `field_node/MobileQueue.h`, pinned sketch/build manifest |
| Shared firmware | — | `libraries/RescueNetProtocol/library.properties`, `src/RescueNetProtocol.h/.cpp`, host codec tests/vectors; install one local Arduino library for both sketches, no unsynchronised duplicate headers |
| Gateway | `gateway_node/gateway_node.ino` binary validation, mobile cache, prefixed serial | pinned sketch/build manifest |
| Serial/MQTT | `Resquenet-server/services/serial_bridge.py`, `services/mqtt_service.py`, `config.py` | `services/mobile_protocol.py` strict decoder/normalizer |
| Database/API | `Resquenet-server/services/database.py`, `routes/api.py`; `app.py` only if config wiring needed | `services/mobile_database.py` additive schema/query helpers |
| Dashboard | `Resquenet-server/templates/index.html`, `static/js/app.js`, `static/css/style.css` | focused frontend tests if needed |
| App | `Rescuenet-apk/src/models/index.ts`, `services/RescueNetApi.ts`, `services/NetworkMonitor.ts`, `services/OutboxService.ts`, `screens/HomeScreen.tsx`, `utils/location.ts`, `services/TrackingService.ts` as required by canonical outbound fields | `utils/mobileContract.ts`; schema/compatibility tests |
| Tests | existing server `tests/test_serial_parser.py`, `tests/test_api.py`; app `tests/api.test.ts`, `tests/location.test.ts`, `tests/queue.test.ts` | server mobile parser/DB/API tests, firmware HTTP/queue fixtures, cross-language golden vectors |
| Docs | app README/old Phase2 proposal; server README and tutorial | `docs/PHASE_2_TEST_PLAN.md`, firmware build/install instructions |

Preserve pre-existing dirty gateway edit and deleted old `server/*`, `docs/INSTRUKSI_IMPLEMENTASI.md`. Do not restore/delete/commit unrelated changes. No deployment/flashing or production DB migration without identifying target hardware and backups.

## 10. Checkpoints and validation gates

2A now: inspect/design only; internal review checks all field offsets sum43, maximum171, UUID reconstruction, alias compatibility, ACK/durable queue semantics, legacy discriminator, and logical/transport identity separation. No firmware/app/server changes or hardware test claimed.

2B: install/pin dependencies after approval, compile both relevant sketches with identified FQBN; phone→node /status, valid location, invalid latitude, GPS-SOS, noGPS-SOS, duplicate and409changedpayload,413oversize including streaming, wrong type, fullqueue/storagefail. API/queue tests must not require Pi. No placeholder acceptance followed by discarded SOS.

2C/D: C++ codec round-trip and shared Python vectors; node→Gateway HOP0, relay HOP1, MAX_HOP boundary, unknown versions, truncatedbinary/length mismatch, write truncation, TX timeout, power interruption journal recovery, queue budget and location coalescing. Compile Gateway too. All participating relays need upgraded firmware; old nodes only relay legacy.

2E: tests with temp SQLite, no physical Gateway dependency: (1) legacy ingestion unchanged; (2) mobilelocation; (3) mobileSOS GPS/noGPS; (4) duplicate through different nodes/reboots → one incident with unchanged handlingstatus; (5) out-of-order fix B then A → B remains latest; (6) malformed serial/MQTT cannot kill service; (7) migration twice preserves original rows; (8) conflict different owner; (9) future clock; (10) latest GPS from SOS; (11) paginated APIs and statuses.

2F: UI regression and noGPS-marker exclusion, stale labels, two timestamps, escaped Unicode/XSS names, separate legacy/mobile IDs, API failure isolation. 2G: current queued Fase1 payloads still accepted, node ACK not commandcenter, network drop/retry; run TypeScript/app tests/export.

Hardware acceptance scenarios required by request: T1 status; T2 validGPS; T3 invalidlat; T4 SOSGPS; T5 SOSnoGPS; T6 retrydedupe; T7 portallegacy; T8 physicalSOS; T9 directhop0; T10 relayhop1; T11 legacy→Pi; T12 location→Pi; T13 SOS→Pi; T14 singleincidentduplicate; T15 delayedlocation; T16 noGPSlist/no marker; T17 nodeacceptedwording. Record expected/observed/log/time per scenario, mark blocked/notrun honestly while Pi down. Unit success is not radio coverage proof.

Rollout: backup + server decoder first, Gateway second, all Field Nodes/relays third, aligned APK last (old app aliases supported). Do not emit mobile on an old-only relay path expecting success. Offline radio is lossy, no encryption/authentication/reverseACK; openAP accepts untrusted clients, need abuse/rate testing and operator limitations.

## 11. Review outcome / approvals needed

Additive boundaries are internally consistent; feasible for implementation **after 2A approval**, not claimed production-safe without compile/stress/hardware checks. Review specifically: bounded48-byte name may abbreviate long names; no guaranteed commandcenter delivery; finite node dedupe, bounded capacity, airtime-limited latency; SOS journal flash wear; old relay incompatibility for new frames. Stop here per requested checkpoint.

References for implementation constraints: [LoRa upstream source, payload cap/write and TX semantics](https://raw.githubusercontent.com/sandeepmistry/arduino-LoRa/master/src/LoRa.cpp), [ArduinoJson6 fixed-capacity StaticJsonDocument](https://arduinojson.org/v6/api/staticjsondocument/). Local installed core3.3.3 `WebServer/src/Parsing.cpp` was inspected for raw handler vs preallocated plain body; implementation must pin/test this core behavior.

## 12. Catatan implementasi Checkpoint 2B (tanpa perubahan kontrak)

2A telah disetujui melalui instruksi Checkpoint 2B. Implementasi 2B berhenti di
antrean mobile lokal; GETstatus menambahkan `mobile_tx_enabled:false`, hitungan
dan kapasitas antrean. Tidak ada encoder/TX/RX mobile, completion baru, atau
perubahan Gateway/Pi/APK/dashboard. Pending8SOS durable, location16RAM,
location-history64/30menit dipin, pembacaan completed-history32 disiapkan.
Penulisan completed/FIFO/release journal serta last-sent high-water membutuhkan
TX 2C; tidak membuat klaim completion sebelum radio benar-benar mengirim.

Core3.3.3 ternyata dapat memasuki parser multipart **sebelum** raw-body callback.
Untuk memenuhi batas body API yang sama, `MobileWebServer` melakukan bounded
preflight/nonblocking read untuk `/api` dan `/api/*` sebelum parser form/plain.
Header1536byte/max32, deadline header/body masing-masing2s; form legacy tetap
diterima parser asli dengan bytes tidak diubah lewat MSG_PEEK. Hal ini mengklarifikasi
mekanisme raw-bounded pada bagian2, bukan mengganti schema/ACK. Core tetap dipin;
header flood/slow-client/legacy stress harus dibuktikan di hardware.

Canonical dedupe **lokal HTTP, bukan codec LoRa/wire digest server** dibekukan:
JSON UTF8 compact, urutan key `kind,request_id,user_id,name,has_gps,lat_f64,lon_f64,
accuracy_f64,fix_timestamp,event_timestamp`. Tiga angka float valid direpresentasikan
sebagai string16digit hex lowercase bit IEEE754 binary64, bukan quantized e7/dm;
-0 menjadi+0, tanpa GPS/nullaccuracy menghasilkan null. Alias dihilangkan, nama
dinormalisasi, timestamp berupa integer (tanpa GPS fix0; lokasi event=fix).
JSON strings di-escape standar; transport/header tidak masuk hash. SHA25632byte.
Fixture `field_node/tests/canonical_vectors.json` dan C++/JavaScript independen
menguji equivalence alias/Unicode/zero serta precision yang tidak boleh lenyap.
Hash fixture dibekukan pada script test. Strict lexical pass memeriksa timestamp
pecahan sebelum konversi double; numeric values dikonversi strtod setelah syntax
valid agar fast-parser ArduinoJson6 tidak menggeser range boundaries/canonical bits.
Input tetap dibatasi1024byte; temporary heap libc perlu diuji di perangkat.

Journal `rn_mobile_b1` adalah blob lokal version/size/CRC, terikat ABI dan NODE_ID;
putBytes/commit+readback berhasil sebelum ACK. Mismatch/corruption/storage failure
fail closed, tanpa automatic erase. Upgrade layout perlu migration, tidak boleh
sekadar reset journal. Ordinarylocation/duplicateSOS tidak menulis flash. Lihat
`docs/CHECKPOINT_2B_TEST.md` untuk dependensi pinned, flash dan18 prosedur manual.

**Audit akhir 2B / gate belum selesai:** core3.3.3 startup ternyata melakukan
erase default NVS pada NO_FREE_PAGES/NEW_VERSION_FOUND sebelum setup. Namespace
journal saja tidak mencegahnya. CRC/fail-closed aplikasi tidak melindungi dari
penghapusan partisi sebelum restore. Compile/unit tests lulus, tetapi implementasi
dihentikan untuk review koreksi terkecil: partisi NVS journal terisolasi dengan
init failure fail-closed, tanpa erase. Layout flash/backup/migrasi perlu dikonfirmasi
sebelum perubahan; kontrak HTTP/LoRa tidak diganti. Bukti dan usulan di bagian10
`docs/CHECKPOINT_2B_TEST.md`; tidak lanjut ke 2C.

## 13. Implementasi 2B.1 — isolasi storage

Otorisasi2B.1 mengizinkan koreksi storage tersebut. Journal sekarang menginisialisasi
`rn_sos` secara eksplisit dan membuka `Preferences::begin("rn_mobile_b1", false,
"rn_sos")`. Tidak membaca/fallback journal default NVS, tidak autoerase/reformat
pada error. Readback memverifikasi CRC/version/size/byte equality dan SHA256 sebelum
ACK; storage fault tetap degraded/503 dengan kontrak2B yang sama. Lokasi tetapRAM.

Kandidat4MB disediakan pada `field_node/partition_candidates/rescuenet_4mb.csv`.
Setelah inspeksi fisik COM17 pada 2026-09-20, layout yang sama diaktifkan sebagai
`field_node/partitions.csv`: default NVS tetap pertama, OTA/apps/coredump tetap,
SPIFFS dikurangi32KiB untuk rn_sos. Dua backup fisik4MB cocok SHA-256; tabel
fisik cocok layout lama dan area SPIFFS snapshot kosong. Binary partisi dari
build baru cocok byte-for-byte dengan tabel aktif. Ini **belum** membuktikan
persistensi/radio hardware firmware baru; Codex tidak meng-upload perangkat.
Simpan backup dan review migrasi bila perangkat berubah setelah snapshot.
Hasil terperinci ada di `docs/CHECKPOINT_2B_1_STORAGE.md`; panduan manual final
di `docs/CHECKPOINT_2B_1_MANUAL_TEST.md`. Gate hardware tetap terbuka; 2C belum dimulai.
Profil build final setelah koreksi pengguna ialah **TTGO LoRa32-OLED V1 (No
TFCard)**, FQBN `esp32:esp32:ttgo-lora32`, bukan ESP32 Dev Module. Compile dan
binary partisi custom diuji ulang dengan core3.3.3; tidak ada upload oleh Codex.
