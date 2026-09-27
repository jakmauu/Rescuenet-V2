"""In-process MQTT subscriber that persists validated RescueNet messages."""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from pathlib import Path
from typing import Any

import config
from services import database
from services.serial_bridge import ReportValidationError, normalize_report
from services.mobile_wire import WireError, parse_ack

try:
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover - only on incomplete installations
    mqtt = None  # type: ignore[assignment]


LOGGER = logging.getLogger(__name__)


def _make_client(client_id: str):
    if mqtt is None:
        raise RuntimeError("paho-mqtt is not installed; run pip install -r requirements.txt")
    try:
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    except AttributeError:  # paho-mqtt 1.x
        return mqtt.Client(client_id=client_id)


def _reason_code(disconnect_flags_or_reason, reason_code=None) -> int:
    value = reason_code if reason_code is not None else disconnect_flags_or_reason
    try:
        return int(getattr(value, "value", value))
    except (TypeError, ValueError):
        return -1


class MQTTService:
    """Own the Flask process MQTT subscription and database ingestion callbacks."""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.client = _make_client("rescuenet-backend")
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        self._started = False
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        database.set_service_state(
            "mqtt",
            "connecting",
            {"host": config.MQTT_HOST, "port": config.MQTT_PORT},
            database_path=self.database_path,
        )
        try:
            self.client.connect_async(
                config.MQTT_HOST, config.MQTT_PORT, keepalive=config.MQTT_KEEPALIVE
            )
            self.client.loop_start()
            LOGGER.info("MQTT subscriber started for %s:%s", config.MQTT_HOST, config.MQTT_PORT)
        except Exception as exc:
            with self._lock:
                self._started = False
            database.set_service_state(
                "mqtt", "disconnected", {"error": str(exc)}, database_path=self.database_path
            )
            LOGGER.exception("Unable to start MQTT subscriber")

    def stop(self) -> None:
        with self._lock:
            if not self._started:
                return
            self._started = False
        try:
            self.client.disconnect()
        finally:
            self.client.loop_stop()

    def _on_connect(self, client, _userdata, _flags, reason_code, _properties=None) -> None:
        code = _reason_code(reason_code)
        if code != 0:
            database.set_service_state(
                "mqtt",
                "disconnected",
                {"reason_code": code},
                database_path=self.database_path,
            )
            LOGGER.error("MQTT connection rejected: %s", reason_code)
            return
        client.subscribe(
            [(config.MQTT_REPORT_TOPIC, 1), (config.MQTT_GATEWAY_STATUS_TOPIC, 1),
             (config.MQTT_MOBILE_EVENT_TOPIC, 1)]
        )
        database.set_service_state(
            "mqtt",
            "connected",
            {"host": config.MQTT_HOST, "port": config.MQTT_PORT},
            database_path=self.database_path,
        )
        LOGGER.info("MQTT connected and subscribed to RescueNet topics")

    def _on_disconnect(
        self,
        _client,
        _userdata,
        disconnect_flags_or_reason,
        reason_code=None,
        _properties=None,
    ) -> None:
        code = _reason_code(disconnect_flags_or_reason, reason_code)
        database.set_service_state(
            "mqtt",
            "disconnected",
            {"reason_code": code},
            database_path=self.database_path,
        )
        if code != 0:
            LOGGER.warning("MQTT disconnected; automatic reconnect is active (code=%s)", code)

    def _on_message(self, _client, _userdata, message) -> None:
        try:
            decoded = message.payload.decode("utf-8")
            payload = json.loads(decoded)
            if not isinstance(payload, dict):
                raise ValueError("payload must be a JSON object")
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            LOGGER.warning("Malformed MQTT JSON skipped on %s: %s", message.topic, exc)
            return

        if message.topic == config.MQTT_REPORT_TOPIC:
            self._handle_report(payload)
        elif message.topic == config.MQTT_GATEWAY_STATUS_TOPIC:
            self._handle_gateway_status(payload)
        elif message.topic == config.MQTT_MOBILE_EVENT_TOPIC:
            self._handle_mobile_event(payload)

    def _handle_mobile_event(self, payload: dict[str, Any]) -> None:
        try:
            key = parse_ack({"request_key": payload.get("request_key"), "status": "STORED"})
            if payload.get("event_type") not in ("SOS", "LOCATION"):
                raise WireError("invalid mobile event type")
            row_id, inserted = database.insert_mobile_event(payload, database_path=self.database_path)
            # Only a committed insert OR confirmed duplicate may produce STORED.
            ack = json.dumps({"request_key": key, "status": "STORED"}, separators=(",", ":"))
            result = self.client.publish(config.MQTT_MOBILE_ACK_TOPIC, ack, qos=1, retain=False)
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                LOGGER.warning("STORED ACK publish failed for request=%s rc=%s", key, result.rc)
            LOGGER.info("Mobile %s id=%s request=%s", "inserted" if inserted else "duplicate", row_id, key)
        except (WireError, ValueError, TypeError, KeyError, OverflowError) as exc:
            LOGGER.warning("Invalid mobile event skipped: %s", exc)
        except Exception:
            LOGGER.exception("Database failure while storing mobile event; no ACK")

    def _handle_report(self, payload: dict[str, Any]) -> None:
        try:
            report = normalize_report(payload)
            database.insert_report(report, database_path=self.database_path)
        except (ReportValidationError, KeyError, TypeError, ValueError) as exc:
            LOGGER.warning("Invalid MQTT report skipped: %s", exc)
        except Exception:
            LOGGER.exception("Database failure while storing MQTT report")

    def _handle_gateway_status(self, payload: dict[str, Any]) -> None:
        serial_connected = payload.get("serial_connected") is True
        gateway_ready = payload.get("gateway_ready") is True
        if gateway_ready and serial_connected:
            status = "ready"
        elif serial_connected:
            status = "connected"
        else:
            status = "disconnected"

        details = {
            "serial_connected": serial_connected,
            "gateway_ready": gateway_ready,
            "last_packet_at": _safe_timestamp(payload.get("last_packet_at")),
            "serial_port": str(payload["serial_port"]) if payload.get("serial_port") else None,
        }
        updated_at = _safe_timestamp(payload.get("updated_at")) or time.time()
        try:
            database.set_service_state(
                "gateway_serial",
                status,
                details,
                updated_at=updated_at,
                database_path=self.database_path,
            )
        except Exception:
            LOGGER.exception("Database failure while updating Gateway state")


def _safe_timestamp(value: Any) -> float | None:
    try:
        timestamp = float(value)
        return timestamp if math.isfinite(timestamp) and timestamp > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None
