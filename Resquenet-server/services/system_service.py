"""Real host metrics for the RescueNet system status view."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

try:
    import psutil
except ImportError:  # pragma: no cover - only on incomplete installations
    psutil = None  # type: ignore[assignment]


LOGGER = logging.getLogger(__name__)


def _cpu_temperature() -> float | None:
    if psutil is not None:
        try:
            groups = psutil.sensors_temperatures()
            for preferred in ("cpu_thermal", "coretemp", "soc_thermal"):
                readings = groups.get(preferred, [])
                if readings:
                    return round(float(readings[0].current), 1)
            for readings in groups.values():
                if readings:
                    return round(float(readings[0].current), 1)
        except (AttributeError, OSError, RuntimeError, ValueError):
            pass

    thermal_path = Path("/sys/class/thermal/thermal_zone0/temp")
    try:
        raw = float(thermal_path.read_text(encoding="utf-8").strip())
        return round(raw / 1000.0 if raw > 200 else raw, 1)
    except (OSError, ValueError):
        return None


def get_system_metrics() -> dict[str, Any]:
    """Return real system measurements, using null for unavailable values."""

    metrics: dict[str, Any] = {
        "cpu_percent": None,
        "memory_percent": None,
        "disk_percent": None,
        "temperature_c": _cpu_temperature(),
        "uptime_seconds": None,
    }
    if psutil is None:
        return metrics
    try:
        metrics["cpu_percent"] = round(float(psutil.cpu_percent(interval=0.1)), 1)
    except (OSError, ValueError):
        LOGGER.debug("CPU metric unavailable", exc_info=True)
    try:
        metrics["memory_percent"] = round(float(psutil.virtual_memory().percent), 1)
    except (OSError, ValueError):
        LOGGER.debug("Memory metric unavailable", exc_info=True)
    try:
        metrics["disk_percent"] = round(float(psutil.disk_usage(str(Path.cwd().anchor or "/")).percent), 1)
    except (OSError, ValueError):
        LOGGER.debug("Disk metric unavailable", exc_info=True)
    try:
        metrics["uptime_seconds"] = max(0, int(time.time() - psutil.boot_time()))
    except (OSError, ValueError):
        LOGGER.debug("Uptime metric unavailable", exc_info=True)
    return metrics

