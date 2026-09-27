"""Central configuration for the RescueNet Raspberry Pi server."""

from __future__ import annotations

import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc


def _env_optional_float(name: str) -> float | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc


HOST = os.getenv("RESCUENET_HOST", "0.0.0.0")
PORT = _env_int("RESCUENET_PORT", 5000)

DATABASE_PATH = Path(
    os.getenv("RESCUENET_DATABASE", str(BASE_DIR / "rescuenet.db"))
).expanduser().resolve()

MQTT_HOST = os.getenv("RESCUENET_MQTT_HOST", "127.0.0.1")
MQTT_PORT = _env_int("RESCUENET_MQTT_PORT", 1883)
MQTT_KEEPALIVE = _env_int("RESCUENET_MQTT_KEEPALIVE", 60)
MQTT_REPORT_TOPIC = "rescuenet/reports"
MQTT_GATEWAY_STATUS_TOPIC = "rescuenet/status/gateway"
MQTT_MOBILE_EVENT_TOPIC = "rescuenet/mobile/events"
MQTT_MOBILE_ACK_TOPIC = "rescuenet/mobile/ack"

# An empty value enables stable-path discovery in services.serial_bridge.
SERIAL_PORT = os.getenv("RESCUENET_SERIAL_PORT") or None
SERIAL_BAUD = _env_int("RESCUENET_SERIAL_BAUD", 115200)
SERIAL_RECONNECT_SECONDS = _env_float("RESCUENET_SERIAL_RECONNECT_SECONDS", 5.0)

NODE_ACTIVE_THRESHOLD_SECONDS = _env_int(
    "RESCUENET_NODE_ACTIVE_THRESHOLD_SECONDS", 300
)

# The browser loads Leaflet and map tiles over the Raspberry Pi's internet
# connection. Position data itself always comes from the local RescueNet API.
MAP_TILE_URL = os.getenv(
    "RESCUENET_MAP_TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
)
MAP_DEFAULT_LAT = _env_float("RESCUENET_MAP_DEFAULT_LAT", -6.2000)
MAP_DEFAULT_LON = _env_float("RESCUENET_MAP_DEFAULT_LON", 106.8167)
MAP_DEFAULT_ZOOM = _env_int("RESCUENET_MAP_DEFAULT_ZOOM", 13)
MAP_RECENT_SECONDS = _env_int("RESCUENET_MAP_RECENT_SECONDS", 30)
MAP_STALE_SECONDS = _env_int("RESCUENET_MAP_STALE_SECONDS", 300)
MAP_GATEWAY_LAT = _env_optional_float("RESCUENET_MAP_GATEWAY_LAT")
MAP_GATEWAY_LON = _env_optional_float("RESCUENET_MAP_GATEWAY_LON")
MAP_GATEWAY_LABEL = os.getenv("RESCUENET_MAP_GATEWAY_LABEL", "RescueNet Gateway")
LOG_LEVEL = os.getenv("RESCUENET_LOG_LEVEL", "INFO").upper()
