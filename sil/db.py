"""Database helpers: connections, ordered migrations, COPY-based bulk loads, run bookkeeping."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Sequence
from contextlib import contextmanager

import psycopg

from .config import MIGRATIONS, VIEWS, dsn

log = logging.getLogger(__name__)


def connect() -> psycopg.Connection:
    return psycopg.connect(dsn(), autocommit=False)


def migrate(conn: psycopg.Connection) -> list[str]:
    """Apply db/migrations/*.sql in name order, once each (tracked in meta.schema_migrations)."""
    conn.execute("create schema if not exists meta")
    conn.execute(
        "create table if not exists meta.schema_migrations("
        "version text primary key, applied_at timestamptz not null default now())"
    )
    done = {r[0] for r in conn.execute("select version from meta.schema_migrations")}
    applied = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.name in done:
            continue
        log.info("applying migration %s", path.name)
        conn.execute(path.read_text())
        conn.execute("insert into meta.schema_migrations(version) values (%s)", (path.name,))
        applied.append(path.name)
    conn.commit()
    return applied


def apply_views(conn: psycopg.Connection) -> list[str]:
    """(Re)create the derived views in db/views/*.sql, in name order. Each file is idempotent."""
    names = []
    for path in sorted(VIEWS.glob("*.sql")):
        log.info("applying view file %s", path.name)
        conn.execute(path.read_text())
        names.append(path.name)
    conn.commit()
    return names


def copy_rows(conn: psycopg.Connection, table: str, columns: Sequence[str], rows: Iterable[Sequence]) -> int:
    n = 0
    cols = ", ".join(columns)
    with conn.cursor() as cur, cur.copy(f"copy {table} ({cols}) from stdin") as copy:
        for row in rows:
            copy.write_row(row)
            n += 1
    return n


@contextmanager
def ingest_run(conn: psycopg.Connection, source: str):
    """Record one ingest in meta.ingest_run; the body sets info['rows'] and info['detail']."""
    run_id = conn.execute(
        "insert into meta.ingest_run(source, status) values (%s, 'running') returning run_id", (source,)
    ).fetchone()[0]
    conn.commit()
    info: dict = {"rows": 0, "detail": {}}
    try:
        yield info
    except Exception as exc:
        conn.rollback()
        conn.execute(
            "update meta.ingest_run set status='failed', finished_at=now(), detail=%s where run_id=%s",
            (json.dumps({"error": f"{type(exc).__name__}: {exc}"}), run_id),
        )
        conn.commit()
        raise
    conn.execute(
        "update meta.ingest_run set status='ok', finished_at=now(), rows_loaded=%s, detail=%s where run_id=%s",
        (info["rows"], json.dumps(info["detail"], default=str), run_id),
    )
    conn.commit()
