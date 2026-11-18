"""NOAA NCEI climate and catastrophe data.

- Billion-Dollar Weather and Climate Disasters, 1980-2024 (NOAA stopped updating the product in 2025;
  the 1980-2024 file is still published).
- Global land and ocean temperature departures (Climate at a Glance), monthly, vs the 1901-2000 mean.
- Storm Events Database detail files (2000-), aggregated to month x state x event type on load.
"""

from __future__ import annotations

import csv
import gzip
import io
import logging
import re
from collections import defaultdict
from datetime import date

from ..db import copy_rows, ingest_run
from ..http import Fetcher

log = logging.getLogger(__name__)
DAY = 24 * 3600
BILLIONS_URL = "https://www.ncei.noaa.gov/access/billions/events-US-1980-2024.csv"
CAG_URL = (
    "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean/1/0/"
    "1880-2026/data.csv"
)
STORMS_DIR = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
FIRST_STORM_YEAR = 2000


def _yyyymmdd(value: str) -> date:
    return date(int(value[:4]), int(value[4:6]), int(value[6:8]))


def ingest_billion_events(conn, fetcher: Fetcher) -> None:
    with ingest_run(conn, "noaa_billions") as info:
        text = fetcher.get(BILLIONS_URL, max_age_s=30 * DAY).decode("utf-8-sig")
        lines = text.splitlines()
        start = next(i for i, line in enumerate(lines) if line.startswith("Name,Disaster"))
        rows = []
        for r in csv.DictReader(lines[start:]):
            rows.append((
                r["Name"], r["Disaster"], _yyyymmdd(r["Begin Date"]),
                _yyyymmdd(r["End Date"]) if r["End Date"] else None,
                float(r["CPI-Adjusted Cost"]), float(r["Unadjusted Cost"]), int(r["Deaths"] or 0),
            ))
        conn.execute("delete from raw.noaa_billion_event")
        info["rows"] = copy_rows(
            conn, "raw.noaa_billion_event",
            ("name", "disaster_type", "begin_date", "end_date", "cpi_adjusted_cost_musd", "unadjusted_cost_musd",
             "deaths"),
            rows,
        )
        conn.commit()
        log.info("noaa billion-dollar events: %d", info["rows"])


def ingest_global_temp(conn, fetcher: Fetcher) -> None:
    """Annual mean of the monthly global departures (only complete years)."""
    with ingest_run(conn, "noaa_global_temp") as info:
        text = fetcher.get(CAG_URL, max_age_s=7 * DAY).decode()
        months = defaultdict(list)
        for line in text.splitlines():
            if not line or line.startswith(("#", "Date")):
                continue
            ym, value = line.split(",")[:2]
            months[int(ym[:4])].append(float(value))
        rows = [(y, sum(v) / len(v)) for y, v in sorted(months.items()) if len(v) == 12]
        monthly = []
        for line in text.splitlines():
            if line and line[0].isdigit():
                ym, value = line.split(",")[:2]
                monthly.append((date(int(ym[:4]), int(ym[4:6]), 1), float(value)))
        conn.execute("delete from raw.noaa_global_temp_month")
        copy_rows(conn, "raw.noaa_global_temp_month", ("month", "anomaly_c"), monthly)
        conn.execute("delete from raw.noaa_global_temp")
        info["rows"] = copy_rows(conn, "raw.noaa_global_temp", ("year", "anomaly_c"), rows)
        conn.commit()
        log.info("noaa global temperature: %d complete years, last %d", len(rows), rows[-1][0])


_DAMAGE = re.compile(r"^\s*([0-9.]*)\s*([KMBkmbHh]?)\s*$")
_MULT = {"": 1.0, "H": 1e2, "K": 1e3, "M": 1e6, "B": 1e9}


def parse_damage(value: str) -> float:
    """Storm Events damage strings: '10.00K', '2.5M', '1B', 'K' (= 0), '' (= 0)."""
    if not value:
        return 0.0
    m = _DAMAGE.match(value)
    if not m:
        return 0.0
    number, suffix = m.groups()
    if not number:
        return 0.0
    return float(number) * _MULT[suffix.upper()]


def ingest_storm_events(conn, fetcher: Fetcher) -> None:
    with ingest_run(conn, "noaa_storm_events") as info:
        listing = fetcher.get(STORMS_DIR, max_age_s=DAY).decode()
        files = sorted(set(re.findall(r"StormEvents_details-ftp_v1\.0_d(\d{4})_c\d{8}\.csv\.gz", listing)))
        names = {}
        for m in re.finditer(r"StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz", listing):
            year = m.group(1)
            names[year] = max(names.get(year, ""), m.group(0))
        agg: dict[tuple, list] = defaultdict(lambda: [0, 0.0, 0.0, 0, 0])
        years = [y for y in files if int(y) >= FIRST_STORM_YEAR]
        for year in years:
            body = fetcher.get(STORMS_DIR + names[year], max_age_s=30 * DAY)
            with gzip.open(io.BytesIO(body), "rt", encoding="latin-1", newline="") as fh:
                for r in csv.DictReader(fh):
                    ym = r["BEGIN_YEARMONTH"]
                    key = (date(int(ym[:4]), int(ym[4:6]), 1), r["STATE"].strip().title(), r["EVENT_TYPE"].strip())
                    a = agg[key]
                    a[0] += 1
                    a[1] += parse_damage(r["DAMAGE_PROPERTY"])
                    a[2] += parse_damage(r["DAMAGE_CROPS"])
                    a[3] += int(r["DEATHS_DIRECT"] or 0)
                    a[4] += int(r["INJURIES_DIRECT"] or 0)
            log.info("storm events %s parsed (%d keys so far)", year, len(agg))
        conn.execute("delete from raw.storm_event_month")
        info["rows"] = copy_rows(
            conn, "raw.storm_event_month",
            ("month", "state", "event_type", "n_events", "property_damage_usd", "crop_damage_usd", "deaths_direct",
             "injuries_direct"),
            [(*k, *v) for k, v in agg.items()],
        )
        conn.commit()
        info["detail"] = {"years": years, "files": [names[y] for y in years]}
