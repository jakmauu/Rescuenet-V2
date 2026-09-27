"""RescueNet 2C binary mesh protocol and unambiguous USB serial envelope.

Multi-byte integers are big-endian. Coordinates are signed degrees * 1e6.
No C struct layout or raw comma-containing user text is transmitted.
"""

from __future__ import annotations

import hashlib
import re
import struct
import time
from typing import Any

MAX_PAYLOAD = 100
MAX_NAME_BYTES = 48
_HEX32 = re.compile(r"^[0-9a-f]{32}$")


class WireError(ValueError):
    pass


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def request_key(canonical_message: bytes) -> str:
    return hashlib.sha256(canonical_message).digest()[:16].hex()


def _check_crc(data: bytes) -> bytes:
    if len(data) < 6 or crc16(data[:-2]) != int.from_bytes(data[-2:], "big"):
        raise WireError("invalid CRC")
    return data[:-2]


def decode_mobile(data: bytes) -> dict[str, Any]:
    if len(data) > MAX_PAYLOAD or len(data) < 53:
        raise WireError("invalid mobile frame length")
    body = _check_crc(data)
    if body[:4] != b"RNM1":
        raise WireError("unknown mobile version")
    kind, flags, node = body[4:7]
    if kind not in (1, 2) or flags & ~0x07 or not 1 <= node <= 15:
        raise WireError("invalid mobile kind/flags/source")
    name_length = body[49]
    if name_length > MAX_NAME_BYTES or len(body) != 50 + name_length:
        raise WireError("invalid mobile name length")
    try:
        name = body[50:].decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise WireError("invalid UTF-8 name") from exc
    if not name:
        raise WireError("empty name")
    event_time, fix_time, lat_e6, lon_e6, accuracy_dm = struct.unpack(">IIiiH", body[31:49])
    has_gps = bool(flags & 1)
    if kind == 1 and not has_gps:
        raise WireError("location requires GPS")
    if event_time == 0 or (has_gps and (fix_time == 0 or not -90_000_000 <= lat_e6 <= 90_000_000 or not -180_000_000 <= lon_e6 <= 180_000_000)):
        raise WireError("invalid timestamp/coordinates")
    if not has_gps and (fix_time or lat_e6 or lon_e6 or accuracy_dm != 0xFFFF):
        raise WireError("unexpected GPS fields")
    if not has_gps and flags & 2:
        raise WireError("accuracy flag without GPS")
    if not flags & 2 and accuracy_dm != 0xFFFF:
        raise WireError("unexpected accuracy")
    if flags & 2 and accuracy_dm == 0xFFFF:
        raise WireError("missing accuracy")
    return {
        "request_key": body[7:23].hex(),
        "event_type": "SOS" if kind == 2 else "LOCATION",
        "source_node": node,
        "user_key": body[23:31].hex(),
        "name": name,
        "name_truncated": bool(flags & 4),
        "has_gps": has_gps,
        "lat": lat_e6 / 1_000_000 if has_gps else None,
        "lon": lon_e6 / 1_000_000 if has_gps else None,
        "accuracy": accuracy_dm / 10 if has_gps and flags & 2 else None,
        "event_timestamp": event_time,
        "fix_timestamp": fix_time if has_gps else None,
    }


def parse_mobile_serial(line: str, *, received_at: float | None = None) -> dict[str, Any]:
    parts = line.strip().split(",")
    if len(parts) != 5 or parts[0] != "RNM1":
        raise WireError("invalid mobile serial envelope")
    key, mesh_source_s, hops_s, payload_hex = parts[1:]
    if not _HEX32.fullmatch(key) or len(payload_hex) > MAX_PAYLOAD * 2 or len(payload_hex) % 2:
        raise WireError("invalid mobile serial key/payload")
    try:
        mesh_source = int(mesh_source_s)
        hops = int(hops_s) if hops_s != "-" else None
        payload = bytes.fromhex(payload_hex)
    except ValueError as exc:
        raise WireError("invalid mobile serial number/hex") from exc
    if not 1 <= mesh_source <= 65535 or (hops is not None and not 1 <= hops <= 20):
        raise WireError("invalid mesh source/hops")
    event = decode_mobile(payload)
    if event["request_key"] != key:
        raise WireError("request key mismatch")
    event.update(mesh_source=mesh_source, mesh_hops=hops, rssi=None, snr=None,
                 received_at=received_at if received_at is not None else time.time())
    return event


def parse_ack(payload: dict[str, Any]) -> str:
    key = payload.get("request_key")
    if payload.get("status") != "STORED" or not isinstance(key, str) or not _HEX32.fullmatch(key):
        raise WireError("invalid STORED ACK")
    return key


def ack_serial_line(request_key_hex: str) -> bytes:
    if not _HEX32.fullmatch(request_key_hex):
        raise WireError("invalid request key")
    return f"RNACK1,{request_key_hex},STORED\n".encode("ascii")
