"""Create or safely migrate the RescueNet SQLite database."""

from __future__ import annotations

import logging
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config  # noqa: E402
from services.database import init_database  # noqa: E402


def main() -> int:
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    migrations = init_database(config.DATABASE_PATH)
    print(f"RescueNet database ready: {config.DATABASE_PATH}")
    if migrations:
        print("Migrations applied:")
        for migration in migrations:
            print(f"- {migration}")
    else:
        print("No additive migrations were required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

