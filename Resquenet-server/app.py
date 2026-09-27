"""Flask application entry point for the RescueNet local command center."""

from __future__ import annotations

import atexit
import logging
from pathlib import Path
from typing import Any, Mapping

from flask import Flask, jsonify, render_template

import config
from routes.api import api
from services import database
from services.mqtt_service import MQTTService


LOGGER = logging.getLogger(__name__)


def create_app(
    test_config: Mapping[str, Any] | None = None,
    *,
    start_background_services: bool = False,
) -> Flask:
    app = Flask(__name__)
    app.config.from_mapping(
        DATABASE_PATH=Path(config.DATABASE_PATH),
        NODE_ACTIVE_THRESHOLD_SECONDS=config.NODE_ACTIVE_THRESHOLD_SECONDS,
        MAP_TILE_URL=config.MAP_TILE_URL,
        MAP_DEFAULT_LAT=config.MAP_DEFAULT_LAT,
        MAP_DEFAULT_LON=config.MAP_DEFAULT_LON,
        MAP_DEFAULT_ZOOM=config.MAP_DEFAULT_ZOOM,
        MAP_RECENT_SECONDS=config.MAP_RECENT_SECONDS,
        MAP_STALE_SECONDS=config.MAP_STALE_SECONDS,
        MAP_GATEWAY_LAT=config.MAP_GATEWAY_LAT,
        MAP_GATEWAY_LON=config.MAP_GATEWAY_LON,
        MAP_GATEWAY_LABEL=config.MAP_GATEWAY_LABEL,
        JSON_SORT_KEYS=False,
    )
    if test_config:
        app.config.update(test_config)

    migrations = database.init_database(app.config["DATABASE_PATH"])
    if migrations:
        LOGGER.info("Database migrations applied: %s", "; ".join(migrations))

    app.register_blueprint(api)

    @app.get("/")
    def index():
        return render_template(
            "index.html",
            map_config={
                "tileUrl": app.config["MAP_TILE_URL"],
                "defaultCenter": [
                    app.config["MAP_DEFAULT_LAT"],
                    app.config["MAP_DEFAULT_LON"],
                ],
                "defaultZoom": app.config["MAP_DEFAULT_ZOOM"],
                "pollIntervalMs": 5000,
            },
        )

    @app.errorhandler(404)
    def not_found(_error):
        return jsonify({"error": "Not found"}), 404

    @app.errorhandler(405)
    def method_not_allowed(_error):
        return jsonify({"error": "Method not allowed"}), 405

    if start_background_services and not app.config.get("TESTING"):
        start_mqtt_service(app)

    return app


def start_mqtt_service(app: Flask) -> MQTTService | None:
    existing = app.extensions.get("rescuenet_mqtt")
    if existing is not None:
        return existing
    try:
        service = MQTTService(app.config["DATABASE_PATH"])
        service.start()
        app.extensions["rescuenet_mqtt"] = service
        atexit.register(service.stop)
        return service
    except RuntimeError as exc:
        LOGGER.error("MQTT service unavailable: %s", exc)
        database.set_service_state(
            "mqtt",
            "not_available",
            {"error": str(exc)},
            database_path=app.config["DATABASE_PATH"],
        )
        return None


def main() -> None:
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = create_app(start_background_services=True)
    LOGGER.info("Flask listening on http://%s:%s", config.HOST, config.PORT)
    app.run(
        host=config.HOST,
        port=config.PORT,
        debug=False,
        use_reloader=False,
        threaded=True,
    )


if __name__ == "__main__":
    main()
