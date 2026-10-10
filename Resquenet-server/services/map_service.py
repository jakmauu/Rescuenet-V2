"""Build a truthful, latest-position snapshot for the RescueNet map."""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any

from services import database


CRITICAL_CONDITIONS = frozenset({"KRITIS", "CRITICAL", "DARURAT", "EMERGENCY"})


def _valid_coordinate(lat: Any, lon: Any) -> bool:
    try:
        latitude = float(lat)
        longitude = float(lon)
    except (TypeError, ValueError):
        return False
    return (
        math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    )


def _timestamp(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return fallback
    return parsed if math.isfinite(parsed) and parsed >= 0 else fallback


def _freshness(age_seconds: int, recent_seconds: int, stale_seconds: int) -> str:
    if age_seconds <= recent_seconds:
        return "recent"
    if age_seconds <= stale_seconds:
        return "stale"
    return "offline"


def _haversine_meters(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    radius = 6_371_000.0
    phi_a = math.radians(lat_a)
    phi_b = math.radians(lat_b)
    delta_phi = math.radians(lat_b - lat_a)
    delta_lambda = math.radians(lon_b - lon_a)
    value = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi_a) * math.cos(phi_b) * math.sin(delta_lambda / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def _latest_rows(database_path: str | Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return one latest valid GPS row for every field node and mobile user."""

    with database.connection(database_path) as conn:
        field_rows = conn.execute(
            """
            SELECT r.*
            FROM reports AS r
            WHERE r.has_gps = 1
              AND r.lat BETWEEN -90 AND 90
              AND r.lon BETWEEN -180 AND 180
              AND r.id = (
                  SELECT r2.id
                  FROM reports AS r2
                  WHERE r2.src_id = r.src_id
                    AND r2.has_gps = 1
                    AND r2.lat BETWEEN -90 AND 90
                    AND r2.lon BETWEEN -180 AND 180
                  ORDER BY r2.received_at DESC, r2.id DESC
                  LIMIT 1
              )
            ORDER BY r.src_id
            """
        ).fetchall()
        mobile_rows = conn.execute(
            """
            SELECT m.*
            FROM mobile_events AS m
            WHERE m.has_gps = 1
              AND m.lat BETWEEN -90 AND 90
              AND m.lon BETWEEN -180 AND 180
              AND m.id = (
                  SELECT m2.id
                  FROM mobile_events AS m2
                  WHERE m2.user_key = m.user_key
                    AND m2.has_gps = 1
                    AND m2.lat BETWEEN -90 AND 90
                    AND m2.lon BETWEEN -180 AND 180
                  ORDER BY CASE
                             WHEN CAST(COALESCE(m2.fix_timestamp, m2.event_timestamp) AS REAL) <= 0
                               OR CAST(COALESCE(m2.fix_timestamp, m2.event_timestamp) AS REAL)
                                  > CAST(m2.received_at AS REAL) + 300
                             THEN CAST(m2.received_at AS REAL)
                             ELSE CAST(COALESCE(m2.fix_timestamp, m2.event_timestamp) AS REAL)
                           END DESC,
                           m2.received_at DESC, m2.id DESC
                  LIMIT 1
              )
            ORDER BY m.name COLLATE NOCASE, m.user_key
            """
        ).fetchall()
    return [dict(row) for row in field_rows], [dict(row) for row in mobile_rows]


def get_map_snapshot(
    *,
    database_path: str | Path,
    recent_seconds: int,
    stale_seconds: int,
    gateway_lat: float | None = None,
    gateway_lon: float | None = None,
    gateway_label: str = "RescueNet Gateway",
    now: float | None = None,
) -> dict[str, Any]:
    """Return map markers and relationships using only stored observations."""

    recent_seconds = max(1, int(recent_seconds))
    stale_seconds = max(recent_seconds, int(stale_seconds))
    generated_at = float(time.time() if now is None else now)
    field_rows, mobile_rows = _latest_rows(database_path)
    positions: list[dict[str, Any]] = []
    field_positions: dict[int, dict[str, Any]] = {}

    for row in field_rows:
        if not _valid_coordinate(row.get("lat"), row.get("lon")):
            continue
        received_at = _timestamp(row.get("received_at"))
        updated_at = received_at
        seconds_ago = max(0, int(generated_at - updated_at))
        node_id = int(row["src_id"])
        critical = int(row.get("sos") or 0) == 1 or str(
            row.get("kondisi") or ""
        ).upper() in CRITICAL_CONDITIONS
        item = {
            "id": f"field:{node_id}",
            "type": "field_node",
            "label": f"Field Node {node_id}",
            "node_id": node_id,
            "lat": float(row["lat"]),
            "lon": float(row["lon"]),
            "updated_at": updated_at,
            "seconds_ago": seconds_ago,
            "freshness": _freshness(seconds_ago, recent_seconds, stale_seconds),
            "critical": critical,
            "report_id": int(row["id"]),
            "packet_id": row.get("pkt_id"),
            "condition": row.get("kondisi"),
            "message": row.get("pesan"),
            "hop": row.get("hop"),
            "rssi": row.get("rssi"),
            "snr": row.get("snr"),
        }
        positions.append(item)
        field_positions[node_id] = item

    for row in mobile_rows:
        if not _valid_coordinate(row.get("lat"), row.get("lon")):
            continue
        # A delayed LoRa packet must not make an old phone fix appear newest.
        received_at = _timestamp(row.get("received_at"))
        fix_timestamp = _timestamp(
            row.get("fix_timestamp") or row.get("event_timestamp"), received_at
        )
        # Phone clocks can be wrong. Bound future client time to server receipt
        # so it cannot produce a future timestamp or appear newer indefinitely.
        if fix_timestamp > received_at + 300:
            fix_timestamp = received_at
        fix_timestamp = min(fix_timestamp, generated_at)
        updated_at = fix_timestamp
        seconds_ago = max(0, int(generated_at - updated_at))
        try:
            source_node = int(row["source_node"])
        except (TypeError, ValueError, OverflowError):
            continue
        accuracy = _timestamp(row.get("accuracy"), -1.0)
        if accuracy < 0 or accuracy > 10_000:
            accuracy = None
        item = {
            "id": f"mobile:{row['user_key']}",
            "type": "mobile_user",
            "label": str(row.get("name") or "Mobile User"),
            "user_key": str(row["user_key"]),
            "lat": float(row["lat"]),
            "lon": float(row["lon"]),
            "accuracy": accuracy,
            "updated_at": updated_at,
            "fix_timestamp": fix_timestamp,
            "received_at": received_at,
            "seconds_ago": seconds_ago,
            "received_seconds_ago": max(0, int(generated_at - received_at)),
            "freshness": _freshness(seconds_ago, recent_seconds, stale_seconds),
            "critical": str(row.get("event_type") or "").upper() == "SOS",
            "event_type": row.get("event_type"),
            "source_node": source_node,
            "mesh_source": row.get("mesh_source"),
            "mesh_hops": row.get("mesh_hops"),
            "delivery_state": row.get("delivery_state"),
        }
        source = field_positions.get(source_node)
        if source is not None:
            item["distance_to_source_m"] = round(
                _haversine_meters(
                    item["lat"], item["lon"], source["lat"], source["lon"]
                ),
                1,
            )
        positions.append(item)

    if gateway_lat is not None and gateway_lon is not None:
        if not _valid_coordinate(gateway_lat, gateway_lon):
            raise ValueError("Gateway map coordinates are outside valid bounds")
        positions.append(
            {
                "id": "gateway",
                "type": "gateway",
                "label": gateway_label,
                "lat": float(gateway_lat),
                "lon": float(gateway_lon),
                "updated_at": generated_at,
                "seconds_ago": 0,
                "freshness": "recent",
                "critical": False,
                "configured": True,
            }
        )

    links: list[dict[str, Any]] = []
    for position in positions:
        if position["type"] != "mobile_user":
            continue
        source = field_positions.get(int(position["source_node"]))
        if source is None:
            continue
        links.append(
            {
                "from_id": position["id"],
                "to_id": source["id"],
                "kind": "mobile_to_field",
                "distance_m": position.get("distance_to_source_m"),
            }
        )

    counts = {
        "total": len(positions),
        "recent": sum(item["freshness"] == "recent" for item in positions),
        "stale": sum(item["freshness"] == "stale" for item in positions),
        "offline": sum(item["freshness"] == "offline" for item in positions),
        "critical": sum(bool(item["critical"]) for item in positions),
        "field_nodes": sum(item["type"] == "field_node" for item in positions),
        "mobile_users": sum(item["type"] == "mobile_user" for item in positions),
        "gateways": sum(item["type"] == "gateway" for item in positions),
    }
    return {
        "generated_at": generated_at,
        "recent_threshold_seconds": recent_seconds,
        "stale_threshold_seconds": stale_seconds,
        "positions": positions,
        "links": links,
        "counts": counts,
    }
