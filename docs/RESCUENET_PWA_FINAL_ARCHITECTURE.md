# RescueNet V2 PWA — Final Architecture

## Application flow

```text
First launch: Welcome → local profile → Wi-Fi guide → API check → optional GPS permission
Later launch: restore local profile/consent → check node → resume one foreground watcher if sharing is enabled
Main tabs: Beranda | Peta | Status | Profil
SOS path: create stable request ID → persist local event → POST to Field Node → accept only matching Field Node ACK
Location path: consent → one watchPosition → validate fix → coalesce latest → one pending packet → bounded retry → Field Node ACK
```

Profile data lives in localStorage. `user_id` is stable across profile edits and is not an authentication credential. Consent and the user's explicit tracking-enabled choice are separate values. Reset is confirmed and only removes local data; it cannot revoke data already queued or stored downstream. Role/team remain local profile metadata and are intentionally not added to the existing mobile wire payload; carrying them to the dashboard requires a separately reviewed backend/protocol change.

## Connection state boundaries

- `GET /api/status` validates service/API version/device/node identity.
- `FIELD_CONNECTED` means the current status says ready and mobile TX enabled.
- A valid but degraded API is shown as API reachable / node not ready.
- `mesh_started`, `mesh_synchronized`, `gateway_found`, pending counts, and route count are shown as separate status facts.
- PWA has no evidence that Gateway forwarded a packet, that Flask/SQLite committed it, or that an operator read it. Those are not inferred from HTTP 202.

## Location scheduler

`location-scheduler.mjs` owns the latest GPS candidate, pending packet, in-flight guard, retry timer, and last accepted fix. A fresh candidate may replace only the candidate, never the request ID/backoff for an already pending packet. When an old request completes, an eligible newer candidate is scheduled separately; the old ACK cannot clear it. Retry is exponential (5, 10, 20, 40, then 80 seconds), capped at five total attempts; stale packets older than two minutes are discarded. The default stationary interval is 120 seconds, with 30/60/120-second choices. A 60-second minimum send spacing also applies to movement-triggered updates to protect the LoRa link.

Tracking is foreground-only. Hide/pagehide clears the GPS watcher and stationary timer. Returning foreground revalidates the node and resumes only when the stored user setting and consent still allow it. Pending local data remains retryable unless the user explicitly stops sharing, which clears pending location state.

## SOS behavior

The PWA retains a bounded list of ten events in browser storage. It persists before attempting network delivery, uses the same `request_id` / `Idempotency-Key` on retry, supports no-GPS SOS, and keeps unresolved events rather than silently replacing them. The screen distinguishes pending/unknown and Field Node accepted. Browser storage can be evicted or fail; it is not a hardware durable journal. New SOS remains independent from location transmission.

## Dashboard and time handling

The dashboard's existing map API uses `mobile_events` and stable `user_key`, returning latest valid mobile user position, source node, accuracy, fix time, server receipt time and freshness. Delayed fixes do not supersede a newer fix. A client fix more than 300 seconds later than its server receipt is treated as a clock error; malformed/negative timestamps fall back to server receipt for rendering. The map query orders far-future values by receipt time and the response bounds displayed fix time. No PWA payload/schema change is required. A clock that is behind server time is ambiguous with a delayed mesh packet; the server retains that client fix time and displays it as stale rather than inventing a capture time.

Field-node GPS, mobile GPS, SOS report coordinates and configured Gateway position remain different marker types. The PWA's own map screen intentionally shows exact local coordinates and accuracy without loading external map tiles; the user can explicitly open Apple Maps.

## Offline/security model

Service worker caches a versioned static shell including the scheduler dependency and logo. API calls are never served from cache. Identity, location, and SOS local records contain sensitive data and are stored only on device by the PWA; do not treat user IDs as access control. Dashboard API access control/network exposure remains a deployment/security concern and must be reviewed before operational public exposure.

## iOS architecture boundary

Production hosting should be a trusted HTTPS origin for Geolocation and service workers. The Field Node currently exposes a private HTTP origin. Safari may block HTTPS-to-HTTP private-network calls; CORS alone is not a fix for mixed-content/local-network policy. WebKit's mixed-content rules have continued to evolve: its LNA-related fix was committed to WebKit main in September 2026, but that does not establish which iOS/Safari release contains it. Browser errors do not consistently identify a single cause, so an iPhone test on the actual target iOS version remains required. Apple documents that iOS suspends most background apps; reliable background/locked-screen location requires a native iOS client configured for Core Location background updates, not a service worker. References: [WebKit mixed-content/LNA change](https://bugs.webkit.org/show_bug.cgi?id=297739), [Apple background location guidance](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background).
