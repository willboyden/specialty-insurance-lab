"""Project paths, the database DSN and the HTTP identity.

The DSN is read from .env (created by scripts/init-env.sh, mode 600). Nothing here prints it.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache"
MIGRATIONS = ROOT / "db" / "migrations"
VIEWS = ROOT / "db" / "views"
EXPORT_DIR = ROOT / "dashboard" / "public" / "data"

# A generic client name. SEC's data.sec.gov and efts.sec.gov accept it; nothing personal is sent.
USER_AGENT = os.environ.get("SIL_USER_AGENT", "specialty-insurance-research/0.1")


def load_env() -> None:
    """Load KEY=VALUE lines from .env into os.environ (existing variables win)."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def dsn() -> str:
    load_env()
    value = os.environ.get("SIL_PG_DSN")
    if not value:
        raise SystemExit("SIL_PG_DSN is not set: run scripts/init-env.sh first")
    return value
