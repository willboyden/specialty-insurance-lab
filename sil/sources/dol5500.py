"""DOL Form 5500 public datasets (EFAST2): retirement-plan participants as a proxy for US headcount.

Every US employer plan with 100+ participants files Form 5500 each year, and the Department of Labor publishes
the filings as bulk datasets (public records, no key):
  https://askebsa.dol.gov/FOIA%20Files/<form year>/Latest/F_5500_<form year>_Latest.zip
Since 2009 each dataset is one form year (the year printed on the form, i.e. the plan year), "Latest" keeping
each plan's latest filing. Line 6a(2), TOT_ACTIVE_PARTCP_CNT, counts the employees actively covered by the plan
at the end of the plan year: for a 401(k) plan that is roughly everyone eligible to save in it, so the sum over a
company's 401(k) plans approximates its US headcount. It misses employees outside the US (most of a Bermuda or
London group's staff), new hires still waiting to become eligible, and staff of subsidiaries with plans under
other names.

Matching a sponsor to a company uses an explicit list of sponsor EINs (SPONSORS below). It was built by
searching every dataset for each company's names, then checking each candidate sponsor by its name, its NAICS
business code and its plan names; the search also caught many namesakes (Alterra Mountain, Destination XL,
Alleghany Memorial Hospital, Berkley College, Validus Senior Living...), which is why matching is by EIN only.
Only the sponsor, plan and count fields are loaded: the public files also carry signer names and phone numbers,
which this project never stores.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import zipfile
from datetime import date

from ..db import copy_rows, ingest_run
from ..http import Fetcher, FetchError
from ..universe import COMPANIES

log = logging.getLogger(__name__)

URL = "https://askebsa.dol.gov/FOIA%20Files/{y}/Latest/F_5500_{y}_Latest.zip"
FIRST_YEAR = 2009
DAY = 24 * 3600

# Sponsors per company: (EIN, first plan year, last plan year, sponsor as filed). Years bound a sponsor that
# changed hands (TransRe joined Alleghany in 2012; Sirius joined SiriusPoint in 2021); the build also keeps only
# the years the company itself reported premiums.
SPONSORS: dict[str, list[tuple[str, int | None, int | None, str]]] = {
    # E&S and specialty commercial
    "KNSL": [("900492124", None, None, "Kinsale Management, Inc.")],
    "RLI": [("370889946", None, None, "RLI Corp.")],
    "SKWD": [("141957288", None, 2015, "Houston International Insurance Group, Ltd."),
             ("455463484", 2016, None, "Houston International Insurance Group / Skyward Service Group")],
    "JRVR": [("050539572", None, None, "James River Group, Inc.")],
    "GBLI": [("200184863", None, None, "United America Indemnity / Global Indemnity Group / GBLI Holdings"),
             ("852619578", 2025, None, "Global Indemnity Group, LLC")],
    "ASIC": [("824910916", None, None, "Ategrity Specialty Insurance Company")],
    "PLMR": [("833972551", None, None, "Palomar Holdings, Inc.")],
    "ARX": [("852870085", None, None, "Accelerant US Services Company, LLC")],
    "PRHI": [("271298795", None, None, "Conifer Holdings, Inc.")],
    "NAVG": [("133138397", None, None, "The Navigators Group, Inc.")],
    "HCC": [("760336636", None, None, "HCC Insurance Holdings, Inc.")],
    "ARGO": [("061183996", None, None, "Argo Group US, Inc.")],
    "TWGP": [("133548249", None, None, "Tower Insurance Company of New York")],
    "MIG": [("381798156", None, None, "Meadowbrook, Inc.")],
    "ASI": [("581871038", None, None, "American Safety Insurance Services, Inc.")],
    "PROS": [("132511244", None, None, "ProSight Specialty Management Company (formerly Mutual Marine Office)")],
    "HALL": [("870447375", None, None, "Hallmark Financial Services, Inc.")],
    "AFH": [("363223936", None, None, "American Service Insurance Company (Atlas Financial Holdings 401(k))")],
    "PTVCB": [("350160330", None, None, "Baldwin & Lyons / Protective Insurance Corporation")],
    "NATL": [("341607396", None, 2015, "National Interstate Insurance Agency, Inc."),
             ("341607395", 2016, None, "National Interstate Insurance Company")],
    "SNC": [("260017421", None, None, "State National Companies, Inc.")],
    "TIG": [("411966220", None, None, "Trean Corporation")],
    # diversified specialty
    "WRB": [("221867895", None, None, "W. R. Berkley Corporation")],
    "MKL": [("541959284", None, None, "Markel Corporation / Markel Group Inc.")],
    "AFG": [("311544320", None, None, "American Financial Group, Inc.")],
    "Y": [("160366830", None, None, "RSUI Indemnity Company"),
          ("391052658", None, None, "Capitol Transamerica Corporation"),
          ("800795986", 2012, None, "Transatlantic Holdings, Inc. (joined Alleghany in 2012)")],
    "OB": [("231502700", None, 2010, "OneBeacon Insurance Company"),
           ("263300555", 2011, None, "OneBeacon Services, LLC")],
    # Bermuda and international
    "ACGL": [("061424716", None, None, "Arch Capital Group (U.S.) Inc.")],
    "AXS": [("412030082", None, None, "AXIS Specialty U.S. Services, Inc.")],
    "EG": [("222005057", None, None, "Everest Reinsurance Company")],
    "RNR": [("980141974", None, None, "RenaissanceRe Holdings Ltd.")],
    "SPNT": [("133301641", 2021, 2021, "Sirius International Holding Company (merged into SiriusPoint in 2021)"),
             ("743152132", 2022, None, "Sirius Global Services, LLC (plan for SiriusPoint companies)")],
    "AHL": [("320085193", None, None, "Aspen Insurance U.S. Services, Inc.")],
    "AWH": [("954387273", None, None, "Allied World Assurance Company (U.S.) Inc.")],
    "ENH": [("980379712", None, None, "Endurance U.S. Holdings Corp.")],
    "XL": [("061516268", None, None, "XL America, Inc.")],
    "VR": [("020266622", 2014, None, "Western World Insurance Group (joined Validus in 2014)"),
           ("980501001", None, None, "Validus Holdings / Validus Reinsurance (U.S. plan)")],
    "ALTE": [("205976277", None, None, "Max USA Holdings / Alterra USA Holdings")],
    # niche
    "AMSF": [("752069407", None, None, "AMERISAFE, Inc.")],
    "EIG": [("880442429", None, None, "Employers Insurance Company of Nevada")],
    "PRA": [("631285505", None, None, "ProAssurance Group Services Corporation")],
    "AFSI": [("043106389", None, None, "AmTrust Financial Services, Inc.")],
    "SBX": [("431436329", None, None, "SeaBright Insurance Company")],
    # standard-lines benchmark
    "TRV": [("410518860", None, None, "The Travelers Companies, Inc.")],
    "CB": [("952371728", None, None, "ACE INA Holdings / Chubb INA Holdings"),
           ("132595722", 2016, None, "The Chubb Corporation plans, after ACE acquired Chubb in 2016")],
    "HIG": [("060383750", None, None, "Hartford Fire Insurance Company")],
    "CNA": [("362114545", None, None, "Continental Casualty Company"),
            ("364034956", None, None, "CNA National Warranty Corporation"),
            ("460204900", None, None, "CNA Surety Corporation")],
    "CINF": [("310746871", None, None, "Cincinnati Financial Corporation"),
             ("310542366", None, None, "Cincinnati Financial Corporation")],
    "SIGI": [("221272390", None, None, "Selective Insurance Company of America")],
    "THG": [("135129825", None, None, "The Hanover Insurance Company")],
    "PGR": [("340963169", None, None, "The Progressive Corporation")],
    "ALL": [("363871531", None, None, "The Allstate Corporation")],
}

# required in every year's layout; the other fields read are optional (some were added after 2009)
REQUIRED = (
    "ACK_ID", "FORM_PLAN_YEAR_BEGIN_DATE", "FORM_TAX_PRD", "PLAN_NAME", "SPONS_DFE_PN", "SPONSOR_DFE_NAME",
    "SPONS_DFE_EIN", "TOT_ACTIVE_PARTCP_CNT", "TYPE_PENSION_BNFT_CODE",
)
COLUMNS = (
    "ack_id", "form_year", "cik", "match_kind", "sponsor_name", "sponsor_ein", "sponsor_state", "business_code",
    "plan_name", "plan_number", "plan_year_begin", "plan_year_end", "pension_codes", "welfare_codes", "active_eoy",
    "active_boy", "total_boy", "with_balance", "final_filing", "date_received",
)


def _int(v: str) -> int | None:
    v = (v or "").strip()
    return int(v) if v.lstrip("-").isdigit() else None


def _date(v: str) -> date | None:
    v = (v or "").strip()[:10]
    try:
        return date.fromisoformat(v) if v else None
    except ValueError:
        return None


class Matcher:
    """Sponsor EIN -> company cik, from SPONSORS."""

    def __init__(self, sponsors: dict[str, list[tuple]] = SPONSORS):
        by_ticker = {c.ticker: c.cik for c in COMPANIES}
        self.eins: dict[str, int] = {}
        for ticker, rows in sponsors.items():
            for ein, *_ in rows:
                if ein in self.eins:
                    raise ValueError(f"sponsor EIN {ein} listed for two companies")
                self.eins[ein] = by_ticker[ticker]

    def match(self, ein: str) -> int | None:
        return self.eins.get(re.sub(r"\D", "", ein or ""))


def year_bounds() -> dict[tuple[int, str], tuple[int | None, int | None]]:
    """(cik, EIN) -> (first plan year, last plan year) from SPONSORS."""
    by_ticker = {c.ticker: c.cik for c in COMPANIES}
    return {(by_ticker[t], ein): (lo, hi) for t, rows in SPONSORS.items() for ein, lo, hi, _ in rows}


def scan(body: bytes, form_year: int, matcher: Matcher) -> list[tuple]:
    """Rows of one dataset (zip bytes) whose sponsor is on the SPONSORS list; pension plans only."""
    z = zipfile.ZipFile(io.BytesIO(body))
    name = next(i.filename for i in z.infolist() if i.filename.lower().endswith(".csv"))
    rows = []
    with z.open(name) as fh:
        reader = csv.DictReader(io.TextIOWrapper(fh, encoding="latin-1", newline=""))
        missing = [k for k in REQUIRED if k not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"Form 5500 {form_year}: columns missing {missing}")
        for raw in reader:
            if not (raw["TYPE_PENSION_BNFT_CODE"] or "").strip():
                continue
            r = {k: (v or "") for k, v in raw.items() if k is not None}
            for k in ("SPONS_DFE_DBA_NAME", "SPONS_DFE_MAIL_US_STATE", "BUSINESS_CODE", "TOT_PARTCP_BOY_CNT",
                      "TOT_ACT_PARTCP_BOY_CNT", "PARTCP_ACCOUNT_BAL_CNT", "TYPE_WELFARE_BNFT_CODE",
                      "FINAL_FILING_IND", "DATE_RECEIVED"):
                r.setdefault(k, "")
            cik = matcher.match(r["SPONS_DFE_EIN"])
            if cik is None:
                continue
            kind = "ein"
            rows.append((
                r["ACK_ID"], form_year, cik, kind, " ".join(r["SPONSOR_DFE_NAME"].split()),
                re.sub(r"\D", "", r["SPONS_DFE_EIN"]), r["SPONS_DFE_MAIL_US_STATE"] or None, r["BUSINESS_CODE"] or None,
                " ".join((r["PLAN_NAME"] or "").split()) or None, r["SPONS_DFE_PN"] or None,
                _date(r["FORM_PLAN_YEAR_BEGIN_DATE"]), _date(r["FORM_TAX_PRD"]),
                (r["TYPE_PENSION_BNFT_CODE"] or "").strip() or None, (r["TYPE_WELFARE_BNFT_CODE"] or "").strip() or None,
                _int(r["TOT_ACTIVE_PARTCP_CNT"]), _int(r["TOT_ACT_PARTCP_BOY_CNT"]), _int(r["TOT_PARTCP_BOY_CNT"]),
                _int(r["PARTCP_ACCOUNT_BAL_CNT"]), (r["FINAL_FILING_IND"] or "").strip() == "1",
                _date(r["DATE_RECEIVED"]),
            ))
    return rows


def ingest(conn, fetcher: Fetcher, years: list[int] | None = None) -> None:
    """Download each form year's dataset (cached on disk once) and load the matched plans."""
    years = years or list(range(FIRST_YEAR, date.today().year))
    matcher = Matcher()
    big = Fetcher(timeout=900)  # the yearly zips are 20-40 MB
    with ingest_run(conn, "dol5500") as info:
        total = 0
        per_year = {}
        for y in years:
            try:
                body = big.get(URL.format(y=y), max_age_s=None if y < date.today().year - 2 else 30 * DAY)
            except FetchError as exc:
                log.warning("Form 5500 %d: %s", y, exc)
                continue
            rows = scan(body, y, matcher)
            seen: set[str] = set()
            rows = [r for r in rows if not (r[0] in seen or seen.add(r[0]))]
            conn.execute("delete from raw.dol5500_plan where form_year = %s", (y,))
            total += copy_rows(conn, "raw.dol5500_plan", COLUMNS, rows)
            conn.commit()
            per_year[y] = len(rows)
            log.info("Form 5500 %d: %d matched pension plans", y, len(rows))
        info["rows"] = total
        info["detail"] = {"years": per_year}
