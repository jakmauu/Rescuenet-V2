"""USB Serial to local MQTT bridge for the RescueNet T-Beam Gateway."""

from __future__ import annotations

import argparse
import glob
import json
import logging
import math
import queue
import signal
import threading
import time
from pathlib import Path
from typing import Any, Mapping

import config
from services.mobile_wire import WireError, ack_serial_line, parse_ack, parse_mobile_serial

try:  # Import errors are reported clearly when the independently run bridge starts.
    import serial
    from serial import SerialException
except ImportError:  # pragma: no cover - exercised only on an incomplete installation
    serial = None  # type: ignore[assignment]

    class SerialException(Exception):
        """Fallback exception while pyserial is unavailable."""


try:
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover - exercised only on an incomplete installation
    mqtt = None  # type: ignore[assignment]


LOGGER = logging.getLogger(__name__)

FIRMWARE_INFO_PREFIXES = (
    "OLED terdeteksi",
    "OLED tidak terdeteksi",
    "PMU AXP2101 siap",
    "PMU AXP2101 GAGAL",
    "LoRa init GAGAL",
)


class ReportValidationError(ValueError):
    """Raised when a serial or MQTT report violates the Gateway contract."""


def _strict_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ReportValidationError(f"{field} must be an integer")
    if isinstance(value, float) and not value.is_integer():
        raise ReportValidationError(f"{field} must be an integer")
    try:
        converted = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ReportValidationError(f"{field} must be an integer") from exc
    # int('1.0') already fails, while JSON float 1.0 is intentionally accepted.
    return converted


def _finite_float(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ReportValidationError(f"{field} must be a number")
    try:
        converted = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ReportValidationError(f"{field} must be a number") from exc
    if not math.isfinite(converted):
        raise ReportValidationError(f"{field} must be finite")
    return converted


def normalize_report(
    values: Mapping[str, Any], *, received_at: float | None = None
) -> dict[str, Any]:
    """Coerce and validate a report received from serial or MQTT."""

    required = {
        "rssi",
        "snr",
        "pkt_id",
        "src_id",
        "hop",
        "max_hop",
        "lat",
        "lon",
        "has_gps",
        "kondisi",
        "jumlah",
        "sos",
        "pesan",
    }
    missing = sorted(required.difference(values.keys()))
    if missing:
        raise ReportValidationError(f"missing fields: {', '.join(missing)}")

    kondisi = values["kondisi"]
    pesan = values["pesan"]
    if not isinstance(kondisi, str) or not isinstance(pesan, str):
        raise ReportValidationError("kondisi and pesan must be strings")

    report = {
        "rssi": None if values["rssi"] in (None, "-") else _strict_int(values["rssi"], "rssi"),
        "snr": None if values["snr"] in (None, "-") else _finite_float(values["snr"], "snr"),
        "pkt_id": _strict_int(values["pkt_id"], "pkt_id"),
        "src_id": _strict_int(values["src_id"], "src_id"),
        "hop": _strict_int(values["hop"], "hop"),
        "max_hop": _strict_int(values["max_hop"], "max_hop"),
        "lat": _finite_float(values["lat"], "lat"),
        "lon": _finite_float(values["lon"], "lon"),
        "has_gps": _strict_int(values["has_gps"], "has_gps"),
        "kondisi": kondisi.strip(),
        "jumlah": _strict_int(values["jumlah"], "jumlah"),
        "sos": _strict_int(values["sos"], "sos"),
        "pesan": pesan.strip(),
    }

    if report["pkt_id"] <= 0:
        raise ReportValidationError("pkt_id must be greater than zero")
    if report["src_id"] <= 0:
        raise ReportValidationError("src_id must be greater than zero")
    if report["hop"] < 0:
        raise ReportValidationError("hop must be non-negative")
    if not 0 <= report["max_hop"] <= 20:
        raise ReportValidationError("max_hop must be between 0 and 20")
    if report["has_gps"] not in (0, 1):
        raise ReportValidationError("has_gps must be 0 or 1")
    if report["sos"] not in (0, 1):
        raise ReportValidationError("sos must be 0 or 1")
    if report["jumlah"] < 0:
        raise ReportValidationError("jumlah must be non-negative")
    if report["has_gps"] == 1:
        if not -90 <= report["lat"] <= 90:
            raise ReportValidationError("latitude is outside -90..90")
        if not -180 <= report["lon"] <= 180:
            raise ReportValidationError("longitude is outside -180..180")

    timestamp_source = (
        received_at if received_at is not None else values.get("received_at", time.time())
    )
    timestamp = _finite_float(timestamp_source, "received_at")
    if timestamp <= 0:
        raise ReportValidationError("received_at must be greater than zero")
    report["received_at"] = timestamp
    return report


def parse_report_line(line: str, *, received_at: float | None = None) -> dict[str, Any]:
    """Parse the 13-field Gateway record while preserving commas in PESAN."""

    parts = line.strip().split(",", 12)
    if len(parts) != 13:
        raise ReportValidationError(f"expected 13 fields, received {len(parts)}")
    names = (
        "rssi",
        "snr",
        "pkt_id",
        "src_id",
        "hop",
        "max_hop",
        "lat",
        "lon",
        "has_gps",
        "kondisi",
        "jumlah",
        "sos",
        "pesan",
    )
    return normalize_report(dict(zip(names, parts)), received_at=received_at)


def classify_serial_line(
    line: str, *, received_at: float | None = None
) -> tuple[str, dict[str, Any] | str | None]:
    """Classify Gateway output as empty, ready, firmware log, report, or invalid."""

    cleaned = line.strip("\r\n ")
    if not cleaned:
        return "empty", None
    if cleaned == "GATEWAY_READY":
        return "ready", cleaned
    if cleaned.startswith("[DROP]"):
        return "drop", cleaned
    if cleaned.startswith(FIRMWARE_INFO_PREFIXES):
        return "firmware", cleaned
    if cleaned.startswith("["):
        return "firmware", cleaned
    if cleaned.startswith("RNM1,"):
        try:
            return "mobile", parse_mobile_serial(cleaned, received_at=received_at)
        except WireError as exc:
            return "invalid", str(exc)
    try:
        return "report", parse_report_line(cleaned, received_at=received_at)
    except ReportValidationError as exc:
        return "invalid", str(exc)


def find_serial_port(configured_port: str | None = None) -> str | None:
    """Return the configured port or first stable/USB serial device discovered."""

    if configured_port:
        return configured_port
    patterns = (
        "/dev/serial/by-id/*",
        "/dev/ttyUSB*",
        "/dev/ttyACM*",
    )
    for pattern in patterns:
        matches = sorted(glob.glob(pattern))
        if matches:
            return str(Path(matches[0]))
    return None


def _make_mqtt_client(client_id: str):
    if mqtt is None:
        raise RuntimeError("paho-mqtt is not installed; run pip install -r requirements.txt")
    try:
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    except AttributeError:  # paho-mqtt 1.x
        return mqtt.Client(client_id=client_id)


class SerialBridge:
    """Long-running resilient bridge from USB serial records to MQTT JSON."""

    def __init__(self, serial_port: str | None = None) -> None:
        self.serial_port = serial_port or config.SERIAL_PORT
        self.stop_event = threading.Event()
        self.gateway_ready = False
        self.serial_connected = False
        self.last_packet_at: float | None = None
        self._last_status: dict[str, Any] | None = None
        self._ack_queue: queue.Queue[str] = queue.Queue(maxsize=64)
        self.mqtt_client = _make_mqtt_client("rescuenet-serial-bridge")
        self.mqtt_client.on_connect = self._on_mqtt_connect
        self.mqtt_client.on_disconnect = self._on_mqtt_disconnect
        self.mqtt_client.on_message = self._on_mqtt_message
        self.mqtt_client.reconnect_delay_set(min_delay=1, max_delay=30)

    def _on_mqtt_connect(
        self, client, _userdata, _flags, reason_code, _properties=None
    ) -> None:
        code = int(getattr(reason_code, "value", reason_code))
        if code == 0:
            LOGGER.info("MQTT connected at %s:%s", config.MQTT_HOST, config.MQTT_PORT)
            client.subscribe(config.MQTT_MOBILE_ACK_TOPIC, qos=1)
            if self._last_status:
                self._publish_json(
                    config.MQTT_GATEWAY_STATUS_TOPIC, self._last_status, retain=True
                )
        else:
            LOGGER.error("MQTT connection rejected: %s", reason_code)

    def _on_mqtt_message(self, _client, _userdata, message) -> None:
        if message.topic != config.MQTT_MOBILE_ACK_TOPIC:
            return
        try:
            key = parse_ack(json.loads(message.payload.decode("utf-8")))
            self._ack_queue.put_nowait(key)
        except (ValueError, UnicodeDecodeError, TypeError, queue.Full) as exc:
            LOGGER.warning("Invalid/full mobile ACK queue: %s", exc)

    @staticmethod
    def _on_mqtt_disconnect(
        _client, _userdata, disconnect_flags_or_reason, reason_code=None, _properties=None
    ) -> None:
        raw_code = reason_code if reason_code is not None else disconnect_flags_or_reason
        code = int(getattr(raw_code, "value", raw_code))
        if code != 0:
            LOGGER.warning("MQTT disconnected unexpectedly: %s", code)

    def _publish_json(self, topic: str, payload: Mapping[str, Any], *, retain=False):
        try:
            result = self.mqtt_client.publish(
                topic,
                json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
                qos=1,
                retain=retain,
            )
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                LOGGER.warning("MQTT publish queued/failed topic=%s rc=%s", topic, result.rc)
            return result
        except Exception:
            LOGGER.exception("Unable to publish MQTT topic %s", topic)
            return None

    def publish_gateway_status(self) -> None:
        payload = {
            "serial_connected": self.serial_connected,
            "gateway_ready": self.gateway_ready,
            "last_packet_at": self.last_packet_at,
            "serial_port": find_serial_port(self.serial_port),
            "updated_at": time.time(),
        }
        self._last_status = payload
        self._publish_json(config.MQTT_GATEWAY_STATUS_TOPIC, payload, retain=True)

    def start_mqtt(self) -> None:
        LOGGER.info("Connecting to local MQTT broker %s:%s", config.MQTT_HOST, config.MQTT_PORT)
        self.mqtt_client.connect_async(
            config.MQTT_HOST, config.MQTT_PORT, keepalive=config.MQTT_KEEPALIVE
        )
        self.mqtt_client.loop_start()

    def stop(self) -> None:
        self.stop_event.set()
        self.serial_connected = False
        self.gateway_ready = False
        self.publish_gateway_status()
        try:
            self.mqtt_client.disconnect()
        finally:
            self.mqtt_client.loop_stop()

    def handle_line(self, line: str) -> None:
        kind, payload = classify_serial_line(line)
        if kind == "empty":
            return
        if kind == "ready":
            self.gateway_ready = True
            LOGGER.info("Gateway firmware ready")
            self.publish_gateway_status()
            return
        if kind == "drop":
            LOGGER.warning("Gateway rejected packet: %s", payload)
            return
        if kind == "firmware":
            LOGGER.info("Gateway firmware: %s", payload)
            return
        if kind == "invalid":
            LOGGER.warning("Malformed serial line skipped: %s", payload)
            return

        if kind == "mobile":
            assert isinstance(payload, dict)
            self._publish_json(config.MQTT_MOBILE_EVENT_TOPIC, payload)
            self.last_packet_at = float(payload["received_at"])
            LOGGER.info("Mobile event request=%s type=%s", payload["request_key"], payload["event_type"])
            self.publish_gateway_status()
            return

        report = payload
        assert isinstance(report, dict)
        self._publish_json(config.MQTT_REPORT_TOPIC, report)
        self.last_packet_at = float(report["received_at"])
        LOGGER.info(
            "Report received packet_id=%s source_node=%s hop=%s",
            report["pkt_id"],
            report["src_id"],
            report["hop"],
        )
        self.publish_gateway_status()

    def run(self) -> None:
        if serial is None:
            raise RuntimeError("pyserial is not installed; run pip install -r requirements.txt")
        self.start_mqtt()
        try:
            while not self.stop_event.is_set():
                port = find_serial_port(self.serial_port)
                if not port:
                    LOGGER.warning(
                        "Gateway serial device not found; retrying in %.1f seconds",
                        config.SERIAL_RECONNECT_SECONDS,
                    )
                    self.stop_event.wait(config.SERIAL_RECONNECT_SECONDS)
                    continue
                try:
                    LOGGER.info("Opening serial %s @ %s", port, config.SERIAL_BAUD)
                    with serial.Serial(
                        port=port,
                        baudrate=config.SERIAL_BAUD,
                        timeout=1.0,
                    ) as device:
                        self.serial_connected = True
                        self.gateway_ready = False
                        self.publish_gateway_status()
                        while not self.stop_event.is_set():
                            while not self._ack_queue.empty():
                                key = self._ack_queue.get_nowait()
                                device.write(ack_serial_line(key))
                                device.flush()
                                LOGGER.info("STORED ACK sent to Gateway request=%s", key)
                            raw = device.readline()
                            if raw:
                                self.handle_line(raw.decode("utf-8", errors="replace"))
                except (SerialException, OSError) as exc:
                    LOGGER.warning("Gateway serial disconnected (%s): %s", port, exc)
                except Exception:
                    # An unexpected line/device error must not end the bridge.
                    LOGGER.exception("Unexpected serial bridge error")
                finally:
                    self.serial_connected = False
                    self.gateway_ready = False
                    self.publish_gateway_status()
                self.stop_event.wait(config.SERIAL_RECONNECT_SECONDS)
        finally:
            self.stop()


def main() -> int:
    parser = argparse.ArgumentParser(description="RescueNet USB Serial to MQTT bridge")
    parser.add_argument("--port", help="Override the Gateway serial device path")
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        bridge = SerialBridge(serial_port=args.port)
    except RuntimeError as exc:
        LOGGER.error("%s", exc)
        return 1

    def request_stop(_signum, _frame) -> None:
        LOGGER.info("Stopping serial bridge")
        bridge.stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_stop)
    try:
        bridge.run()
    except RuntimeError as exc:
        LOGGER.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
