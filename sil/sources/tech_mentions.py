"""Technology themes in the filings: SEC full-text search (efts.sec.gov) over every 10-K and 10-Q since 2001.

The same method as the core risk themes (sil/sources/efts.py, which this module reuses but never re-runs): a
filing counts for a theme when any of its phrases appears in any of its documents. Results go to their own table,
raw.efts_tech_hit, so the model's disclosure inputs (raw.efts_term_hit) never change because of this module.
"""

from __future__ import annotations

import logging
from datetime import date

from ..db import ingest_run
from ..http import Fetcher
from ..universe import insurers
from .efts import MAX_FROM, PAGE, _query_url, _windows

log = logging.getLogger(__name__)
WEEK = 7 * 24 * 3600

# theme -> phrases. Kept narrow on purpose: "cloud" alone or "digital" alone would catch weather and marketing.
TECH_THEMES: dict[str, list[str]] = {
    "generative_ai": ["generative AI", "generative artificial intelligence", "large language model",
                      "large language models"],
    "machine_learning": ["machine learning"],
    "data_analytics": ["data analytics", "predictive analytics", "predictive modeling", "advanced analytics",
                       "data science"],
    "cloud": ["cloud computing", "cloud-based", "cloud platform", "cloud migration", "cloud infrastructure"],
    "automation": ["automation", "robotic process automation"],
    "digital": ["digital transformation", "digitization", "digital platform", "digital capabilities"],
    "modernization": ["legacy systems", "system modernization", "technology modernization",
                      "policy administration system"],
    "insurtech": ["insurtech"],
}


def ingest(conn, fetcher: Fetcher, today: date | None = None) -> None:
    today = today or date.today()
    companies = insurers()
    wanted = {c.cik for c in companies}
    ciks = ",".join(f"{c.cik:010d}" for c in companies)
    with ingest_run(conn, "efts_tech") as info:
        counts = {}
        for theme, phrases in TECH_THEMES.items():
            seen: set[tuple[int, str]] = set()
            rows = []
            for phrase in phrases:
                for start, end in _windows(2001, today):
                    offset = 0
                    while True:
                        data = fetcher.get_json(_query_url(phrase, ciks, start, end, offset), max_age_s=WEEK)
                        hits = data["hits"]["hits"]
                        total = data["hits"]["total"]["value"]
                        if data["hits"]["total"].get("relation") != "eq" or total > MAX_FROM + PAGE:
                            log.warning("efts %r %s..%s: %s results, capped", phrase, start, end, total)
                        for h in hits:
                            s = h["_source"]
                            for cik_s in s.get("ciks") or []:
                                cik = int(cik_s)
                                if cik not in wanted or (cik, s["adsh"]) in seen:
                                    continue
                                seen.add((cik, s["adsh"]))
                                rows.append((cik, theme, s["adsh"], (s.get("root_forms") or [s.get("form")])[0],
                                             s.get("file_date"), s.get("period_ending") or None))
                        offset += PAGE
                        if not hits or offset >= total or offset > MAX_FROM:
                            break
            conn.execute("delete from raw.efts_tech_hit where term_key = %s", (theme,))
            with conn.cursor() as cur:
                cur.executemany(
                    "insert into raw.efts_tech_hit(cik, term_key, accession, form, file_date, period_end)"
                    " values (%s,%s,%s,%s,%s,%s) on conflict do nothing",
                    rows,
                )
            conn.commit()
            counts[theme] = len(rows)
            log.info("efts tech %-18s %6d filings", theme, len(rows))
        info["rows"] = sum(counts.values())
        info["detail"] = counts
