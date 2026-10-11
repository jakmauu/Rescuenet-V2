"""Source tests for idempotent activity and heartbeat-based liveness."""

import time
import sqlite3

from services import database
from services.serial_bridge import parse_report_line
from services.mqtt_service import MQTTService
from app import create_app


def test_duplicate_report_and_mobile_event_do_not_refresh_new_activity(tmp_path):
    path = tmp_path / "activity.db"
    database.init_database(path)
    report = parse_report_line(
        "-72,8.4,8193,2,0,5,0,0,0,SEDANG,1,0,portal test",
        received_at=1000.0,
    )
    report["delivery_key"] = "ab" * 16
    report_id, inserted = database.insert_report(report, path)
    assert inserted
    duplicate_id, inserted = database.insert_report({**report, "received_at": 9000.0}, path)
    assert duplicate_id == report_id and not inserted
    node = database.get_node_states(database_path=path)[0]
    assert node["last_seen"] == 1000.0
    assert node["last_new_report_at"] == 1000.0

    event = {
        "request_key": "cd" * 16, "event_type": "SOS", "user_key": "user-key",
        "name": "Test", "name_truncated": 0, "has_gps": 0, "lat": None,
        "lon": None, "accuracy": None, "event_timestamp": 100,
        "fix_timestamp": None, "source_node": 2, "mesh_source": 9068,
        "mesh_hops": 1, "rssi": None, "snr": None, "received_at": 1100.0,
    }
    _event_id, inserted = database.insert_mobile_event(event, path)
    assert inserted
    _event_id, inserted = database.insert_mobile_event({**event, "received_at": 9100.0}, path)
    assert not inserted
    node = database.get_node_states(database_path=path)[0]
    assert node["last_seen"] == 1100.0


def test_heartbeat_changes_device_state_not_report_activity(tmp_path):
    path = tmp_path / "heartbeat.db"
    database.init_database(path)
    database.update_node_heartbeat({
        "node_id": 2, "uptime_seconds": 123, "mesh_synced": True,
        "gateway_found": True, "pending_count": 4, "received_at": 5000.0,
    }, path)
    node = database.get_node_states(database_path=path, now=5050.0)[0]
    assert node["device_status"] == "online"
    assert node["last_seen"] is None
    assert node["last_new_report_at"] is None
    assert node["mesh_synced"] == 1 and node["gateway_found"] == 1
    assert node["pending_count"] == 4
    stale = database.get_node_states(database_path=path, now=5300.0)[0]
    assert stale["device_status"] == "stale"


def test_gateway_status_age_is_reported_as_stale(tmp_path):
    app = create_app({"TESTING": True, "DATABASE_PATH": tmp_path / "gateway-status.db"})
    database.set_service_state(
        "gateway_serial", "ready", {"serial_connected": True, "gateway_ready": True},
        updated_at=time.time() - 30, database_path=app.config["DATABASE_PATH"],
    )
    response = app.test_client().get("/api/health")
    assert response.status_code == 200
    gateway = response.get_json()["gateway_serial"]
    assert gateway["status"] == "stale"
    assert gateway["details"]["status_age_seconds"] >= 20


def test_mqtt_heartbeat_ingestion_validates_and_persists(tmp_path):
    path = tmp_path / "mqtt-heartbeat.db"
    database.init_database(path)
    service = MQTTService(path)
    service._handle_node_heartbeat({
        "node_id": 2, "uptime_seconds": 123, "mesh_synced": True,
        "gateway_found": True, "pending_count": 4, "received_at": 5000.0,
    })
    node = database.get_node_states(database_path=path, now=5010.0)[0]
    assert node["device_status"] == "online" and node["pending_count"] == 4
    service._handle_node_heartbeat({**{
        "node_id": 0, "uptime_seconds": 0, "mesh_synced": True,
        "gateway_found": True, "pending_count": -1, "received_at": 6000.0,
    }})
    unchanged = database.get_node_states(database_path=path, now=5010.0)[0]
    assert unchanged["last_heartbeat_at"] == 5000.0


def test_existing_database_migrates_additively_and_keeps_rows(tmp_path):
    path = tmp_path / "legacy-schema.db"
    with sqlite3.connect(path) as conn:
        conn.execute("""CREATE TABLE reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT, pkt_id INTEGER, src_id INTEGER, hop INTEGER,
            max_hop INTEGER, lat REAL, lon REAL, has_gps INTEGER, kondisi TEXT, jumlah INTEGER,
            sos INTEGER, pesan TEXT, rssi INTEGER, snr REAL, status TEXT DEFAULT 'BARU',
            received_at REAL NOT NULL)""")
        conn.execute("""CREATE TABLE node_status (
            node_id INTEGER PRIMARY KEY, last_seen REAL, last_rssi INTEGER,
            last_snr REAL, last_hop INTEGER, last_pkt_id INTEGER)""")
        conn.execute("CREATE TABLE service_state (service TEXT PRIMARY KEY, status TEXT, details TEXT, updated_at REAL)")
        conn.execute("INSERT INTO reports(pkt_id,src_id,received_at) VALUES(7,2,1000)")
        conn.execute("INSERT INTO node_status(node_id,last_seen,last_pkt_id) VALUES(2,1000,7)")
    migrations = database.init_database(path)
    with sqlite3.connect(path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(node_status)")}
        assert {"last_new_report_at", "last_heartbeat_at", "last_gateway_contact_at", "mesh_synced"} <= columns
        assert conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0] == 1
        assert conn.execute("SELECT last_new_report_at FROM node_status WHERE node_id=2").fetchone()[0] == 1000
    assert any("last_heartbeat_at" in migration for migration in migrations)
