"""Command line: python -m sil <command>

  migrate                 create / upgrade the schema
  ingest [source ...]     load public sources (default: every core source). Core sources:
                          sec, efts, fred, gpr, fema, noaa, storms
                          secdocs: the filing documents on www.sec.gov (needs SIL_SEC_USER_AGENT in .env)
                          plus each data domain's own sources (sil/domains.py)
  views                   rebuild the core layer: SQL views, standardized financials, quarterly drivers, the
                          listing-status check and every data domain's tables
  domains [name ...]      rebuild and export only the data domains (claims, catastrophe, people, ma); no model
  model                   fit the models and run the reference scenario simulations
  export                  fit (as above) and write the dashboard's JSON files
  all                     migrate, ingest the core sources, views, model, export

Environment:
  SIL_BUNDLE_CACHE=path   export: reuse a pickled model bundle instead of refitting
  SIL_RESIMULATE=1        with SIL_BUNDLE_CACHE: keep the fit, re-run the company simulations (status changes)
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from . import db
from .http import Fetcher

log = logging.getLogger("sil")

CORE_SOURCES = ("sec", "efts", "fred", "gpr", "fema", "noaa", "storms")


def run_ingest(conn, fetcher: Fetcher, sources: list[str]) -> None:
    from . import domains
    from .sources import sec

    domain_sources = domains.sources()
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
        elif source == "secdocs":
            from .sources import sec_docs

            sec_docs.ingest_index(conn, fetcher)
            sec_docs.fetch_documents(conn, fetcher)
        elif source in domain_sources:
            domain_sources[source][1](conn, fetcher)
        else:
            names = ", ".join([*CORE_SOURCES, "secdocs", *domain_sources])
            raise SystemExit(f"unknown source {source!r}; choose from {names}")
        log.info("== %s done in %.1fs (network %d, cache %d)", source, time.time() - t0,
                 fetcher.network_requests, fetcher.cache_hits)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sil")
    parser.add_argument("command", choices=("migrate", "ingest", "views", "domains", "model", "export", "all"))
    parser.add_argument("names", nargs="*", help="sources for ingest, domain names for domains")
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
        run_ingest(conn, fetcher, args.names or list(CORE_SOURCES))
    if args.command in ("views", "all"):
        from . import domains, drivers, standardize, status

        log.info("standardize: %s", standardize.build(conn))
        drivers.build(conn)
        status.build(conn)
        domains.build(conn)
    if args.command == "domains":
        from . import domains
        from .export import write

        names = args.names or list(domains.DOMAINS)
        unknown = sorted(set(names) - set(domains.DOMAINS))
        if unknown:
            raise SystemExit(f"unknown domain(s) {unknown}; choose from {', '.join(domains.DOMAINS)}")
        domains.build(conn, names)
        domains.export(conn, write, names)
        return 0
    bundle = None
    if args.command in ("model", "all", "export"):
        import os
        import pickle

        from .model import pipeline

        cache = os.environ.get("SIL_BUNDLE_CACHE")
        if args.command == "export" and cache and os.path.exists(cache):
            with open(cache, "rb") as fh:
                bundle = pickle.load(fh)
            log.info("using the cached model bundle %s", cache)
            if os.environ.get("SIL_RESIMULATE") == "1":
                bundle = pipeline.resimulate(conn, bundle)
        else:
            bundle = pipeline.run(conn)
    if args.command in ("export", "all"):
        from . import export, status

        status.check(conn)
        log.info("export sizes: %s", export.run(conn, bundle))
    return 0


if __name__ == "__main__":
    sys.exit(main())
