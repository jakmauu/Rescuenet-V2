"""RescueNet JSON REST API."""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

from flask import Blueprint, current_app, jsonify, request

from services import database
from services.map_service import get_map_snapshot
from services.system_service import get_system_metrics


LOGGER = logging.getLogger(__name__)
api = Blueprint("api", __name__, url_prefix="/api")


def _db_path():
    return current_app.config["DATABASE_PATH"]


def _error(message: str, status_code: int):
    return jsonify({"error": message}), status_code


def _positive_int_query(name: str, default: int | None = None) -> int | None:
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


@api.get("/reports")
def reports():
    try:
        status = request.args.get("status")
        if status is not None:
            status = status.strip().upper()
            if status not in database.ALLOWED_STATUSES:
                return _error("Invalid status filter", 400)

        sos: int | None = None
        if "sos" in request.args:
            try:
                sos = int(request.args["sos"])
            except ValueError:
                return _error("sos must be 0 or 1", 400)
            if sos not in (0, 1):
                return _error("sos must be 0 or 1", 400)

        src_id = _positive_int_query("src_id")
        limit = _positive_int_query("limit", 200)
        assert limit is not None
        if limit > database.MAX_REPORT_LIMIT:
            return _error(f"limit must not exceed {database.MAX_REPORT_LIMIT}", 400)

        return jsonify(
            database.query_reports(
                status=status,
                sos=sos,
                src_id=src_id,
                limit=limit,
                database_path=_db_path(),
            )
        )
    except ValueError as exc:
        return _error(str(exc), 400)
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/reports")
        return _error("Database unavailable", 503)


@api.get("/mobile/events")
def mobile_events():
    try:
        limit = _positive_int_query("limit", 100)
        assert limit is not None
        return jsonify(database.query_mobile_events(limit=limit, database_path=_db_path()))
    except ValueError as exc:
        return _error(str(exc), 400)
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/mobile/events")
        return _error("Database unavailable", 503)


@api.get("/reports/<int:report_id>")
def report_detail(report_id: int):
    try:
        report = database.get_report(report_id, database_path=_db_path())
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/reports/%s", report_id)
        return _error("Database unavailable", 503)
    if report is None:
        return _error("Report not found", 404)
    return jsonify(report)


@api.patch("/reports/<int:report_id>/status")
def patch_report_status(report_id: int):
    body: Any = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _error("Request body must be a JSON object", 400)
    status = body.get("status")
    if not isinstance(status, str) or status.upper() not in database.ALLOWED_STATUSES:
        return _error("Status must be BARU, DITANGANI, or SELESAI", 400)
    normalized = status.upper()
    try:
        updated = database.update_report_status(
            report_id, normalized, database_path=_db_path()
        )
    except sqlite3.Error:
        LOGGER.exception("Database failure in PATCH /api/reports/%s/status", report_id)
        return _error("Database unavailable", 503)
    if not updated:
        return _error("Report not found", 404)
    return jsonify({"ok": True, "id": report_id, "status": normalized})


@api.get("/nodes")
def nodes():
    try:
        return jsonify(
            database.get_node_states(
                active_threshold_seconds=current_app.config[
                    "NODE_ACTIVE_THRESHOLD_SECONDS"
                ],
                database_path=_db_path(),
            )
        )
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/nodes")
        return _error("Database unavailable", 503)


@api.get("/map/positions")
def map_positions():
    try:
        return jsonify(
            get_map_snapshot(
                database_path=_db_path(),
                recent_seconds=current_app.config["MAP_RECENT_SECONDS"],
                stale_seconds=current_app.config["MAP_STALE_SECONDS"],
                gateway_lat=current_app.config.get("MAP_GATEWAY_LAT"),
                gateway_lon=current_app.config.get("MAP_GATEWAY_LON"),
                gateway_label=current_app.config["MAP_GATEWAY_LABEL"],
            )
        )
    except ValueError as exc:
        LOGGER.error("Invalid map configuration: %s", exc)
        return _error(str(exc), 500)
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/map/positions")
        return _error("Database unavailable", 503)


@api.get("/stats")
def stats():
    try:
        return jsonify(
            database.get_statistics(
                active_threshold_seconds=current_app.config[
                    "NODE_ACTIVE_THRESHOLD_SECONDS"
                ],
                database_path=_db_path(),
            )
        )
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/stats")
        return _error("Database unavailable", 503)


@api.get("/activity")
def activity():
    try:
        hours = _positive_int_query("hours", 6)
        assert hours is not None
        if hours > 168:
            return _error("hours must not exceed 168", 400)
        return jsonify(database.get_activity(hours=hours, database_path=_db_path()))
    except ValueError as exc:
        return _error(str(exc), 400)
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/activity")
        return _error("Database unavailable", 503)


def _service_or_default(service: str, default_status: str = "not_available"):
    state = database.get_service_state(service, database_path=_db_path())
    if state is None:
        return {"status": default_status, "details": {}, "updated_at": None}
    return {
        "status": state.get("status") or default_status,
        "details": state.get("details") or {},
        "updated_at": state.get("updated_at"),
    }


@api.get("/health")
def health():
    try:
        database_ok = database.health_check(database_path=_db_path())
        mqtt_state = _service_or_default("mqtt")
        gateway_state = _service_or_default("gateway_serial")
        return jsonify(
            {
                "flask": {"status": "running"},
                "database": {"status": "connected" if database_ok else "unavailable"},
                "mqtt": mqtt_state,
                "gateway_serial": gateway_state,
            }
        )
    except sqlite3.Error:
        LOGGER.exception("Database failure in GET /api/health")
        return _error("Database unavailable", 503)


@api.get("/system")
def system():
    try:
        return jsonify(get_system_metrics())
    except Exception:
        LOGGER.exception("System metrics collection failed")
        return _error("System metrics unavailable", 503)
