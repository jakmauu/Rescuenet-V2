"""Isolated browser-test fixture. Never uses the operational RescueNet database."""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from services import database
from services.serial_bridge import parse_report_line


def main():
    with tempfile.TemporaryDirectory(prefix="rescuenet-dashboard-smoke-") as folder:
        db_path = Path(folder) / "test.db"
        app = create_app({"TESTING": True, "DATABASE_PATH": db_path, "MAP_GATEWAY_LAT": -6.2004, "MAP_GATEWAY_LON": 106.8174}, start_background_services=False)
        now = time.time()
        for index in range(37):
            node = 1 + index % 3
            report = parse_report_line(f"-72,8.4,{4096 + index},{node},0,3,{-6.2001 + index * .00001},106.8167,1,{'KRITIS' if index % 4 == 0 else 'SEDANG'},1,{int(index % 4 == 0)},Browser fixture {index}", received_at=now-index*400)
            database.insert_report(report, database_path=db_path)
        for node, age in ((1, 1000), (2, 30)):
            database.update_node_heartbeat({"node_id": node, "received_at": now-age, "uptime_seconds": 600, "mesh_synced": True, "gateway_found": True, "pending_count": 0}, database_path=db_path)
        database.set_service_state("mqtt", "connected", {"host": "127.0.0.1"}, database_path=db_path)
        database.set_service_state("gateway_serial", "ready", {"serial_connected": True, "gateway_ready": True, "serial_port": "/dev/test-only", "last_packet_at": now}, database_path=db_path)

        def mobile_event(key, event_type="SOS"):
            return {"request_key": key, "event_type": event_type, "user_key": "fixture-user", "name": "Browser test user",
                    "name_truncated": 0, "has_gps": 1, "lat": -6.2005, "lon": 106.8172, "accuracy": 8.0,
                    "event_timestamp": int(time.time()), "fix_timestamp": int(time.time()), "source_node": 2,
                    "mesh_source": 9068, "mesh_hops": 1, "rssi": None, "snr": None, "received_at": time.time()}
        database.insert_mobile_event(mobile_event("initial-browser-test-sos"), database_path=db_path)

        @app.post("/__test__/new-sos")
        def add_sos():
            report = parse_report_line("-72,8.4,9000,2,0,3,-6.201,106.818,1,KRITIS,1,1,Browser live-update fixture", received_at=time.time())
            report_id, _ = database.insert_report(report, database_path=db_path)
            database.insert_mobile_event(mobile_event("new-browser-test-sos"), database_path=db_path)
            return {"id": report_id}

        app.run(host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 5056, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
