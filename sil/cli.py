"""Command line: python -m sil <command>

  migrate                 create / upgrade the schema
  ingest [source ...]     load public sources (default: all). Sources:
                          sec, efts, fred, gpr, fema, noaa, storms
  views                   rebuild the core layer: SQL views, standardized financials, quarterly drivers
  model                   fit the models and run the reference scenario simulations
  export                  fit (as above) and write the dashboard's JSON files
  all                     migrate, ingest everything, views, model, export
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from . import db
from .http import Fetcher

log = logging.getLogger("sil")

SOURCES = ("sec", "efts", "fred", "gpr", "fema", "noaa", "storms")


def run_ingest(conn, fetcher: Fetcher, sources: list[str]) -> None:
    from .sources import sec

    for source in sources:
        t0 = time.time()
        log.info("== ingest %s", source)
        if source == "sec":
            sec.load_reference(conn)
            sec.ingest_submissions(conn, fetcher)
            sec.ingest_companyfacts(conn, fetcher)
        elif source == "efts":
            from .sources import efts

            efts.ingest(conn, fetcher)
        elif source == "fred":
            from .sources import fred

            fred.ingest(conn, fetcher)
        elif source == "gpr":
            from .sources import gpr

            gpr.ingest(conn, fetcher)
        elif source == "fema":
            from .sources import fema

            fema.ingest(conn, fetcher)
        elif source == "noaa":
            from .sources import noaa

            noaa.ingest_billion_events(conn, fetcher)
            noaa.ingest_global_temp(conn, fetcher)
        elif source == "storms":
            from .sources import noaa

            noaa.ingest_storm_events(conn, fetcher)
        else:
            raise SystemExit(f"unknown source {source!r}; choose from {', '.join(SOURCES)}")
        log.info("== %s done in %.1fs (network %d, cache %d)", source, time.time() - t0,
                     fetcher.network_requests, fetcher.cache_hits)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sil")
    parser.add_argument("command", choices=("migrate", "ingest", "views", "model", "export", "all"))
    parser.add_argument("sources", nargs="*")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    conn = db.connect()
    fetcher = Fetcher()
    if args.command in ("migrate", "all"):
        log.info("migrations applied: %s", db.migrate(conn) or "none")
    if args.command in ("ingest", "all"):
        run_ingest(conn, fetcher, args.sources or list(SOURCES))
    bundle = None
    if args.command in ("views", "all"):
        from . import drivers, standardize

        log.info("standardize: %s", standardize.build(conn))
        drivers.build(conn)
    if args.command in ("model", "all", "export"):
        import os
        import pickle

        from .model import pipeline

        cache = os.environ.get("SIL_BUNDLE_CACHE")
        if args.command == "export" and cache and os.path.exists(cache):
            with open(cache, "rb") as fh:
                bundle = pickle.load(fh)
            log.info("using the cached model bundle %s", cache)
        else:
            bundle = pipeline.run(conn)
    if args.command in ("export", "all"):
        from . import export

        log.info("export sizes: %s", export.run(conn, bundle))
    return 0


if __name__ == "__main__":
    sys.exit(main())
