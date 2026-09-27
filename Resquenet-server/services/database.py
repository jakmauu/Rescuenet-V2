"""Thread-safe, data-preserving SQLite access for RescueNet."""

from __future__ import annotations

import json
import logging
import math
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Mapping

import config


LOGGER = logging.getLogger(__name__)
ALLOWED_STATUSES = frozenset({"BARU", "DITANGANI", "SELESAI"})
MAX_REPORT_LIMIT = 1000

REPORT_COLUMNS: dict[str, str] = {
    "pkt_id": "INTEGER",
    "src_id": "INTEGER",
    "hop": "INTEGER",
    "max_hop": "INTEGER",
    "lat": "REAL",
    "lon": "REAL",
    "has_gps": "INTEGER",
    "kondisi": "TEXT",
    "jumlah": "INTEGER",
    "sos": "INTEGER",
    "pesan": "TEXT",
    "rssi": "INTEGER",
    "snr": "REAL",
    "status": "TEXT DEFAULT 'BARU'",
    "received_at": "REAL",
}

NODE_COLUMNS: dict[str, str] = {
    "last_seen": "REAL",
    "last_rssi": "INTEGER",
    "last_snr": "REAL",
    "last_hop": "INTEGER",
    "last_pkt_id": "INTEGER",
}

SERVICE_COLUMNS: dict[str, str] = {
    "status": "TEXT",
    "details": "TEXT",
    "updated_at": "REAL",
}


def _database_path(database_path: str | Path | None = None) -> Path:
    return Path(database_path or config.DATABASE_PATH).expanduser().resolve()


@contextmanager
def connection(database_path: str | Path | None = None) -> Iterator[sqlite3.Connection]:
    """Open a short-lived SQLite connection suitable for the calling thread."""

    path = _database_path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    # Table names are application constants, never HTTP input.
    return {str(row["name"]) for row in conn.execute(f'PRAGMA table_info("{table}")')}


def _add_missing_columns(
    conn: sqlite3.Connection, table: str, required: Mapping[str, str]
) -> list[str]:
    existing = _table_columns(conn, table)
    added: list[str] = []
    for name, definition in required.items():
        if name not in existing:
            conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {definition}')
            added.append(name)
    return added


def init_database(database_path: str | Path | None = None) -> list[str]:
    """Create or additively migrate the database and return migration notes."""

    migrations: list[str] = []
    with connection(database_path) as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pkt_id INTEGER,
                src_id INTEGER,
                hop INTEGER,
                max_hop INTEGER,
                lat REAL,
                lon REAL,
                has_gps INTEGER,
                kondisi TEXT,
                jumlah INTEGER,
                sos INTEGER,
                pesan TEXT,
                rssi INTEGER,
                snr REAL,
                status TEXT DEFAULT 'BARU',
                received_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS node_status (
                node_id INTEGER PRIMARY KEY,
                last_seen REAL,
                last_rssi INTEGER,
                last_snr REAL,
                last_hop INTEGER,
                last_pkt_id INTEGER
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS service_state (
                service TEXT PRIMARY KEY,
                status TEXT,
                details TEXT,
                updated_at REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mobile_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_key TEXT NOT NULL UNIQUE,
                event_type TEXT NOT NULL,
                user_key TEXT NOT NULL,
                name TEXT NOT NULL,
                name_truncated INTEGER NOT NULL,
                has_gps INTEGER NOT NULL,
                lat REAL,
                lon REAL,
                accuracy REAL,
                event_timestamp INTEGER NOT NULL,
                fix_timestamp INTEGER,
                source_node INTEGER NOT NULL,
                mesh_source INTEGER NOT NULL,
                mesh_hops INTEGER,
                rssi REAL,
                snr REAL,
                received_at REAL NOT NULL,
                delivery_state TEXT NOT NULL DEFAULT 'STORED'
            )
            """
        )

        for table, columns in (
            ("reports", REPORT_COLUMNS),
            ("node_status", NODE_COLUMNS),
            ("service_state", SERVICE_COLUMNS),
        ):
            for column in _add_missing_columns(conn, table, columns):
                note = f"Added {table}.{column}"
                LOGGER.info(note)
                migrations.append(note)

        # Existing rows are preserved. Only absent/null operational defaults are filled.
        conn.execute("UPDATE reports SET status = 'BARU' WHERE status IS NULL OR status = ''")
        conn.execute(
            "UPDATE reports SET received_at = CAST(strftime('%s', 'now') AS REAL) "
            "WHERE received_at IS NULL"
        )

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_reports_received_at ON reports(received_at)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_src_id ON reports(src_id)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_reports_node_gps "
            "ON reports(src_id, has_gps, received_at)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_sos ON reports(sos)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mobile_received ON mobile_events(received_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mobile_user_fix ON mobile_events(user_key,fix_timestamp)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_mobile_user_received "
            "ON mobile_events(user_key, has_gps, received_at)"
        )
        conn.commit()

    return migrations


def insert_mobile_event(event: Mapping[str, Any], database_path: str | Path | None = None) -> tuple[int, bool]:
    """Commit once by stable key; returning an existing row authorizes re-ACK."""
    fields = ("request_key", "event_type", "user_key", "name", "name_truncated",
              "has_gps", "lat", "lon", "accuracy", "event_timestamp", "fix_timestamp",
              "source_node", "mesh_source", "mesh_hops", "rssi", "snr", "received_at")
    values = [event[name] for name in fields]
    with connection(database_path) as conn:
        cursor = conn.execute(
            f"INSERT OR IGNORE INTO mobile_events ({', '.join(fields)}) VALUES ({', '.join('?' for _ in fields)})",
            values,
        )
        inserted = cursor.rowcount == 1
        row = conn.execute("SELECT * FROM mobile_events WHERE request_key=?",
                           (event["request_key"],)).fetchone()
        if row is None:
            raise sqlite3.DatabaseError("mobile event not available after insert")
        identity_fields = ("event_type", "user_key", "name", "name_truncated", "has_gps",
                           "lat", "lon", "accuracy", "event_timestamp", "fix_timestamp", "source_node")
        if any(row[name] != event[name] for name in identity_fields):
            raise ValueError("request key conflicts with existing event")
        conn.commit()
        return int(row["id"]), inserted


def query_mobile_events(*, limit: int = 100, database_path: str | Path | None = None) -> list[dict[str, Any]]:
    with connection(database_path) as conn:
        rows = conn.execute("SELECT * FROM mobile_events ORDER BY received_at DESC,id DESC LIMIT ?",
                            (min(max(int(limit), 1), 1000),)).fetchall()
    return [dict(row) for row in rows]


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def insert_report(
    report: Mapping[str, Any], database_path: str | Path | None = None
) -> int:
    """Insert one validated report and update that source node's activity atomically."""

    fields = (
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
        "rssi",
        "snr",
        "status",
        "received_at",
    )
    values = [report.get(name) for name in fields]
    values[13] = values[13] if values[13] in ALLOWED_STATUSES else "BARU"

    with connection(database_path) as conn:
        cursor = conn.execute(
            f"INSERT INTO reports ({', '.join(fields)}) "
            f"VALUES ({', '.join('?' for _ in fields)})",
            values,
        )
        conn.execute(
            """
            INSERT INTO node_status (
                node_id, last_seen, last_rssi, last_snr, last_hop, last_pkt_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(node_id) DO UPDATE SET
                last_seen = excluded.last_seen,
                last_rssi = excluded.last_rssi,
                last_snr = excluded.last_snr,
                last_hop = excluded.last_hop,
                last_pkt_id = excluded.last_pkt_id
            """,
            (
                report["src_id"],
                report["received_at"],
                report["rssi"],
                report["snr"],
                report["hop"],
                report["pkt_id"],
            ),
        )
        conn.commit()
        report_id = int(cursor.lastrowid)

    LOGGER.info("Stored report database_id=%s source_node=%s", report_id, report["src_id"])
    return report_id


def query_reports(
    *,
    status: str | None = None,
    sos: int | None = None,
    src_id: int | None = None,
    limit: int = 200,
    database_path: str | Path | None = None,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if status is not None:
        clauses.append("status = ?")
        params.append(status)
    if sos is not None:
        clauses.append("sos = ?")
        params.append(sos)
    if src_id is not None:
        clauses.append("src_id = ?")
        params.append(src_id)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(min(max(int(limit), 1), MAX_REPORT_LIMIT))

    with connection(database_path) as conn:
        rows = conn.execute(
            f"SELECT * FROM reports{where} ORDER BY received_at DESC, id DESC LIMIT ?",
            params,
        ).fetchall()
    return [dict(row) for row in rows]


def get_report(
    report_id: int, database_path: str | Path | None = None
) -> dict[str, Any] | None:
    with connection(database_path) as conn:
        row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    return _row_to_dict(row)


def update_report_status(
    report_id: int, status: str, database_path: str | Path | None = None
) -> bool:
    if status not in ALLOWED_STATUSES:
        raise ValueError("Invalid report status")
    with connection(database_path) as conn:
        cursor = conn.execute(
            "UPDATE reports SET status = ? WHERE id = ?", (status, report_id)
        )
        conn.commit()
        return cursor.rowcount > 0


def get_node_states(
    *,
    active_threshold_seconds: int = config.NODE_ACTIVE_THRESHOLD_SECONDS,
    database_path: str | Path | None = None,
    now: float | None = None,
) -> list[dict[str, Any]]:
    current = float(now if now is not None else time.time())
    with connection(database_path) as conn:
        rows = conn.execute("SELECT * FROM node_status ORDER BY node_id").fetchall()

    nodes: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        last_seen = item.get("last_seen")
        seconds_ago = max(0, int(current - float(last_seen))) if last_seen else None
        item["seconds_ago"] = seconds_ago
        item["recently_active"] = (
            seconds_ago is not None and seconds_ago < active_threshold_seconds
        )
        nodes.append(item)
    return nodes


def get_statistics(
    *,
    active_threshold_seconds: int = config.NODE_ACTIVE_THRESHOLD_SECONDS,
    database_path: str | Path | None = None,
) -> dict[str, Any]:
    cutoff = time.time() - active_threshold_seconds
    critical_values = ("KRITIS", "CRITICAL", "DARURAT", "EMERGENCY")
    placeholders = ", ".join("?" for _ in critical_values)
    with connection(database_path) as conn:
        counts = conn.execute(
            f"""
            SELECT
                COUNT(*) AS total_reports,
                SUM(CASE WHEN sos = 1 OR UPPER(COALESCE(kondisi, '')) IN ({placeholders})
                    THEN 1 ELSE 0 END) AS critical_reports,
                SUM(CASE WHEN status = 'BARU' THEN 1 ELSE 0 END) AS unhandled_reports
            FROM reports
            """,
            critical_values,
        ).fetchone()
        node_counts = conn.execute(
            """
            SELECT COUNT(*) AS known_nodes,
                SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS active_nodes
            FROM node_status
            """,
            (cutoff,),
        ).fetchone()
        last = conn.execute(
            "SELECT * FROM reports ORDER BY received_at DESC, id DESC LIMIT 1"
        ).fetchone()

    return {
        "total_reports": int(counts["total_reports"] or 0),
        "critical_reports": int(counts["critical_reports"] or 0),
        "unhandled_reports": int(counts["unhandled_reports"] or 0),
        "recently_active_nodes": int(node_counts["active_nodes"] or 0),
        "known_nodes": int(node_counts["known_nodes"] or 0),
        "last_report": _row_to_dict(last),
    }


def get_activity(
    *,
    hours: int = 6,
    database_path: str | Path | None = None,
    now: float | None = None,
) -> list[dict[str, Any]]:
    """Return a complete set of real hourly buckets, including zero-count hours."""

    current = float(now if now is not None else time.time())
    current_hour = math.floor(current / 3600) * 3600
    start = current_hour - (hours - 1) * 3600
    end = current_hour + 3600
    with connection(database_path) as conn:
        rows = conn.execute(
            """
            SELECT CAST(received_at / 3600 AS INTEGER) * 3600 AS bucket,
                   COUNT(*) AS count
            FROM reports
            WHERE received_at >= ? AND received_at < ?
            GROUP BY bucket
            """,
            (start, end),
        ).fetchall()
    counts = {int(row["bucket"]): int(row["count"]) for row in rows}
    return [
        {
            "timestamp": bucket,
            "label": datetime.fromtimestamp(bucket).strftime("%H:00"),
            "count": counts.get(bucket, 0),
        }
        for bucket in range(int(start), int(end), 3600)
    ]


def set_service_state(
    service: str,
    status: str,
    details: Mapping[str, Any] | None = None,
    *,
    updated_at: float | None = None,
    database_path: str | Path | None = None,
) -> None:
    timestamp = float(updated_at if updated_at is not None else time.time())
    encoded = json.dumps(details or {}, separators=(",", ":"), ensure_ascii=False)
    with connection(database_path) as conn:
        conn.execute(
            """
            INSERT INTO service_state(service, status, details, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(service) DO UPDATE SET
                status = excluded.status,
                details = excluded.details,
                updated_at = excluded.updated_at
            """,
            (service, status, encoded, timestamp),
        )
        conn.commit()


def get_service_state(
    service: str, database_path: str | Path | None = None
) -> dict[str, Any] | None:
    with connection(database_path) as conn:
        row = conn.execute(
            "SELECT service, status, details, updated_at FROM service_state WHERE service = ?",
            (service,),
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    try:
        item["details"] = json.loads(item.get("details") or "{}")
    except (TypeError, json.JSONDecodeError):
        item["details"] = {"raw": item.get("details")}
    return item


def health_check(database_path: str | Path | None = None) -> bool:
    try:
        with connection(database_path) as conn:
            return conn.execute("SELECT 1").fetchone()[0] == 1
    except sqlite3.Error:
        LOGGER.exception("Database health check failed")
        return False
