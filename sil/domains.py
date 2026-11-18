"""Data domains built on top of the core underwriting panel. Each is a module sil/<name>.py with:

  SOURCES: dict[str, Callable[[conn, Fetcher], None]]   named ingest steps (python -m sil ingest <name>)
  build(conn) -> dict                                    its core tables (python -m sil views | domains)
  export(conn, write) -> None                            its dashboard JSON file(s), via write(name, obj)

Domains never touch the loss model, so they can be rebuilt and exported alone:
  python -m sil domains [claims catastrophe people ma]
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Callable, Iterable

log = logging.getLogger(__name__)

DOMAINS = ("claims", "catastrophe", "people", "ma")


def module(name: str):
    return importlib.import_module(f"sil.{name}")


def sources() -> dict[str, tuple[str, Callable]]:
    """Every domain's named ingest steps. A domain that does not import is skipped with an error in the log,
    so one broken module cannot block the other domains' ingests."""
    out: dict[str, tuple[str, Callable]] = {}
    for d in DOMAINS:
        try:
            mod = module(d)
        except ImportError as exc:
            log.error("domain %s does not import (%s); its ingest sources are unavailable", d, exc)
            continue
        for key, fn in getattr(mod, "SOURCES", {}).items():
            if key in out:
                raise RuntimeError(f"ingest source {key!r} is defined by both {out[key][0]} and {d}")
            out[key] = (d, fn)
    return out


def build(conn, names: Iterable[str] = DOMAINS) -> dict:
    results = {}
    for d in names:
        log.info("== build domain %s", d)
        results[d] = module(d).build(conn)
    return results


def export(conn, write: Callable[[str, object], int], names: Iterable[str] = DOMAINS) -> None:
    for d in names:
        log.info("== export domain %s", d)
        module(d).export(conn, write)
