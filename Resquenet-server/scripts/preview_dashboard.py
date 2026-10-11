"""Preview the dashboard against an isolated empty database, without MQTT/serial."""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5055)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="rescuenet-ui-preview-") as preview_dir:
        app = create_app({"TESTING": True, "DATABASE_PATH": Path(preview_dir) / "preview.db"}, start_background_services=False)
        print("Preview uses an isolated empty database; no MQTT or serial process is started.", flush=True)
        app.run(host="127.0.0.1", port=args.port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
