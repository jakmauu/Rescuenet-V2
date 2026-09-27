"""API and additive-database tests without physical Gateway dependencies."""

import sqlite3

import pytest

from app import create_app
from services import database
from services.serial_bridge import parse_report_line


@pytest.fixture()
def app(tmp_path):
    db_path = tmp_path / "test-rescuenet.db"
    application = create_app(
        {
            "TESTING": True,
            "DATABASE_PATH": db_path,
            "NODE_ACTIVE_THRESHOLD_SECONDS": 300,
            "MAP_RECENT_SECONDS": 30,
            "MAP_STALE_SECONDS": 300,
            "MAP_GATEWAY_LAT": None,
            "MAP_GATEWAY_LON": None,
            "MAP_GATEWAY_LABEL": "Test Gateway",
        },
        start_background_services=False,
    )
    first = parse_report_line(
        "-72,8.4,4097,1,1,3,-6.2001,106.8167,1,KRITIS,3,1,Butuh bantuan",
        received_at=1_700_000_000.0,
    )
    second = parse_report_line(
        "-88,2.5,4098,2,2,4,0,0,0,AMAN,0,0,Kondisi terkendali",
        received_at=1_700_000_100.0,
    )
    database.insert_report(first, database_path=db_path)
    database.insert_report(second, database_path=db_path)
    database.set_service_state(
        "mqtt", "connected", {"host": "127.0.0.1"}, database_path=db_path
    )
    database.set_service_state(
        "gateway_serial",
        "ready",
        {"serial_connected": True, "gateway_ready": True},
        database_path=db_path,
    )
    yield application


@pytest.fixture()
def client(app):
    return app.test_client()


def test_root_and_local_static_assets_load(client):
    root = client.get("/")
    assert root.status_code == 200
    assert b"RescueNet Command Center" in root.data
    assert b"leaflet@1.9.4" in root.data
    assert b"Live Rescue Map" in root.data
    assert client.get("/static/css/style.css").status_code == 200
    assert client.get("/static/js/app.js").status_code == 200


def test_map_positions_include_latest_field_and_mobile_locations(client, app):
    db_path = app.config["DATABASE_PATH"]
    database.insert_mobile_event(
        {
            "request_key": "req-map-user-1",
            "event_type": "SOS",
            "user_key": "user-123",
            "name": "Riko Dharmawan",
            "name_truncated": 0,
            "has_gps": 1,
            "lat": -6.2005,
            "lon": 106.8172,
            "accuracy": 6.8,
            "event_timestamp": 1_700_000_140,
            "fix_timestamp": 1_700_000_140,
            "source_node": 1,
            "mesh_source": 9488,
            "mesh_hops": 1,
            "rssi": -72.0,
            "snr": 8.4,
            "received_at": 1_700_000_150.0,
        },
        database_path=db_path,
    )

    response = client.get("/api/map/positions")
    assert response.status_code == 200
    snapshot = response.get_json()
    positions = {item["id"]: item for item in snapshot["positions"]}

    assert positions["field:1"]["lat"] == pytest.approx(-6.2001)
    assert positions["field:1"]["critical"] is True
    assert positions["mobile:user-123"]["label"] == "Riko Dharmawan"
    assert positions["mobile:user-123"]["accuracy"] == pytest.approx(6.8)
    assert positions["mobile:user-123"]["distance_to_source_m"] > 0
    assert "gateway" not in positions
    assert snapshot["counts"]["field_nodes"] == 1
    assert snapshot["counts"]["mobile_users"] == 1
    assert snapshot["counts"]["critical"] == 2
    assert snapshot["links"] == [
        {
            "from_id": "mobile:user-123",
            "to_id": "field:1",
            "kind": "mobile_to_field",
            "distance_m": positions["mobile:user-123"]["distance_to_source_m"],
        }
    ]


def test_get_reports_and_filters(client):
    response = client.get("/api/reports")
    assert response.status_code == 200
    assert len(response.get_json()) == 2
    assert response.get_json()[0]["pkt_id"] == 4098

    assert len(client.get("/api/reports?status=BARU").get_json()) == 2
    assert len(client.get("/api/reports?sos=1").get_json()) == 1
    assert len(client.get("/api/reports?src_id=2&limit=1").get_json()) == 1


@pytest.mark.parametrize(
    "query", ["status=UNKNOWN", "sos=2", "src_id=nope", "limit=0", "limit=1001"]
)
def test_invalid_report_filters_return_400(client, query):
    response = client.get(f"/api/reports?{query}")
    assert response.status_code == 400
    assert "error" in response.get_json()


def test_get_report_and_unknown_report(client):
    response = client.get("/api/reports/1")
    assert response.status_code == 200
    assert response.get_json()["id"] == 1
    assert client.get("/api/reports/999").status_code == 404


def test_patch_report_status(client):
    response = client.patch("/api/reports/1/status", json={"status": "DITANGANI"})
    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "id": 1, "status": "DITANGANI"}
    assert client.get("/api/reports/1").get_json()["status"] == "DITANGANI"

    assert client.patch("/api/reports/1/status", json={"status": "INVALID"}).status_code == 400
    assert client.patch("/api/reports/999/status", json={"status": "SELESAI"}).status_code == 404
    assert client.patch("/api/reports/1/status", data="not json").status_code == 400


def test_nodes_use_recently_active_semantics(client):
    response = client.get("/api/nodes")
    assert response.status_code == 200
    nodes = response.get_json()
    assert len(nodes) == 2
    assert "recently_active" in nodes[0]
    assert "online" not in nodes[0]


def test_stats_activity_health_and_system(client):
    stats = client.get("/api/stats")
    assert stats.status_code == 200
    assert stats.get_json()["total_reports"] == 2
    assert stats.get_json()["critical_reports"] == 1

    activity = client.get("/api/activity?hours=6")
    assert activity.status_code == 200
    assert len(activity.get_json()) == 6
    assert all("label" in bucket and "count" in bucket for bucket in activity.get_json())

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.get_json()["database"]["status"] == "connected"
    assert health.get_json()["mqtt"]["status"] == "connected"

    system = client.get("/api/system")
    assert system.status_code == 200
    assert set(system.get_json()) == {
        "cpu_percent", "memory_percent", "disk_percent", "temperature_c", "uptime_seconds"
    }


def test_activity_parameter_validation(client):
    assert client.get("/api/activity?hours=0").status_code == 400
    assert client.get("/api/activity?hours=169").status_code == 400
    assert client.get("/api/activity?hours=nope").status_code == 400


def test_database_allows_repeated_packet_ids(app):
    db_path = app.config["DATABASE_PATH"]
    report = parse_report_line(
        "-70,7.0,4097,1,1,3,-6.2,106.8,1,KRITIS,1,1,Repeated after reboot",
        received_at=1_700_000_200.0,
    )
    database.insert_report(report, database_path=db_path)
    matches = database.query_reports(src_id=1, limit=100, database_path=db_path)
    assert [item["pkt_id"] for item in matches].count(4097) == 2
    assert len({item["id"] for item in matches}) == len(matches)


def test_additive_migration_preserves_legacy_report(tmp_path):
    db_path = tmp_path / "legacy.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, pkt_id INTEGER, pesan TEXT)"
        )
        conn.execute("INSERT INTO reports (pkt_id, pesan) VALUES (?, ?)", (77, "real legacy row"))
        conn.commit()

    migrations = database.init_database(db_path)
    with sqlite3.connect(db_path) as conn:
        row = conn.execute("SELECT pkt_id, pesan, max_hop, status FROM reports WHERE id = 1").fetchone()
        columns = {item[1] for item in conn.execute("PRAGMA table_info(reports)")}
    assert row == (77, "real legacy row", None, "BARU")
    assert "max_hop" in columns and "received_at" in columns
    assert "Added reports.max_hop" in migrations
