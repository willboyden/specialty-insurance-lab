"""SEC full-text search (efts.sec.gov): which 10-K / 10-Q filings mention a risk theme.

For each phrase we page through every matching document of the universe's insurers (2001 onward) and store
one row per (company, theme, filing). Dividing by the company's 10-K/10-Q count in raw.sec_filing gives the
share of its filings that discuss the theme in a year: a simple, reproducible disclosure-intensity signal.
"""

from __future__ import annotations

import logging
from datetime import date
from urllib.parse import quote

from ..db import ingest_run
from ..http import Fetcher
from ..universe import insurers

log = logging.getLogger(__name__)

# theme -> phrases (a filing counts for the theme if any phrase appears in any of its documents)
THEMES: dict[str, list[str]] = {
    "ai": ["artificial intelligence", "generative AI", "machine learning", "large language model"],
    "climate": ["climate change", "climate-related"],
    "geopolitical": ["geopolitical"],
    "war_conflict": ["Russia-Ukraine", "Russia and Ukraine", "war in Ukraine", "Israel-Hamas", "Middle East conflict"],
    "tariffs_trade": ["tariff"],
    "social_inflation": ["social inflation", "litigation funding", "nuclear verdict"],
    "cyber": ["cyber", "cybersecurity"],
    "wildfire": ["wildfire"],
    "hurricane": ["hurricane"],
    "convective_storm": ["convective storm"],
    "pandemic": ["pandemic"],
    "political_risk_line": ["political risk"],
    "trade_credit_line": ["trade credit"],
    "aviation_line": ["aviation"],
    "marine_line": ["marine"],
    "d_and_o": ["directors and officers", "D&O"],
    "securities_litigation": ["securities class action"],
}
FORMS = "10-K,10-Q,10-K405,10-KT"
PAGE = 100
MAX_FROM = 9900  # efts caps results at 10,000 per query


def _query_url(phrase: str, ciks: str, start: str, end: str, offset: int) -> str:
    return (
        "https://efts.sec.gov/LATEST/search-index?q=" + quote(f'"{phrase}"') + f"&forms={FORMS}&ciks={ciks}"
        f"&dateRange=custom&startdt={start}&enddt={end}&from={offset}"
    )


def _windows(start_year: int, end: date) -> list[tuple[str, str]]:
    """Five-year windows, so no single query hits the 10,000-result cap."""
    out = []
    y = start_year
    while y <= end.year:
        y2 = min(y + 4, end.year)
        out.append((f"{y}-01-01", end.isoformat() if y2 == end.year else f"{y2}-12-31"))
        y = y2 + 1
    return out


def ingest(conn, fetcher: Fetcher, today: date | None = None) -> None:
    today = today or date.today()
    companies = insurers()
    wanted = {c.cik for c in companies}
    ciks = ",".join(f"{c.cik:010d}" for c in companies)
    with ingest_run(conn, "efts") as info:
        conn.execute("delete from raw.efts_term_hit")
        counts = {}
        for theme, phrases in THEMES.items():
            seen: set[tuple[int, str]] = set()
            rows = []
            for phrase in phrases:
                for start, end in _windows(2001, today):
                    offset = 0
                    while True:
                        data = fetcher.get_json(_query_url(phrase, ciks, start, end, offset), max_age_s=7 * 24 * 3600)
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
            with conn.cursor() as cur:
                cur.executemany(
                    "insert into raw.efts_term_hit(cik, term_key, accession, form, file_date, period_end)"
                    " values (%s,%s,%s,%s,%s,%s) on conflict do nothing",
                    rows,
                )
            conn.commit()
            counts[theme] = len(rows)
            log.info("efts %-22s %6d filings", theme, len(rows))
        info["rows"] = sum(counts.values())
        info["detail"] = counts
