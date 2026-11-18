"""FRED (Federal Reserve Bank of St. Louis): macro, market, insurance-pricing and loss-cost series.

Downloaded as CSV from fredgraph.csv (no API key). The series title is read from the series page itself,
so the database never carries a hand-typed (possibly wrong) name.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date

from ..db import copy_rows, ingest_run
from ..http import Fetcher

log = logging.getLogger(__name__)
DAY = 24 * 3600

# Index series whose owners restrict redistribution (S&P, Nasdaq, Cboe, Moody's, ICE) are deliberately NOT
# collected: credit stress comes from the Chicago Fed NFCI and equity returns are a stated assumption.
RESTRICTED = {"SP500", "NASDAQ100", "NASDAQCOM", "VIXCLS", "BAA10Y", "BAMLH0A0HYM2", "BAMLC0A0CM"}

# id: (units, frequency, role)
SERIES: dict[str, tuple[str, str, str]] = {
    # interest rates -> reinvestment yields and bond marks
    "DGS10": ("percent", "daily", "rates"),
    "DGS2": ("percent", "daily", "rates"),
    "DGS5": ("percent", "daily", "rates"),
    "T10YIE": ("percent", "daily", "rates"),
    # the economy -> exposure growth (payrolls, revenues, construction)
    "GDP": ("billions of dollars, SAAR", "quarterly", "macro"),
    "GDPC1": ("billions of chained 2017 dollars, SAAR", "quarterly", "macro"),
    "UNRATE": ("percent", "monthly", "macro"),
    "USREC": ("indicator (1 = recession)", "monthly", "macro"),
    "CPIAUCSL": ("index 1982-84=100, SA", "monthly", "macro"),
    "NFCI": ("index (0 = average conditions)", "weekly", "macro"),
    "TLNRESCONS": ("millions of dollars, SAAR", "monthly", "macro"),
    # geopolitics and policy
    "DCOILBRENTEU": ("dollars per barrel", "daily", "geopolitics"),
    "USEPUINDXM": ("index", "monthly", "geopolitics"),
    # insurance pricing: producer price indexes of direct P&C insurers, by line
    "PCU524126524126": ("index", "monthly", "pricing"),
    "PCU5241265241263": ("index", "monthly", "pricing"),
    "PCU5241265241264": ("index", "monthly", "pricing"),
    "PCU524126524126402": ("index", "monthly", "pricing"),
    "PCU524126524126403": ("index", "monthly", "pricing"),
    "PCU5241265241265": ("index", "monthly", "pricing"),
    "PCU5241265241266": ("index", "monthly", "pricing"),
    "PCU5241265241267": ("index", "monthly", "pricing"),
    "PCU5241265241262": ("index", "monthly", "pricing"),
    "PCU5241265241261": ("index", "monthly", "pricing"),
    # loss-cost inflation (claim severity, social inflation)
    "CPIMEDSL": ("index 1982-84=100, SA", "monthly", "loss_cost"),
    "CUSR0000SAM2": ("index 1982-84=100, SA", "monthly", "loss_cost"),
    "CUSR0000SETD": ("index 1982-84=100, SA", "monthly", "loss_cost"),
    "PCU541110541110": ("index", "monthly", "loss_cost"),
}

TITLE_RE = re.compile(r"<title>\s*(.*?)\s*\|\s*FRED", re.DOTALL)


def _title(fetcher: Fetcher, series_id: str) -> str:
    html = fetcher.get(f"https://fred.stlouisfed.org/series/{series_id}", max_age_s=30 * DAY).decode("utf-8", "replace")
    m = TITLE_RE.search(html)
    if not m:
        raise RuntimeError(f"no title on the FRED page for {series_id}")
    title = re.sub(r"\s*\(" + re.escape(series_id) + r"\)\s*$", "", m.group(1)).strip()
    return title.replace("&#39;", "'").replace("&amp;", "&")


def ingest(conn, fetcher: Fetcher) -> None:
    with ingest_run(conn, "fred") as info:
        total = 0
        for sid, (units, freq, role) in SERIES.items():
            title = _title(fetcher, sid)
            body = fetcher.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", max_age_s=DAY)
            reader = csv.reader(io.StringIO(body.decode()))
            header = next(reader)
            if len(header) != 2 or header[1] != sid:
                raise RuntimeError(f"unexpected FRED CSV header for {sid}: {header}")
            rows = []
            for d, v in reader:
                if v in ("", "."):
                    continue
                rows.append((sid, date.fromisoformat(d), float(v)))
            conn.execute("delete from raw.fred_series where series_id = %s", (sid,))
            conn.execute(
                "insert into raw.fred_series(series_id, title, units, frequency, role, source_url)"
                " values (%s,%s,%s,%s,%s,%s)",
                (sid, title, units, freq, role, f"https://fred.stlouisfed.org/series/{sid}"),
            )
            total += copy_rows(conn, "raw.fred_observation", ("series_id", "obs_date", "value"), rows)
            conn.commit()
            log.info("fred %-20s %6d obs  %s", sid, len(rows), title[:70])
        info["rows"] = total
        info["detail"] = {"series": len(SERIES)}
