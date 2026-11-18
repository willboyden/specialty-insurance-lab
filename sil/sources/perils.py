"""Public peril data for the catastrophe domain (US federal sources, public domain; OpenFEMA terms noted below).

  hurdat  NOAA NHC HURDAT2 Atlantic best track, 1851 onward: every track point (landfalls, intensity, ACE)
          https://www.nhc.noaa.gov/data/hurdat/
  spc     NOAA SPC severe weather database: tornado, hail and wind reports, aggregated to month x state x kind
          https://www.spc.noaa.gov/wcm/
  usgs    USGS ComCat earthquakes, magnitude 5+, US states and territories, 1973 onward
          https://earthquake.usgs.gov/fdsnws/event/1/
  nifc    NIFC wildland fires and acres per year, 1983 onward
          https://www.nifc.gov/fire-information/statistics/wildfires
  oni     NOAA CPC Oceanic Nino Index (ENSO), 1950 onward
          https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
  nfip    OpenFEMA NFIP Redacted Claims v3, losses from 2000 on, aggregated to month x state and to flood events
          https://www.fema.gov/api/open/v3/NfipClaims
          "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA.
          The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the
          data have been retrieved from the Agency's website(s)."

Every request goes through sil.http.Fetcher (generic client name; cached on disk).
"""

from __future__ import annotations

import csv
import html
import io
import logging
import re
import zipfile
from collections import defaultdict
from datetime import UTC, date, datetime
from urllib.parse import quote

from ..db import copy_rows, ingest_run
from ..http import Fetcher

log = logging.getLogger(__name__)
DAY = 24 * 3600

HURDAT_DIR = "https://www.nhc.noaa.gov/data/hurdat/"
SPC_PAGE = "https://www.spc.noaa.gov/wcm/"
SPC_DATA = "https://www.spc.noaa.gov/wcm/data/"
USGS_QUERY = "https://earthquake.usgs.gov/fdsnws/event/1/query"
NIFC_URL = "https://www.nifc.gov/fire-information/statistics/wildfires"
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
NFIP_API = "https://www.fema.gov/api/open/v3/NfipClaims"
NFIP_FIRST = "2000-01-01"
NFIP_PAGE = 10_000
NFIP_WORKERS = 4
NFIP_SELECT = ("id,dateOfLoss,state,floodEvent,amountPaidOnBuildingClaim,amountPaidOnContentsClaim,"
               "amountPaidOnIncreasedCostOfComplianceClaim")

# ---------------------------------------------------------------- HURDAT2


def hurdat_file(listing: str) -> str:
    """The newest Atlantic HURDAT2 file in the directory listing: latest season, then latest revision date."""
    best = None
    for m in re.finditer(r'href="(hurdat2-1851-(\d{4})-(\d{6,8})\.txt)"', listing):
        name, season, stamp = m.group(1), int(m.group(2)), m.group(3)
        mm, dd, yy = stamp[:2], stamp[2:4], stamp[4:]
        year = int(yy) + (2000 if len(yy) == 2 else 0)
        key = (season, year, int(mm), int(dd))
        if best is None or key > best[0]:
            best = (key, name)
    if best is None:
        raise RuntimeError("no Atlantic HURDAT2 file found in the NHC listing")
    return best[1]


def _coord(text: str) -> float:
    text = text.strip()
    v = float(text[:-1])
    return -v if text[-1] in "SW" else v


def parse_hurdat(text: str) -> list[tuple]:
    """HURDAT2 text -> (storm_id, name, season, time, record_id, status, lat, lon, wind_kt, pressure_mb) rows."""
    rows = []
    storm_id = name = None
    season = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = [p.strip() for p in line.split(",")]
        if re.fullmatch(r"[A-Z]{2}\d{6}", parts[0]):
            storm_id, name, season = parts[0], parts[1], int(parts[0][4:8])
            continue
        if storm_id is None or len(parts) < 8:
            continue
        d, hm = parts[0], parts[1].zfill(4)
        t = datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), int(hm[:2]), int(hm[2:4]))
        wind = int(parts[6]) if parts[6] not in ("", "-99", "-999") else None
        pres = int(parts[7]) if parts[7] not in ("", "-999") else None
        rows.append((storm_id, name, season, t, parts[2] or "", parts[3], _coord(parts[4]), _coord(parts[5]), wind, pres))
    return rows


def saffir_simpson(wind_kt: int | None) -> int:
    """Hurricane category from 1-minute sustained wind in knots (0 = below hurricane strength)."""
    if wind_kt is None or wind_kt < 64:
        return 0
    for cat, lo in ((5, 137), (4, 113), (3, 96), (2, 83)):
        if wind_kt >= lo:
            return cat
    return 1


def us_landfall_state(lat: float, lon: float) -> str | None:
    """Whether a HURDAT2 landfall point is on the US mainland or in Puerto Rico / the US Virgin Islands.

    Coarse coastal boxes, tuned so Mexico, Cuba, the Bahamas, Bermuda and Atlantic Canada fall outside:
    Gulf coast and Florida (Bimini is at 79.3W, the Rio Grande mouth at 25.96N), the Atlantic seaboard up to
    Lubec, Maine (66.95W), and Puerto Rico with the Virgin Islands. Returns a region code, not a state.
    """
    if 17.6 <= lat <= 18.6 and -67.4 <= lon <= -64.5:
        return "PR"
    if 24.4 <= lat <= 31.2 and -97.8 <= lon <= -79.9:
        if lat < 25.95 and lon < -96.0:  # Tamaulipas, Mexico
            return None
        return "GULF_FL"
    if 30.0 < lat <= 45.3 and -81.7 <= lon <= -66.95:
        return "ATLANTIC"
    return None


def season_stats(rows: list[tuple]) -> dict:
    """Per season: ACE, named storms, hurricanes and US landfalling hurricanes (max category at US landfall)."""
    ace = defaultdict(float)
    peak = defaultdict(int)
    named: dict[int, set] = defaultdict(set)
    hurr: dict[int, set] = defaultdict(set)
    us: dict[str, dict] = {}
    for storm_id, _name, season, t, rec, status, lat, lon, wind, _p in rows:
        if wind is not None and status in ("TS", "HU", "SS") and wind >= 34:
            named[season].add(storm_id)
        if status == "HU":
            hurr[season].add(storm_id)
        if t.minute == 0 and t.hour in (0, 6, 12, 18) and status in ("TS", "HU", "SS") and wind and wind >= 35:
            ace[season] += wind * wind / 1e4
        peak[storm_id] = max(peak[storm_id], wind or 0)
        if rec == "L" and status == "HU" and us_landfall_state(lat, lon):
            cat = saffir_simpson(wind)
            prev = us.get(storm_id)
            if prev is None:
                us[storm_id] = {"season": season, "first": t, "category": cat}
            else:
                prev["category"] = max(prev["category"], cat)
    return {"ace": dict(ace), "named": {k: len(v) for k, v in named.items()},
            "hurricanes": {k: len(v) for k, v in hurr.items()}, "us_landfalls": us}


def ingest_hurdat(conn, fetcher: Fetcher) -> int:
    with ingest_run(conn, "hurdat2") as info:
        listing = fetcher.get(HURDAT_DIR, max_age_s=7 * DAY).decode("utf-8", "replace")
        name = hurdat_file(listing)
        rows = parse_hurdat(fetcher.get(HURDAT_DIR + name, max_age_s=90 * DAY).decode("utf-8", "replace"))
        # a few records repeat a (storm, time, record) triple: keep the first
        seen: set[tuple] = set()
        unique = [r for r in rows if not ((r[0], r[3], r[4]) in seen or seen.add((r[0], r[3], r[4])))]
        conn.execute("delete from raw.hurdat_point")
        info["rows"] = copy_rows(conn, "raw.hurdat_point", ("storm_id", "storm_name", "season", "obs_time", "record_id",
                                                             "status", "lat", "lon", "wind_kt", "pressure_mb"), unique)
        conn.commit()
        info["detail"] = {"file": name, "seasons": [unique[0][2], unique[-1][2]]}
        log.info("hurdat2 %s: %d track points", name, info["rows"])
        return info["rows"]


# ---------------------------------------------------------------- SPC severe weather database

def spc_files(page: str) -> dict[str, str]:
    """The newest multi-year tornado ('actual'), hail and wind files linked from the SPC WCM page."""
    out: dict[str, tuple[int, str]] = {}
    for m in re.finditer(r'href="data/((\d{4})-(\d{4})_(actual_tornadoes|hail|wind)\.csv(?:\.zip)?)"', page):
        fname, last, kind = m.group(1), int(m.group(3)), m.group(4)
        kind = "tornado" if kind == "actual_tornadoes" else kind
        if kind not in out or last > out[kind][0]:
            out[kind] = (last, fname)
    missing = {"tornado", "hail", "wind"} - set(out)
    if missing:
        raise RuntimeError(f"SPC page lists no multi-year file for {sorted(missing)}")
    return {k: v[1] for k, v in out.items()}


def _spc_text(body: bytes, fname: str) -> str:
    if fname.endswith(".zip"):
        z = zipfile.ZipFile(io.BytesIO(body))
        return z.read(z.namelist()[0]).decode("latin-1")
    return body.decode("latin-1")


def spc_loss_scale(values_by_year: dict[int, list[float]]) -> dict[int, float | None]:
    """SPC's loss column changed units: categories before 1996, millions of dollars for a span of years, then
    dollars. Per year: None (categories), 1e6 (millions: fractional values and small maxima) or 1 (dollars)."""
    scale = {}
    for y, vals in values_by_year.items():
        pos = [v for v in vals if v > 0]
        if y < 1996:
            scale[y] = None
        elif not pos:
            scale[y] = 1.0
        elif max(pos) < 20_000 and min(pos) < 1:
            scale[y] = 1e6
        else:
            scale[y] = 1.0
    return scale


def aggregate_spc(text: str, kind: str) -> list[tuple]:
    """One SPC file -> (month, state, kind, n_reports, n_significant, injuries, fatalities, loss_usd) rows."""
    reader = list(csv.DictReader(io.StringIO(text)))
    by_year: dict[int, list[float]] = defaultdict(list)
    for r in reader:
        try:
            by_year[int(r["yr"])].append(float(r["loss"] or 0))
        except ValueError:
            continue
    scale = spc_loss_scale(by_year)
    agg: dict[tuple, list] = defaultdict(lambda: [0, 0, 0, 0, 0.0, False])
    for r in reader:
        try:
            y, mo = int(r["yr"]), int(r["mo"])
            mag = float(r["mag"]) if r["mag"] not in ("", None) else -9
        except ValueError:
            continue
        if kind == "tornado":
            sig = mag >= 2
        elif kind == "hail":
            sig = mag >= 2.0
        else:
            sig = mag >= 65
        a = agg[(date(y, mo, 1), r["st"].strip().upper(), kind)]
        a[0] += 1
        a[1] += int(sig)
        a[2] += int(float(r["inj"] or 0))
        a[3] += int(float(r["fat"] or 0))
        sc = scale.get(y)
        if sc is not None:
            a[4] += float(r["loss"] or 0) * sc
            a[5] = True
    return [(*k, a[0], a[1], a[2], a[3], a[4] if a[5] else None) for k, a in agg.items()]


def ingest_spc(conn, fetcher: Fetcher) -> int:
    with ingest_run(conn, "spc_severe_weather") as info:
        files = spc_files(fetcher.get(SPC_PAGE, max_age_s=7 * DAY).decode("utf-8", "replace"))
        rows = []
        for kind, fname in files.items():
            text = _spc_text(fetcher.get(SPC_DATA + fname, max_age_s=90 * DAY), fname)
            part = aggregate_spc(text, kind)
            rows.extend(part)
            log.info("spc %s (%s): %d month-state rows", kind, fname, len(part))
        conn.execute("delete from raw.spc_report_month")
        info["rows"] = copy_rows(conn, "raw.spc_report_month", ("month", "state", "kind", "n_reports", "n_significant",
                                                                 "injuries", "fatalities", "loss_usd"), rows)
        conn.commit()
        info["detail"] = files
        return info["rows"]


# ---------------------------------------------------------------- USGS earthquakes

USGS_BOXES = {  # lat/lon boxes queried; events are then kept only when their place names a US state/territory
    "conus": (24.0, 50.0, -125.5, -66.0),
    "alaska": (50.0, 72.0, -180.0, -129.0),
    "aleutians_west": (50.0, 56.0, 165.0, 180.0),
    "hawaii": (18.0, 23.0, -161.0, -154.0),
    "caribbean": (17.0, 19.5, -68.0, -64.5),
}
STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky",
    "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
    "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota",
    "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "PR": "Puerto Rico", "VI": "U.S. Virgin Islands",
}
_NAME_TO_CODE = {v.lower(): k for k, v in STATES.items()} | {"virgin islands": "VI", "u.s. virgin islands": "VI"}


def quake_state(place: str | None) -> str | None:
    """US state/territory code from a ComCat place string ('10 km NE of Ridgecrest, CA', 'Fox Islands, Aleutian
    Islands, Alaska', 'off the coast of Oregon'); None for other countries and open ocean."""
    if not place:
        return None
    p = place.strip()
    low = p.lower()
    if any(w in low for w in ("mexico", "canada", "british columbia", "dominican", "cuba", "russia")):
        return None
    last = p.rsplit(",", 1)[-1].strip()
    if last.upper() in STATES and len(last) == 2:
        return last.upper()
    code = _NAME_TO_CODE.get(last.lower())
    if code:
        return code
    for name, code in sorted(_NAME_TO_CODE.items(), key=lambda kv: -len(kv[0])):
        if re.search(rf"\b{re.escape(name)}\b", low):
            return code
    if "aleutian" in low:
        return "AK"
    return None


def ingest_usgs(conn, fetcher: Fetcher, start: str = "1973-01-01") -> int:
    with ingest_run(conn, "usgs_earthquakes") as info:
        end = date.today().isoformat()
        rows: dict[str, tuple] = {}
        for region, (la0, la1, lo0, lo1) in USGS_BOXES.items():
            url = (f"{USGS_QUERY}?format=geojson&starttime={start}&endtime={end}&minmagnitude=5&orderby=time-asc"
                   f"&minlatitude={la0}&maxlatitude={la1}&minlongitude={lo0}&maxlongitude={lo1}")
            data = fetcher.get_json(url, max_age_s=7 * DAY)
            kept = 0
            for ft in data.get("features", []):
                p = ft["properties"]
                st = quake_state(p.get("place"))
                if st is None or p.get("mag") is None:
                    continue
                lon, lat, depth = (ft["geometry"]["coordinates"] + [None, None, None])[:3]
                rows[ft["id"]] = (ft["id"], datetime.fromtimestamp(p["time"] / 1000, tz=UTC), float(p["mag"]),
                                  p.get("place"), st, lat, lon, depth, p.get("alert"), p.get("sig"), p.get("felt"))
                kept += 1
            log.info("usgs %s: %d events, %d in US states/territories", region, len(data.get("features", [])), kept)
        conn.execute("delete from raw.usgs_quake")
        info["rows"] = copy_rows(conn, "raw.usgs_quake", ("event_id", "time_utc", "mag", "place", "state", "lat", "lon",
                                                           "depth_km", "alert", "sig", "felt"), rows.values())
        conn.commit()
        return info["rows"]


# ---------------------------------------------------------------- NIFC wildfires

def parse_nifc(page: str) -> list[tuple[int, int, float]]:
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.DOTALL | re.IGNORECASE):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.DOTALL | re.IGNORECASE)]
        cells = [c.replace("*", "").strip() for c in cells if c]  # '*' marks footnotes (2004: no NC state lands)
        if len(cells) >= 3 and re.fullmatch(r"(19|20)\d\d", cells[0]):
            try:
                out.append((int(cells[0]), int(cells[1].replace(",", "")), float(cells[2].replace(",", ""))))
            except ValueError:
                continue
    return sorted(set(out))


def ingest_nifc(conn, fetcher: Fetcher) -> int:
    with ingest_run(conn, "nifc_wildfires") as info:
        rows = parse_nifc(fetcher.get(NIFC_URL, max_age_s=30 * DAY).decode("utf-8", "replace"))
        if len(rows) < 30:
            raise RuntimeError(f"NIFC table parsed into only {len(rows)} years")
        conn.execute("delete from raw.nifc_wildfire_year")
        info["rows"] = copy_rows(conn, "raw.nifc_wildfire_year", ("year", "fires", "acres"), rows)
        conn.commit()
        info["detail"] = {"years": [rows[0][0], rows[-1][0]]}
        return info["rows"]


# ---------------------------------------------------------------- ENSO (ONI)

ONI_MID = {"DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6, "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10,
           "OND": 11, "NDJ": 12}


def parse_oni(text: str) -> list[tuple]:
    out = []
    for line in text.splitlines():
        p = line.split()
        if len(p) == 4 and p[0] in ONI_MID and p[1].isdigit():
            out.append((int(p[1]), p[0], ONI_MID[p[0]], float(p[2]), float(p[3])))
    return out


def ingest_oni(conn, fetcher: Fetcher) -> int:
    with ingest_run(conn, "cpc_oni") as info:
        rows = parse_oni(fetcher.get(ONI_URL, max_age_s=7 * DAY).decode("utf-8", "replace"))
        conn.execute("delete from raw.enso_oni")
        info["rows"] = copy_rows(conn, "raw.enso_oni", ("year", "season", "mid_month", "total_c", "anom_c"), rows)
        conn.commit()
        return info["rows"]


# ---------------------------------------------------------------- OpenFEMA NFIP claims

class NfipAggregator:
    """Month x state totals and named-event totals from NFIP claim records."""

    def __init__(self):
        self.month: dict[tuple, list] = defaultdict(lambda: [0, 0, 0.0, 0.0, 0.0])
        self.event: dict[str, dict] = {}
        self.records = 0

    def add(self, r: dict) -> None:
        d = r.get("dateOfLoss")
        if not d:
            return
        day = date.fromisoformat(d[:10])
        st = (r.get("state") or "").strip().upper() or "??"
        b = float(r.get("amountPaidOnBuildingClaim") or 0)
        c = float(r.get("amountPaidOnContentsClaim") or 0)
        i = float(r.get("amountPaidOnIncreasedCostOfComplianceClaim") or 0)
        a = self.month[(date(day.year, day.month, 1), st)]
        a[0] += 1
        a[1] += int(b + c + i > 0)
        a[2] += b
        a[3] += c
        a[4] += i
        self.records += 1
        name = (r.get("floodEvent") or "").strip()
        if name:
            e = self.event.setdefault(name, {"first": day, "last": day, "n": 0, "paid": 0.0, "by_state": defaultdict(float)})
            e["first"] = min(e["first"], day)
            e["last"] = max(e["last"], day)
            e["n"] += 1
            e["paid"] += b + c + i
            e["by_state"][st] += b + c + i

    def month_rows(self) -> list[tuple]:
        return [(*k, *v) for k, v in self.month.items()]

    def event_rows(self) -> list[tuple]:
        return [(name, e["first"], e["last"], e["n"], e["paid"],
                 max(e["by_state"].items(), key=lambda kv: kv[1])[0] if e["by_state"] else None)
                for name, e in self.event.items()]


def nfip_url(after_id: int, upto_id: int, top: int = NFIP_PAGE, select: str = NFIP_SELECT,
             order: str = "id") -> str:
    """One keyset page: claims with a loss since 2000 and after_id < id <= upto_id, in id order."""
    flt = quote(f"dateOfLoss ge '{NFIP_FIRST}' and id gt {after_id} and id le {upto_id}")
    return f"{NFIP_API}?$select={select}&$filter={flt}&$orderby={order}&$top={top}&$inlinecount=allpages"


def _nfip_range(after_id: int, upto_id: int) -> list[dict]:
    """Every claim in one id range, page by page (each worker has its own Fetcher and client)."""
    f = Fetcher()
    out: list[dict] = []
    last = after_id
    while True:
        data = f.get_json(nfip_url(last, upto_id), max_age_s=30 * DAY)
        batch = data["NfipClaims"]
        out.extend(batch)
        if len(batch) < NFIP_PAGE:
            return out
        last = int(batch[-1]["id"])


def ingest_nfip(conn, fetcher: Fetcher) -> int:
    """NFIP claims with a loss since 2000 from the OpenFEMA API (v3). The server answers ~10,000 rows per 17 s,
    so NFIP_WORKERS workers page disjoint id ranges at once (keyset paging: every page URL is deterministic and
    cached, so a rerun is local)."""
    from concurrent.futures import ThreadPoolExecutor

    with ingest_run(conn, "openfema_nfip_claims") as info:
        lo = fetcher.get_json(nfip_url(0, 2**62, top=1, select="id"), max_age_s=30 * DAY)
        hi = fetcher.get_json(nfip_url(0, 2**62, top=1, select="id", order="id%20desc"), max_age_s=30 * DAY)
        total = int(lo["metadata"]["count"])
        first, last = int(lo["NfipClaims"][0]["id"]), int(hi["NfipClaims"][0]["id"])
        edges = [first - 1 + (last - first + 1) * k // NFIP_WORKERS for k in range(NFIP_WORKERS)] + [last]
        with ThreadPoolExecutor(max_workers=NFIP_WORKERS) as pool:
            parts = list(pool.map(lambda k: _nfip_range(edges[k], edges[k + 1]), range(NFIP_WORKERS)))
        agg = NfipAggregator()
        for part in parts:
            for r in part:
                agg.add(r)
        if agg.records != total:
            raise RuntimeError(f"NFIP returned {agg.records} claims, the API counts {total}")
        conn.execute("delete from raw.nfip_claim_month")
        conn.execute("delete from raw.nfip_event")
        n = copy_rows(conn, "raw.nfip_claim_month", ("month", "state", "n_claims", "n_paid", "paid_building",
                                                     "paid_contents", "paid_icc"), agg.month_rows())
        copy_rows(conn, "raw.nfip_event", ("flood_event", "first_loss", "last_loss", "n_claims", "paid_total",
                                           "top_state"), agg.event_rows())
        conn.commit()
        info["rows"] = n
        info["detail"] = {"claims_since_2000": agg.records, "events": len(agg.event),
                          "endpoint": f"{NFIP_API} (OpenFEMA NfipClaims v3)", "retrieved": date.today().isoformat()}
        log.info("nfip: %d claims since %s -> %d month-state rows, %d named events", agg.records, NFIP_FIRST, n,
                 len(agg.event))
        return n


def ingest_perils(conn, fetcher: Fetcher) -> None:
    """Every peril source except NFIP (which is large: its own key)."""
    ingest_hurdat(conn, fetcher)
    ingest_spc(conn, fetcher)
    ingest_usgs(conn, fetcher)
    ingest_nifc(conn, fetcher)
    ingest_oni(conn, fetcher)
