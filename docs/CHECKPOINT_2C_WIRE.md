# RescueNet 2C application wire protocol (draft pending firmware build)

All radio application frames are **at most 100 bytes** and are passed as LoRaMesher application data, not raw LoRa packets. LoRaMesher 1.0.0 `DataHeader` adds 10 bytes, so the largest RescueNet DATA frame is **110 bytes**, below the configured SF9/BW125 packet limit of 115 bytes. Integers in RescueNet application frames are big-endian (LoRaMesher's own header has its own format). CRC16-CCITT-FALSE uses polynomial `0x1021`, init `0xffff`, no reflection or final XOR; the final two bytes cover all preceding application bytes. RadioLib radio CRC is also enabled. These are application frames, not C/C++ struct dumps.

## RNM1 mobile event

| Offset | Bytes | Meaning |
|---:|---:|---|
| 0 | 4 | ASCII `RNM1` |
| 4 | 1 | kind: `1=LOCATION`, `2=SOS` |
| 5 | 1 | flags: bit0 GPS, bit1 accuracy known, bit2 name truncated |
| 6 | 1 | source `NODE_ID` (1–15) |
| 7 | 16 | first 16 bytes of the existing canonical-message SHA-256 digest; stable request key |
| 23 | 8 | first 8 bytes of SHA-256 of UTF-8 `user_id` |
| 31 | 4 | event Unix time, seconds |
| 35 | 4 | fix Unix time, seconds; zero if no GPS |
| 39 | 4 | signed latitude × 1,000,000; zero if no GPS |
| 43 | 4 | signed longitude × 1,000,000; zero if no GPS |
| 47 | 2 | accuracy in 0.1 m; `0xffff` if unknown |
| 49 | 1 | UTF-8 name byte count, 1–48 |
| 50 | variable | complete UTF-8 codepoints only; full HTTP name remains in Field journal |
| end | 2 | CRC16 |

Length is `52 + name_bytes`, so maximum **100**. The request key is computed by Field from `Message.digest` and never recomputed from truncated radio fields. The `user_id` is not transmitted in full. Server stores `user_key`. Location coalescing and out-of-order rejection remain Field-side.

## RNL1 portal/physical SOS

| Offset | Bytes | Meaning |
|---:|---:|---|
| 0 | 4 | ASCII `RNL1` |
| 4 | 2 | legacy packet ID |
| 6 | 1 | source `NODE_ID` |
| 7 | 1 | flags: bit0 GPS, bit1 SOS |
| 8 | 1 | victim count |
| 9 | 4 | latitude microdegrees |
| 13 | 4 | longitude microdegrees |
| 17 | 1 | condition byte length (1–10) |
| 18 | 1 | message byte length (0–70) |
| 19 | variable | condition UTF-8 bytes, then message UTF-8 bytes |
| end | 2 | CRC16 |

Length is `21 + condition_bytes + message_bytes`, capped at **100**. The Field shortens only the message if the combined lengths would exceed 100, on a UTF-8 boundary. Gateway reconstructs the legacy 13-field USB CSV; direct radio/mesh forwarding replaces the old manual flood. `RouteEntry.hop_count=1` denotes a direct neighbor in LoRaMesher 1.0.0; Gateway outputs legacy `HOP=hop_count-1` (relay count), hence direct=0. If no valid route exists, the Gateway drops a legacy report rather than inventing a hop value. The mesh callback does not expose true RSSI/SNR, so serial emits `-,-` and server stores `NULL` for those metrics.

## RNA1 server-storage ACK

`RNA1` (4 bytes), status `1=STORED` (1 byte), 16-byte request key, CRC16 (2 bytes): **23 bytes**. No Gateway-receipt ACK may clear the Field SOS journal. Field accepts a matching ACK from the discovered Gateway and writes a durable completed marker before deleting its pending SOS record. Gateway retains the key-to-source map for retries; if it reboots, Field retries the event, server recognizes the duplicate and re-emits STORED.

USB serial event: `RNM1,<32 lowercase hex key>,<mesh source decimal>,<mesh hop count or ->,<lowercase payload hex>\n` at 115200 baud. Pi-to-Gateway: `RNACK1,<32 lowercase hex key>,STORED\n`. No unescaped name is placed in the serial envelope.

MQTT event topic: `rescuenet/mobile/events`; ACK topic: `rescuenet/mobile/ack`. Both QoS1, no retain. Legacy topic remains `rescuenet/reports`.

## Golden vectors

These vectors use request key `00112233445566778899aabbccddeeff`, user key `0123456789abcdef`, source node 1, `Riko`, event time `1700000000`; GPS uses fix time `1699999999`, latitude `-6.364821`, longitude `106.828913`, accuracy `6.8 m`.

```text
LOCATION_GPS  524e4d3101030100112233445566778899aabbccddeeff0123456789abcdef6553f1006553f0ffff9ee16b065e147100440452696b6fb4c2
SOS_GPS       524e4d3102030100112233445566778899aabbccddeeff0123456789abcdef6553f1006553f0ffff9ee16b065e147100440452696b6f8258
SOS_NO_GPS    524e4d3102000100112233445566778899aabbccddeeff0123456789abcdef6553f100000000000000000000000000ffff0452696b6f7b18
LEGACY        524e4c311001010101ff9ee16b065e1471060d534544414e4752696b6f7c476564756e6720416742
LEGACY_SOS    524e4c311002010301ff9ee16b065e147106034b5249544953534f53726e
STORED_ACK    524e41310100112233445566778899aabbccddeeff4e01
```

The mirrored `field_node/RescueNetWire.h` and `gateway_node/RescueNetWire.h` must have identical SHA-256 hashes. Golden vectors are not hardware proof; generated firmware and physical testing are still required.
