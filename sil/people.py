"""People and technology: how many people each carrier employs, what it spends on technology, and how much its
filings talk about technology.

Sources (python -m sil ingest <key>):
  dol5500      DOL Form 5500 datasets: active participants of each company's 401(k) plans (US headcount proxy)
  headcount    reported headcount from each 10-K (needs the filing documents in the cache: ingest secdocs)
  efts_tech    SEC full-text search for technology themes in every 10-K and 10-Q since 2001
  people_fred  industry context from FRED (BLS employment, BEA full-time equivalents and compensation, ECI)
  ai_rd        R&D of the AI-indicator companies, from their cached companyfacts (context for the AI build-out)
XBRL figures (share-based pay, 401(k) cost, capital spending, capitalized software) come from raw.xbrl_fact.

build() writes core.people_year; export() writes people.json for the dashboard's "People and technology" section.
"""

from __future__ import annotations

import csv
import io
import itertools
import logging
import math
from collections import defaultdict
from datetime import date

from .db import copy_rows, ingest_run
from .http import Fetcher
from .sources import dol5500, headcount, tech_mentions
from .sources.fred import _title
from .universe import COMPANIES

log = logging.getLogger(__name__)
DAY = 24 * 3600
FIRST_YEAR = 2009

# industry context (titles are read from each FRED page at ingest; units noted here)
FRED_SERIES: dict[str, tuple[str, str]] = {
    "CES5552400001": ("thousands of persons, SA", "monthly"),     # All employees, insurance carriers and related
    "N4360C0A173NBEA": ("thousands", "annual"),                   # FTE employees, carriers and related (BEA)
    "N4460C0A052NBEA": ("dollars", "annual"),                     # wages and salaries per FTE, same industry (BEA)
    "CIS2025240000000I": ("index Dec 2005=100", "quarterly"),     # ECI wages and salaries, insurance carriers
}

XBRL_TAGS = {
    "sbc": ("ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"),
    "dc_cost": ("DefinedContributionPlanCostRecognized",),
    "labor": ("LaborAndRelatedExpense",),
    "capex_ppe": ("PaymentsToAcquirePropertyPlantAndEquipment",),
    "capex_productive": ("PaymentsToAcquireProductiveAssets",),
    "software_dev": ("PaymentsToDevelopSoftware",),
    "software_add": ("CapitalizedComputerSoftwareAdditions",),
    "ai_capex": ("PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"),
}


# ---------------------------------------------------------------- sources
def ingest_fred(conn, fetcher: Fetcher) -> None:
    """Industry employment and pay from FRED, stored next to the core series under role 'people' (the core FRED
    ingest deletes only its own series, so these survive it)."""
    with ingest_run(conn, "people_fred") as info:
        total = 0
        for sid, (units, freq) in FRED_SERIES.items():
            title = _title(fetcher, sid)
            body = fetcher.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", max_age_s=7 * DAY)
            reader = csv.reader(io.StringIO(body.decode()))
            header = next(reader)
            if len(header) != 2 or header[1] != sid:
                raise RuntimeError(f"unexpected FRED CSV header for {sid}: {header}")
            rows = [(sid, date.fromisoformat(d), float(v)) for d, v in reader if v not in ("", ".")]
            conn.execute("delete from raw.fred_series where series_id = %s", (sid,))
            conn.execute(
                "insert into raw.fred_series(series_id, title, units, frequency, role, source_url)"
                " values (%s,%s,%s,%s,'people',%s)",
                (sid, title, units, freq, f"https://fred.stlouisfed.org/series/{sid}"),
            )
            total += copy_rows(conn, "raw.fred_observation", ("series_id", "obs_date", "value"), rows)
            conn.commit()
            log.info("fred %-20s %6d obs  %s", sid, len(rows), title[:70])
        info["rows"] = total


def ingest_ai_rd(conn, fetcher: Fetcher) -> None:
    """Annual R&D of the AI-indicator companies from their companyfacts JSON (already cached by the SEC ingest;
    the core load keeps only their capex tags)."""
    with ingest_run(conn, "ai_rd") as info:
        rows = []
        for c in COMPANIES:
            if c.cohort != "ai_indicator":
                continue
            facts = fetcher.get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{c.cik:010d}.json")
            units = facts.get("facts", {}).get("us-gaap", {}).get("ResearchAndDevelopmentExpense", {}).get("units", {})
            best: dict[date, tuple[str, float]] = {}
            for f in units.get("USD", []):
                if not f.get("start") or f.get("form") not in ("10-K", "10-K/A"):
                    continue
                start, end = date.fromisoformat(f["start"]), date.fromisoformat(f["end"])
                if not 350 <= (end - start).days + 1 <= 380:
                    continue
                if end not in best or f["filed"] > best[end][0]:
                    best[end] = (f["filed"], float(f["val"]))
            for end, (_filed, val) in best.items():
                rows.append((c.cik, end.year if end.month >= 6 else end.year - 1, end, val))
        conn.execute("delete from raw.ai_rd_annual")
        info["rows"] = copy_rows(conn, "raw.ai_rd_annual", ("cik", "fiscal_year", "period_end", "rd_usd"), rows)
        conn.commit()


SOURCES: dict = {
    "dol5500": dol5500.ingest,
    "headcount": headcount.ingest,
    "efts_tech": tech_mentions.ingest,
    "people_fred": ingest_fred,
    "ai_rd": ingest_ai_rd,
}


# ---------------------------------------------------------------- build
def _annual_xbrl(conn, tags: list[str]) -> dict[tuple[int, str, int], float]:
    """(cik, tag, fiscal year) -> latest-filed annual value (duration 350-380 days, USD)."""
    rows = conn.execute(
        """select distinct on (cik, tag, period_end) cik, tag, period_end, value
           from raw.xbrl_fact
           where taxonomy = 'us-gaap' and unit = 'USD' and tag = any(%s)
             and period_start is not null and (period_end - period_start + 1) between 350 and 380
           order by cik, tag, period_end, filed desc, accession desc""",
        (tags,),
    ).fetchall()
    out: dict[tuple[int, str, int], float] = {}
    for cik, tag, end, value in rows:
        fy = end.year if end.month >= 6 else end.year - 1
        out[(cik, tag, fy)] = float(value)
    return out


def plan_participants(conn) -> dict[tuple[int, int], tuple[int, int, list[str]]]:
    """(cik, plan year) -> (active participants summed over the company's 401(k) plans, plans, sponsors).

    One row per plan and plan year (a plan filed late for several years appears several times in one dataset;
    the latest filing wins), plans with a 401(k) feature only (pension code 2J), zero counts dropped (a final
    filing of a frozen plan), and each sponsor kept only inside its SPONSORS years."""
    bounds = dol5500.year_bounds()
    rows = conn.execute(
        """with p as (
             select *, (extract(year from plan_year_end)
                        - case when extract(month from plan_year_end) < 6 then 1 else 0 end)::int as py
             from raw.dol5500_plan
             where pension_codes like '%%2J%%' and plan_year_end is not null and active_eoy > 0)
           select distinct on (cik, sponsor_ein, plan_number, py) cik, sponsor_ein, sponsor_name, plan_number, py,
                  active_eoy
           from p order by cik, sponsor_ein, plan_number, py, date_received desc nulls last, form_year desc"""
    ).fetchall()
    agg: dict[tuple[int, int], list] = defaultdict(lambda: [0, 0, set()])
    for cik, ein, sponsor, _pn, py, active in rows:
        lo, hi = bounds.get((cik, ein), (None, None))
        if (lo is not None and py < lo) or (hi is not None and py > hi):
            continue
        a = agg[(cik, py)]
        a[0] += active
        a[1] += 1
        a[2].add(sponsor)
    return {k: (v[0], v[1], sorted(v[2])) for k, v in agg.items()}


def reported_headcount(conn) -> dict[tuple[int, int], dict]:
    """(cik, fiscal year) -> the 10-K headcount (an original report wins over an amendment)."""
    out: dict[tuple[int, int], dict] = {}
    for acc, cik, form, fdate, fy, emp, full, as_of, snippet, method, url in conn.execute(
        """select accession, cik, form, filing_date, fiscal_year, employees, full_time, as_of, snippet, method,
                  doc_url
           from raw.headcount_10k where employees is not null
           order by cik, fiscal_year, (form like '%%/A') desc, filing_date"""
    ):
        out[(cik, fy)] = {"employees": emp, "fullTime": full, "asOf": as_of.isoformat() if as_of else None,
                          "snippet": snippet, "method": method, "url": url, "accession": acc, "filed": str(fdate),
                          "form": form}
    return out


def build(conn) -> dict:
    company_year = {
        (cik, fy): (npe, er) for cik, fy, npe, er in conn.execute(
            "select cik, fiscal_year, npe, expense_ratio from core.company_year where npe is not null and npe > 0")
    }
    status = {c.cik: (c.status, c.status_year) for c in COMPANIES}
    plans = plan_participants(conn)
    heads = reported_headcount(conn)
    tags = sorted({t for ts in XBRL_TAGS.values() for t in ts})
    x = _annual_xbrl(conn, tags)

    def first(cik: int, fy: int, key: str) -> float | None:
        for t in XBRL_TAGS[key]:
            v = x.get((cik, t, fy))
            if v is not None:
                return v
        return None

    rows = []
    for (cik, fy), (npe, er) in sorted(company_year.items()):
        st, sy = status.get(cik, ("active", None))
        if fy < FIRST_YEAR or (st != "active" and sy is not None and fy > sy):
            continue
        plan = plans.get((cik, fy))
        head = heads.get((cik, fy))
        productive = first(cik, fy, "capex_productive")
        ppe = first(cik, fy, "capex_ppe")
        dev = first(cik, fy, "software_dev")
        capex = productive if productive is not None else (
            None if ppe is None and dev is None else (ppe or 0.0) + (dev or 0.0))
        software = first(cik, fy, "software_add")
        rows.append((
            cik, fy, head["employees"] if head else None, plan[0] if plan else None, plan[1] if plan else None,
            npe, er * npe if er is not None else None, first(cik, fy, "sbc"), first(cik, fy, "dc_cost"),
            first(cik, fy, "labor"), capex, software if software is not None else dev, None,
        ))
    conn.execute("delete from core.people_year")
    n = copy_rows(conn, "core.people_year",
                  ("cik", "fiscal_year", "employees_reported", "us_plan_active", "us_plan_count", "npe", "uw_expense",
                   "share_based_comp", "dc_plan_cost", "labor_expense", "capex", "software_capitalized",
                   "software_net"), rows)
    conn.commit()
    with_plan = sum(1 for r in rows if r[3] is not None)
    with_head = sum(1 for r in rows if r[2] is not None)
    log.info("people_year: %d company-years, %d with the 401(k) proxy, %d with reported headcount", n, with_plan,
             with_head)
    return {"rows": n, "with_plan": with_plan, "with_reported": with_head}


# ---------------------------------------------------------------- export
def _r(v, digits: int = 4):
    if v is None:
        return None
    v = float(v)
    if math.isnan(v) or math.isinf(v):
        return None
    if abs(v) >= 1e5:
        return round(v)
    return float(f"{v:.{digits}g}")


def _industry(conn, years: list[int]) -> dict:
    obs = defaultdict(lambda: defaultdict(list))
    for sid, d, v in conn.execute(
        "select series_id, obs_date, value from raw.fred_observation where series_id = any(%s)",
        (list(FRED_SERIES),),
    ):
        obs[sid][d.year].append(v)
    titles = {sid: t for sid, t in conn.execute(
        "select series_id, title from raw.fred_series where series_id = any(%s)", (list(FRED_SERIES),))}

    def annual(sid: str, complete: int) -> list:
        return [_r(sum(obs[sid][y]) / len(obs[sid][y])) if len(obs[sid][y]) >= complete else None for y in years]

    emp = annual("CES5552400001", 12)
    fte = annual("N4360C0A173NBEA", 1)
    wage = annual("N4460C0A052NBEA", 1)
    eci = annual("CIS2025240000000I", 4)
    eci_yoy = [None] + [_r(b / a - 1) if a and b else None for a, b in itertools.pairwise(eci)]
    return {
        "employment": emp, "fte": fte, "wagePerFte": wage, "eciYoy": eci_yoy,
        "series": [{"id": sid, "title": titles.get(sid), "units": u, "frequency": f,
                    "url": f"https://fred.stlouisfed.org/series/{sid}"} for sid, (u, f) in FRED_SERIES.items()],
    }


def _ai(conn, years: list[int]) -> dict:
    rd = defaultdict(dict)
    for cik, fy, v in conn.execute("select cik, fiscal_year, rd_usd from raw.ai_rd_annual"):
        rd[cik][fy] = v
    tags = list(XBRL_TAGS["ai_capex"])
    capex = defaultdict(dict)
    for (cik, tag, fy), v in _annual_xbrl(conn, tags).items():
        if tag == tags[0] or fy not in capex[cik]:
            capex[cik][fy] = v
    out = {}
    for c in COMPANIES:
        if c.cohort != "ai_indicator":
            continue
        out[c.ticker] = {
            "rd": [_r(rd[c.cik].get(y)) for y in years],
            "capex": [_r(capex[c.cik].get(y)) for y in years],
        }
    return out


def _tech(conn, years: list[int]) -> tuple[dict, dict]:
    """Per company: share of its 10-K/10-Q filings mentioning each technology theme, by filing year, plus the
    filing counts (so the dashboard can pool shares across companies)."""
    filings = defaultdict(dict)
    for cik, y, n in conn.execute(
        "select cik, extract(year from filing_date)::int, count(*) from raw.sec_filing"
        " where form in ('10-K','10-Q','10-K405','10-KT') group by 1, 2"
    ):
        filings[cik][y] = n
    hits = defaultdict(lambda: defaultdict(dict))
    for cik, key, y, n in conn.execute(
        "select cik, term_key, extract(year from file_date)::int, count(distinct accession) from raw.efts_tech_hit"
        " group by 1, 2, 3"
    ):
        hits[cik][key][y] = n
    # the core AI theme (artificial intelligence etc.) already exists in raw.efts_term_hit: read, never rewritten
    for cik, y, n in conn.execute(
        "select cik, extract(year from file_date)::int, count(distinct accession) from raw.efts_term_hit"
        " where term_key = 'ai' group by 1, 2"
    ):
        hits[cik]["ai"][y] = n
    out = {}
    for cik, by_year in filings.items():
        rec = {"filings": [by_year.get(y, 0) for y in years]}
        for key in ["ai", *tech_mentions.TECH_THEMES]:
            rec[key] = [_r(min(1.0, hits[cik][key].get(y, 0) / by_year[y]), 3) if by_year.get(y) else None
                        for y in years]
        out[str(cik)] = rec
    themes = {"ai": ["artificial intelligence", "generative AI", "machine learning", "large language model"],
              **tech_mentions.TECH_THEMES}
    return out, themes


def export(conn, write) -> None:
    this_year = date.today().year
    years = list(range(FIRST_YEAR, this_year))  # complete fiscal years
    tech_years = list(range(2010, this_year + 1))  # filing years; the current one is to date
    people = defaultdict(dict)
    for (cik, fy, emp, plan, nplans, npe, uw, sbc, dc, labor, capex, sw) in conn.execute(
        """select cik, fiscal_year, employees_reported, us_plan_active, us_plan_count, npe, uw_expense,
                  share_based_comp, dc_plan_cost, labor_expense, capex, software_capitalized
           from core.people_year"""
    ):
        people[cik][fy] = (emp, plan, nplans, npe, uw, sbc, dc, labor, capex, sw)
    plans = plan_participants(conn)
    heads = reported_headcount(conn)
    tech, themes = _tech(conn, tech_years)
    companies = {}
    for c in COMPANIES:
        if c.cohort == "ai_indicator" or c.cik not in people:
            continue
        p = people[c.cik]

        def col(i: int, p=p) -> list:
            return [_r(p[y][i]) if y in p else None for y in years]

        sponsors = sorted({s for (cik, _y), v in plans.items() if cik == c.cik for s in v[2]})
        src = [dict(fiscalYear=fy, **h) for (cik, fy), h in sorted(heads.items()) if cik == c.cik]
        companies[str(c.cik)] = {
            "employees": col(0), "plan": col(1), "plans": col(2), "npe": col(3), "uwExpense": col(4), "sbc": col(5),
            "dcCost": col(6), "labor": col(7), "capex": col(8), "software": col(9),
            "sponsors": sponsors, "headcountSources": src[-3:],
            "tech": tech.get(str(c.cik)),
        }
    docs = conn.execute(
        "select count(*) filter (where employees is not null), count(*) from raw.headcount_10k").fetchone()
    listed = conn.execute(
        "select count(*) from raw.sec_document where kind = 'annual' and doc_type in ('10-K','10-K405','10-KT')"
    ).fetchone()[0]
    plan_years = conn.execute("select min(form_year), max(form_year), count(*) from raw.dol5500_plan").fetchone()
    write("people.json", {
        "version": 1,
        "years": years,
        "techYears": tech_years,
        "companies": companies,
        "themes": themes,
        "industry": _industry(conn, years),
        "ai": _ai(conn, years),
        "coverage": {
            "headcountReports": docs[1], "headcountFound": docs[0], "annualReportsListed": listed,
            "planYears": [plan_years[0], plan_years[1]], "planRows": plan_years[2],
            "companiesWithPlan": sum(1 for v in companies.values() if any(x is not None for x in v["plan"])),
            "companiesWithReported": sum(1 for v in companies.values() if any(x is not None for x in v["employees"])),
        },
        "sources": {
            "form5500": "https://www.dol.gov/agencies/ebsa/about-ebsa/our-activities/public-disclosure/foia/form-5500-datasets",
            "efts": "https://efts.sec.gov/LATEST/search-index",
        },
    })
