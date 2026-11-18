"""Claims and reserves: what each carrier pays, how its reserve estimates move, and how long its tail is.

Sources (public SEC XBRL; this module never touches the network):
  - companyfacts facts already in raw.xbrl_fact: the loss-reserve roll-forward every P&C filer discloses
    (ASC 944-40-50-3) in its 10-Qs and 10-Ks: losses paid for the current and for prior accident years, reserves
    assumed in acquisitions, FX, reinsurance recoverable on unpaid claims, IBNR and case reserves where tagged.
    Premiums, incurred losses (current and prior accident years), equity and net reserves come from
    core.company_quarter (sil/standardize.py), so every number agrees with the rest of the dashboard; annual-only
    filers (20-F) fall back to the same tags read from their annual facts.
  - 10-K XBRL instances for fiscal 2016 on, when `python -m sil ingest secdocs` has cached them: the ASU 2015-09
    claims-development tables (incurred and paid triangles by accident year and line, IBNR, cumulative reported
    claim counts, average payout pattern). Only cached documents are read.

Definitions (fiscal year t; reserves are net of reinsurance unless named gross):
  paid_lr            paid losses and LAE / net premiums earned
  incurred_lr        incurred losses and LAE / net premiums earned (the loss ratio)
  paid_to_incurred   paid / incurred: below 1 the reserves grow, above 1 the book runs off
  first_year_payout  current-accident-year paid / current-accident-year incurred: how fast new claims are paid
  runoff_speed       prior-accident-year paid / opening reserves: the share of the old book paid during the year
  survival           closing reserves / paid: years of payments held in reserve (the length of the tail)
  reserve_to_npe     closing reserves / net premiums earned
  reserve_leverage   closing reserves / equity: a 10% reserve shortfall costs 10% x this of equity
  dev_pct_open       prior-accident-year development / opening reserves (negative = favorable, a release)
  pyd_ratio          prior-accident-year development / net premiums earned (points of premium)
  ceded_share        reinsurance recoverable on unpaid claims / gross reserves
  ibnr_share         IBNR / (IBNR + case reserves) where both are tagged (usually gross)
  reserve_growth     closing / opening reserves - 1
  acquired_pct_open  reserves assumed in acquisitions / opening reserves
  rollforward_gap    (closing - (opening + incurred - paid + acquired + FX)) / opening: what the roll-forward
                     as tagged does not explain (commutations, retroactive reinsurance, untagged lines); a check
"""

from __future__ import annotations

import json
import logging
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from .concepts import CONCEPTS
from .db import copy_rows
from .sources import xbrl_instance as xi
from .standardize import RATIO_BOUNDS

log = logging.getLogger(__name__)

SOURCES: dict = {}  # nothing to download: companyfacts come from `ingest sec`, instances from `ingest secdocs`

P = "LiabilityForUnpaidClaimsAndClaimsAdjustmentExpense"
# concept -> (kind, tags in priority order)
CLAIM_TAGS: dict[str, tuple[str, list[str]]] = {
    "paid_cy": ("duration", [f"{P}ClaimsPaidCurrentYear1", f"{P}ClaimsPaidCurrentYear"]),
    "paid_py": ("duration", [f"{P}ClaimsPaidPriorYears1", f"{P}ClaimsPaidPriorYears"]),
    "paid_total": ("duration", [
        "PaymentsForLossesAndLossAdjustmentExpense", f"{P}ClaimsPaid",
        "SupplementalInformationForPropertyCasualtyInsuranceUnderwritersPaidClaimsAndClaimsAdjustmentExpense",
    ]),
    "acquired": ("duration", [f"{P}BusinessAcquisitions"]),
    "fx": ("duration", [f"{P}ForeignCurrencyTranslationGainLoss", f"{P}ForeignExchange"]),
    "recoverable_unpaid": ("instant", ["ReinsuranceRecoverableForUnpaidClaimsAndClaimsAdjustments",
                                       "ReinsuranceRecoverablesOnUnpaidLosses"]),
    "ibnr": ("instant", [f"{P}IncurredButNotReportedIBNRClaimsAmount"]),
    "case_reserves": ("instant", [f"{P}ReportedClaimsAmount"]),
}
# the core concepts, read from annual facts only where the quarterly panel has no value (sil/concepts.py tags)
CORE = ("npe", "losses", "cy_losses", "py_development", "equity", "net_reserves", "gross_reserves")

# value / net premiums earned must fall inside these bounds (a negative value that fits when flipped is flipped)
PAID_BOUNDS = {"paid_cy": (0.0, 2.5), "paid_py": (0.0, 4.0), "paid_total": (0.02, 4.0)}
# derived ratios outside these bounds are dropped as data errors
METRIC_BOUNDS = {
    "paid_lr": (0.0, 4.0), "incurred_lr": (0.0, 4.0), "paid_to_incurred": (0.0, 5.0), "first_year_payout": (0.0, 1.2),
    "runoff_speed": (0.0, 1.5), "survival": (0.0, 30.0), "reserve_to_npe": (0.0, 30.0), "reserve_leverage": (0.0, 15.0),
    "dev_pct_open": (-0.6, 0.6), "pyd_ratio": (-1.0, 1.0), "ceded_share": (0.0, 1.0), "ibnr_share": (0.0, 1.0),
    "reserve_growth": (-0.9, 5.0), "acquired_pct_open": (-1.0, 5.0), "rollforward_gap": (-1.0, 1.0),
}
YEAR_METRICS = list(METRIC_BOUNDS)
AMOUNTS = ["npe", "losses", "cy_losses", "py_development", "paid_cy", "paid_py", "paid", "acquired", "net_reserves",
           "net_reserves_open", "gross_reserves", "equity"]
FIRST_TRIANGLE_FY = 2016


def _all_tags() -> dict[str, tuple[str, list[str]]]:
    out = dict(CLAIM_TAGS)
    for c in CORE:
        kind, tags, _ = CONCEPTS[c]
        out[f"core_{c}"] = (kind, tags)
    return out


def _q(conn, sql: str, params: dict | None = None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params or {})
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


LATEST = """
  select distinct on (f.cik, f.tag, f.period_start, f.period_end)
         f.cik, f.tag, f.period_start, f.period_end, f.value::float8 as value, f.filed
  from raw.xbrl_fact f
  where f.taxonomy = 'us-gaap' and f.unit = 'USD' and f.tag = any(%(tags)s)
  order by f.cik, f.tag, f.period_start, f.period_end, f.filed desc, f.accession desc
"""

# discrete quarters: a reported 3-month value, else year-to-date minus the previous year-to-date (same start)
QUARTER_SQL = f"""
with l as ({LATEST}),
d as (
  select l.*, round((l.period_end - l.period_start + 1) / 91.31)::int as quarters,
         (date_trunc('quarter', l.period_end + 45) - interval '1 day')::date as qend
  from l where l.period_start is not null and (l.period_end - l.period_start + 1) between 80 and 380
),
direct as (select cik, tag, qend, value, 1 as pri from d where quarters = 1),
ytd as (
  select a.cik, a.tag, a.qend, a.value - b.value as value, 2 as pri
  from d a join d b
    on b.cik = a.cik and b.tag = a.tag and b.period_start = a.period_start and b.quarters = a.quarters - 1
   and b.qend = (date_trunc('quarter', a.qend) - interval '1 day')::date
  where a.quarters between 2 and 4
)
select distinct on (cik, tag, qend) cik, tag, qend as period, value
from (select * from direct union all select * from ytd) x
order by cik, tag, qend, pri
"""

ANNUAL_SQL = f"""
with l as ({LATEST})
select distinct on (cik, tag, fy) cik, tag, fy as period, value
from (select l.*, (date_trunc('quarter', l.period_end + 45) - interval '1 day')::date as fy from l
      where l.period_start is not null and (l.period_end - l.period_start + 1) between 350 and 380) a
order by cik, tag, fy, filed desc
"""

INSTANT_SQL = f"""
with l as ({LATEST})
select distinct on (cik, tag, qe) cik, tag, qe as period, value
from (select l.*, (date_trunc('quarter', l.period_end + 15) - interval '1 day')::date as qe from l
      where l.period_start is null) i
where abs(period_end - qe) <= 15
order by cik, tag, qe, filed desc
"""


def _candidates(frame: pd.DataFrame, tags: dict[str, tuple[str, list[str]]], kind: str) -> pd.DataFrame:
    rows = [(c, t, i + 1) for c, (k, ts) in tags.items() if k == kind for i, t in enumerate(ts)]
    t = pd.DataFrame(rows, columns=["concept", "tag", "priority"])
    out = frame.merge(t, on="tag")
    out["period"] = pd.to_datetime(out["period"])
    return out


def resolve(cands: pd.DataFrame, base: pd.Series | None, bounds: dict[str, tuple[float, float]]) -> pd.DataFrame:
    """One value per (cik, period, concept): the first tag in priority order that passes its bound vs `base`.

    cands: cik, period, concept, tag, priority, value. base: net premiums earned indexed by (cik, period).
    A negative value whose absolute value fits the bound is sign-flipped (a few filers tag paid losses negative).
    """
    df = cands.copy()
    df["value"] = df["value"].astype(float)
    df["flag"] = ""
    if base is not None and bounds:
        df = df.join(base.rename("base"), on=["cik", "period"])
        drop = []
        for concept, (lo, hi) in bounds.items():
            m = df["concept"] == concept
            r = df.loc[m, "value"] / df.loc[m, "base"]
            ok = r.between(lo, hi)
            flip = (~ok) & (-r).between(lo, hi)
            idx = flip[flip].index
            df.loc[idx, "value"] = -df.loc[idx, "value"]
            df.loc[idx, "flag"] = "sign flipped"
            ok = ok | flip
            drop.extend(r.index[~ok.fillna(False)])
        df = df.drop(index=drop).drop(columns="base")
    df = df.sort_values(["cik", "period", "concept", "priority"])
    return df.drop_duplicates(["cik", "period", "concept"], keep="first").reset_index(drop=True)


def compose_paid(w: pd.DataFrame) -> pd.DataFrame:
    """Paid losses from the roll-forward: current + prior accident years, else the total (prior years derived as
    total - current when only the current-year part is tagged). Adds paid and paid_basis; fills paid_py."""
    w = w.copy()
    for c in ("paid_cy", "paid_py", "paid_total"):
        if c not in w.columns:
            w[c] = np.nan
    both = w["paid_cy"].notna() & w["paid_py"].notna()
    derive = ~both & w["paid_total"].notna() & w["paid_cy"].notna() & (w["paid_total"] >= w["paid_cy"])
    total = ~both & ~derive & w["paid_total"].notna()
    w["paid"] = np.where(both, w["paid_cy"] + w["paid_py"], np.where(derive | total, w["paid_total"], np.nan))
    w.loc[derive, "paid_py"] = w.loc[derive, "paid_total"] - w.loc[derive, "paid_cy"]
    w["paid_basis"] = np.select([both, derive, total], ["cy+py", "total-cy", "total"], default="none")
    return w


def _div(a: pd.Series, b: pd.Series) -> pd.Series:
    return (a / b.where(b.abs() > 0)).replace([np.inf, -np.inf], np.nan)


def year_metrics(y: pd.DataFrame) -> pd.DataFrame:
    """Ratios of one fiscal year's roll-forward (see the module docstring); out-of-bounds values become NaN."""
    y = y.copy()
    for c in [*AMOUNTS, "fx", "recoverable_unpaid", "ibnr", "case_reserves"]:
        if c not in y.columns:
            y[c] = np.nan
    y["paid_lr"] = _div(y["paid"], y["npe"])
    y["incurred_lr"] = _div(y["losses"], y["npe"])
    y["paid_to_incurred"] = _div(y["paid"], y["losses"])
    y["first_year_payout"] = _div(y["paid_cy"], y["cy_losses"])
    y["runoff_speed"] = _div(y["paid_py"], y["net_reserves_open"])
    y["survival"] = _div(y["net_reserves"], y["paid"])
    y["reserve_to_npe"] = _div(y["net_reserves"], y["npe"])
    y["reserve_leverage"] = _div(y["net_reserves"], y["equity"])
    y["dev_pct_open"] = _div(y["py_development"], y["net_reserves_open"])
    y["pyd_ratio"] = _div(y["py_development"], y["npe"])
    gross_ceded = _div(y["recoverable_unpaid"], y["gross_reserves"])
    implied = 1 - _div(y["net_reserves"], y["gross_reserves"])
    y["ceded_share"] = gross_ceded.fillna(implied.where(implied >= 0))
    y["ibnr_share"] = _div(y["ibnr"], y["ibnr"] + y["case_reserves"])
    y["reserve_growth"] = _div(y["net_reserves"], y["net_reserves_open"]) - 1
    y["acquired_pct_open"] = _div(y["acquired"], y["net_reserves_open"])
    incurred = (y["cy_losses"] + y["py_development"]).fillna(y["losses"])
    expected = y["net_reserves_open"] + incurred - y["paid"] + y["acquired"].fillna(0) + y["fx"].fillna(0)
    y["rollforward_gap"] = _div(y["net_reserves"] - expected, y["net_reserves_open"])
    for k, (lo, hi) in METRIC_BOUNDS.items():
        y[k] = y[k].where(y[k].between(lo, hi))
    return y


def ttm_series(q: pd.DataFrame, col: str) -> pd.Series:
    """Trailing-four-quarter sum per company where the four quarters are consecutive and present.

    q must be sorted by (cik, qend) with a default RangeIndex."""
    roll = q.groupby("cik")[col].rolling(4, min_periods=4).sum().reset_index(level=0, drop=True)
    gap = (q["qend"] - q.groupby("cik")["qend"].shift(3)).dt.days
    return roll.where(gap.between(270, 280))


# ---------------------------------------------------------------- build

def build(conn) -> dict:
    tags = _all_tags()
    flat = sorted({t for _, ts in tags.values() for t in ts})
    cq = _q(conn, "select cik, qend, npe, npe_ttm, losses_ttm, cy_losses_ttm, py_development_ttm, equity,"
                  " net_reserves, gross_reserves from core.company_quarter")
    cq["qend"] = pd.to_datetime(cq["qend"])
    quarterly = _build_quarters(conn, tags, flat, cq)
    yearly = _build_years(conn, tags, flat, cq)
    tri = _build_triangles(conn)
    stats = {
        "year_rows": len(yearly), "year_companies": int(yearly["cik"].nunique()),
        "years_with_paid": int(yearly["paid"].notna().sum()),
        "quarter_rows": len(quarterly),
        "quarter_companies": int(quarterly.loc[quarterly.paid_ttm.notna(), "cik"].nunique()),
        **tri,
    }
    log.info("claims: %s", stats)
    return stats


def _build_quarters(conn, tags, flat, cq: pd.DataFrame) -> pd.DataFrame:
    qf = _q(conn, QUARTER_SQL, {"tags": flat})
    cands = _candidates(qf, {k: v for k, v in tags.items() if k in ("paid_cy", "paid_py", "paid_total")}, "duration")
    base = cq.set_index(["cik", "qend"])["npe"].dropna()
    base.index = base.index.set_names(["cik", "period"])
    picked = resolve(cands, base, PAID_BOUNDS)
    w = picked.pivot_table(index=["cik", "period"], columns="concept", values="value", aggfunc="first").reset_index()
    w = compose_paid(w).rename(columns={"period": "qend"})
    q = cq.merge(w[["cik", "qend", "paid", "paid_basis"]], on=["cik", "qend"], how="left")
    q = q.sort_values(["cik", "qend"]).reset_index(drop=True)
    q["paid_ttm"] = ttm_series(q, "paid")
    q["paid_lr_ttm"] = _div(q["paid_ttm"], q["npe_ttm"]).where(lambda r: r.between(0, 4))
    q["incurred_lr_ttm"] = _div(q["losses_ttm"], q["npe_ttm"]).where(lambda r: r.between(0, 4))
    q["paid_to_incurred_ttm"] = _div(q["paid_ttm"], q["losses_ttm"]).where(lambda r: r.between(0, 5))
    q = q[q["paid"].notna() | q["paid_ttm"].notna() | q["incurred_lr_ttm"].notna()]
    cols = ["cik", "qend", "paid", "paid_basis", "paid_ttm", "npe_ttm", "losses_ttm", "paid_lr_ttm", "incurred_lr_ttm",
            "paid_to_incurred_ttm"]
    conn.execute("delete from core.claims_quarter")
    copy_rows(conn, "core.claims_quarter", cols, _rows(q[cols]))
    conn.commit()
    return q


def _build_years(conn, tags, flat, cq: pd.DataFrame) -> pd.DataFrame:
    af = _q(conn, ANNUAL_SQL, {"tags": flat})
    inst = _q(conn, INSTANT_SQL, {"tags": flat})
    # roll-forward flows for the fiscal year
    flows = resolve(_candidates(af, {k: tags[k] for k in ("paid_cy", "paid_py", "paid_total", "acquired", "fx")},
                                "duration"), None, {})
    w = flows.pivot_table(index=["cik", "period"], columns="concept", values="value", aggfunc="first").reset_index()
    # premiums and incurred losses: the panel's trailing four quarters at the fiscal year end, else annual facts
    core_dur = {f"core_{c}": tags[f"core_{c}"] for c in ("npe", "losses", "cy_losses", "py_development")}
    a_core = resolve(_candidates(af, core_dur, "duration"), None, {})
    a_core = a_core.pivot_table(index=["cik", "period"], columns="concept", values="value", aggfunc="first")
    a_core.columns = [c.removeprefix("core_") for c in a_core.columns]
    a_core = a_core.reset_index()
    for c, (lo, hi) in RATIO_BOUNDS.items():
        if c in a_core.columns and "npe" in a_core.columns:
            a_core[c] = a_core[c].where((a_core[c] / a_core["npe"]).between(lo, hi))
    q4 = cq.rename(columns={"qend": "period", "npe_ttm": "npe_q", "losses_ttm": "losses_q", "cy_losses_ttm": "cy_losses_q",
                            "py_development_ttm": "py_development_q", "equity": "equity_q",
                            "net_reserves": "net_reserves_q", "gross_reserves": "gross_reserves_q"})
    q4 = q4[["cik", "period", "npe_q", "losses_q", "cy_losses_q", "py_development_q", "equity_q", "net_reserves_q",
             "gross_reserves_q"]]
    y = w.merge(q4, on=["cik", "period"], how="outer").merge(a_core, on=["cik", "period"], how="left")
    # fiscal year ends: the quarter-end months in which the company reports annual roll-forward flows
    # (December for companies that never tagged one), so years without paid-loss tags still get a row
    fy_months = w.assign(m=w["period"].dt.month).groupby("cik")["m"].agg(lambda s: set(s.tolist())).to_dict()
    month = y["period"].dt.month
    keep = [m in fy_months.get(c, {12}) for c, m in zip(y["cik"], month, strict=True)]
    y = y[keep].copy()
    for c in ("npe", "losses", "cy_losses", "py_development"):
        if c not in y.columns:
            y[c] = np.nan
        y[c] = y[f"{c}_q"].fillna(y[c])
    for c, (lo, hi) in PAID_BOUNDS.items():
        if c not in y.columns:
            y[c] = np.nan
        r = y[c] / y["npe"]
        flip = (~r.between(lo, hi)) & (-r).between(lo, hi)
        y.loc[flip, c] = -y.loc[flip, c]
        y[c] = y[c].where(r.between(lo, hi) | flip)
    y = compose_paid(y)
    # balance sheet at the fiscal year end: the panel's quarter values, else the instants read here
    ib = resolve(_candidates(inst, {k: v for k, v in tags.items() if v[0] == "instant"}, "instant"), None, {})
    ib = ib[ib["value"] >= 0]
    iw = ib.pivot_table(index=["cik", "period"], columns="concept", values="value", aggfunc="first").reset_index()
    y = y.merge(iw, on=["cik", "period"], how="left")
    for c in ("equity", "net_reserves", "gross_reserves"):
        core_c = f"core_{c}"
        y[c] = y[f"{c}_q"].fillna(y[core_c]) if core_c in y.columns else y[f"{c}_q"]
    if "recoverable_unpaid" not in y.columns:
        y["recoverable_unpaid"] = np.nan
    # a few filers tag only gross reserves and the recoverable on unpaid claims: net = gross - recoverable
    implied_net = (y["gross_reserves"] - y["recoverable_unpaid"]).where(lambda v: v > 0)
    y["net_reserves"] = y["net_reserves"].fillna(implied_net)
    y = y[y[["npe", "paid", "net_reserves"]].notna().any(axis=1)]
    y = y.sort_values(["cik", "period"]).reset_index(drop=True)
    prev = y.groupby("cik")["period"].shift(1)
    consecutive = (y["period"] - prev).dt.days.between(360, 370)
    y["net_reserves_open"] = y.groupby("cik")["net_reserves"].shift(1).where(consecutive)
    y["fy_end"] = y["period"].dt.date
    y["fiscal_year"] = y["period"].dt.year
    y = year_metrics(y)
    y = y.drop_duplicates(["cik", "fiscal_year"], keep="last")
    cols = ["cik", "fiscal_year", "fy_end", "npe", "losses", "cy_losses", "py_development", "paid_cy", "paid_py", "paid",
            "paid_basis", "acquired", "fx", "net_reserves", "net_reserves_open", "gross_reserves", "recoverable_unpaid",
            "ibnr", "case_reserves", "equity", *YEAR_METRICS]
    for c in cols:
        if c not in y.columns:
            y[c] = np.nan
    conn.execute("delete from core.claims_year")
    copy_rows(conn, "core.claims_year", cols, _rows(y[cols]))
    conn.commit()
    return y


def _rows(df: pd.DataFrame):
    for rec in df.itertuples(index=False):
        out = []
        for v in rec:
            if v is None or v is pd.NaT or (isinstance(v, float) and np.isnan(v)):
                out.append(None)
            elif isinstance(v, pd.Timestamp):
                out.append(v.date())
            elif isinstance(v, np.integer):
                out.append(int(v))
            elif isinstance(v, np.floating):
                out.append(None if np.isnan(v) else float(v))
            else:
                out.append(v)
        yield out


# ---------------------------------------------------------------- triangles from cached 10-K instances

INSTANCE_SQL = """
select distinct on (d.accession) d.accession, d.cik, extract(year from f.report_date)::int as fiscal_year, d.url
from raw.sec_document d join raw.sec_filing f using (accession)
where d.kind = 'annual' and f.form in ('10-K', '10-KT', '20-F', '40-F')
  and (upper(d.doc_type) = 'EX-101.INS' or (upper(d.doc_type) = 'XML' and lower(d.filename) like '%%\\_htm.xml'))
  and f.report_date >= %(first)s
  and d.accession not in (select accession from raw.claims_instance)
order by d.accession, (upper(d.doc_type) = 'EX-101.INS') desc
"""

_FETCHER = None


def cached_body(url: str) -> bytes | None:
    """The body of a document already in the on-disk cache, or None. Never fetches."""
    global _FETCHER
    if _FETCHER is None:
        from .http import Fetcher

        _FETCHER = Fetcher(sec_agent="")
    body_path, meta_path = _FETCHER._paths(url)
    if not (body_path.exists() and meta_path.exists()):
        return None
    try:
        if json.loads(meta_path.read_text()).get("status") != 200:
            return None
    except (OSError, ValueError):
        return None
    return Path(body_path).read_bytes()


def read_instances(conn) -> dict:
    """Parse every cached, not yet read 10-K instance (fiscal 2016+) into raw.claims_instance_fact."""
    todo = _q(conn, INSTANCE_SQL, {"first": date(FIRST_TRIANGLE_FY, 11, 30)})
    read = missing = 0
    for r in todo.itertuples():
        body = cached_body(r.url)
        if body is None:
            missing += 1
            continue
        try:
            facts = xi.parse_instance(body, xi.is_claims_element)
        except Exception as exc:  # noqa: BLE001 - one malformed instance must not stop the others
            log.warning("instance %s could not be parsed: %s", r.accession, exc)
            facts = []
        rows = [(r.accession, int(r.cik), f.element, f.value, f.unit, f.decimals, f.context.start, f.context.end,
                 json.dumps(f.context.dims, sort_keys=True)) for f in facts]
        copy_rows(conn, "raw.claims_instance_fact",
                  ("accession", "cik", "element", "value", "unit", "decimals", "period_start", "period_end", "dims"), rows)
        conn.execute("insert into raw.claims_instance(accession, cik, fiscal_year, url, n_facts) values (%s,%s,%s,%s,%s)"
                     " on conflict (accession) do nothing", (r.accession, int(r.cik), int(r.fiscal_year), r.url, len(rows)))
        conn.commit()
        read += 1
    if read or missing:
        log.info("claims instances: %d read, %d listed but not cached yet", read, missing)
    return {"instances_read": read, "instances_not_cached": missing}


def triangle_rows(facts: pd.DataFrame) -> tuple[list, list, list]:
    """Instance facts (columns cik, fy_filed, accession, element, value, period_end, dims) -> triangle rows,
    accident-year rows and payout rows. Pure."""
    tri: dict[tuple, tuple] = {}
    ay_extra: dict[tuple, dict] = {}
    payout: dict[tuple, float] = {}
    for f in facts.itertuples(index=False):
        if f.value is None or (isinstance(f.value, float) and np.isnan(f.value)):
            continue
        cls = xi.classify(f.element)
        if cls is None:
            continue
        measure, n = cls
        dims = f.dims if isinstance(f.dims, dict) else json.loads(f.dims)
        ay, axis = xi.accident_year(dims)
        line = xi.line_name(dims, axis)
        ev = pd.Timestamp(f.period_end).year
        if measure == "payout":
            v = float(f.value)
            payout.setdefault((f.cik, f.fy_filed, line, n), v / 100 if v > 1.5 else v)
            continue
        if ay is None:
            continue
        if measure in ("incurred", "paid"):
            if ev < ay or ev - ay > 14:
                continue
            tri.setdefault((f.cik, f.fy_filed, line, ay, ev, measure), (f.accession, float(f.value)))
        elif measure in ("ibnr", "claims"):
            rec = ay_extra.setdefault((f.cik, f.fy_filed, line, ay), {})
            rec.setdefault("ibnr" if measure == "ibnr" else "reported_claims", float(f.value))
    triangle = [(k[0], k[1], v[0], k[2], k[3], k[4], k[5], v[1]) for k, v in tri.items()]
    by_ay: dict[tuple, dict] = {}
    for cik, fy, _acc, line, ay, ev, metric, value in triangle:
        rec = by_ay.setdefault((cik, fy, line, ay), {})
        if metric == "incurred":
            if "first_ev" not in rec or ev < rec["first_ev"]:
                rec["first_ev"], rec["incurred_first"] = ev, value
            if "last_ev" not in rec or ev > rec["last_ev"]:
                rec["last_ev"], rec["incurred_latest"] = ev, value
        elif "paid_ev" not in rec or ev > rec["paid_ev"]:
            rec["paid_ev"], rec["paid_latest"] = ev, value
    for key, extra in ay_extra.items():
        by_ay.setdefault(key, {}).update(extra)
    ay_out = [(k[0], k[1], k[2], k[3], r.get("incurred_first"), r.get("incurred_latest"), r.get("paid_latest"),
               r.get("ibnr"), r.get("reported_claims")) for k, r in by_ay.items()]
    pay_out = [(k[0], k[1], k[2], k[3], v) for k, v in payout.items()]
    return triangle, ay_out, pay_out


def _build_triangles(conn) -> dict:
    stats = read_instances(conn)
    facts = _q(conn, "select f.cik, i.fiscal_year as fy_filed, f.accession, f.element, f.value, f.period_end, f.dims"
                     " from raw.claims_instance_fact f join raw.claims_instance i using (accession)")
    conn.execute("delete from core.claims_triangle")
    conn.execute("delete from core.claims_ay")
    conn.execute("delete from core.claims_payout")
    tri, ay, pay = triangle_rows(facts) if len(facts) else ([], [], [])
    copy_rows(conn, "core.claims_triangle",
              ("cik", "fy_filed", "accession", "line", "accident_year", "eval_year", "metric", "value"), tri)
    copy_rows(conn, "core.claims_ay", ("cik", "fy_filed", "line", "accident_year", "incurred_first", "incurred_latest",
                                       "paid_latest", "ibnr", "reported_claims"), ay)
    copy_rows(conn, "core.claims_payout", ("cik", "fy_filed", "line", "year_n", "pct"), pay)
    conn.commit()
    stats.update({"triangle_cells": len(tri), "triangle_companies": len({t[0] for t in tri})})
    return stats


# ---------------------------------------------------------------- export

def _n(v, digits: int = 4):
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(x):
        return None
    if abs(x) >= 1e5:
        return round(x)
    return float(f"{x:.{digits}g}")


def export(conn, write) -> None:
    y = _q(conn, "select y.*, c.segment, c.comparable from core.claims_year y join ref.company c using (cik)"
                 " where c.cohort in ('specialty', 'benchmark') and y.fiscal_year >= 2009 order by cik, fiscal_year")
    if not len(y):
        write("claims.json", {"version": 1, "years": [], "metrics": YEAR_METRICS, "amounts": AMOUNTS, "companies": {},
                              "segmentMedians": {}, "quarters": [], "quarterly": {}, "triangles": {}, "coverage": {}})
        return
    have = y[["paid", "net_reserves", "dev_pct_open"]].notna().any(axis=1)
    years = list(range(int(y.loc[have, "fiscal_year"].min()), int(y.loc[have, "fiscal_year"].max()) + 1))
    companies = {}
    for cik, g in y.groupby("cik"):
        g = g.set_index("fiscal_year").reindex(years)
        if g[["paid", "net_reserves", "dev_pct_open", "survival"]].notna().sum().sum() == 0:
            continue
        companies[str(int(cik))] = {
            "y": {k: [_n(v) for v in g[k]] for k in YEAR_METRICS + AMOUNTS if g[k].notna().any()},
            "basis": [b if isinstance(b, str) else None for b in g["paid_basis"]],
        }
    # segment medians per fiscal year: comparable carriers, at least three with a value
    seg_med: dict[str, dict] = {}
    for seg, g in y[y["comparable"]].groupby("segment"):
        med = g.groupby("fiscal_year")[YEAR_METRICS].agg(lambda s: s.median() if s.notna().sum() >= 3 else np.nan)
        med = med.reindex(years)
        seg_med[seg] = {k: [_n(v) for v in med[k]] for k in YEAR_METRICS if med[k].notna().any()}
    q = _q(conn, "select q.cik, q.qend, q.paid_lr_ttm, q.incurred_lr_ttm from core.claims_quarter q join ref.company c"
                 " using (cik) where c.cohort in ('specialty', 'benchmark') and q.qend >= '2009-12-31'")
    q["qend"] = pd.to_datetime(q["qend"])
    quarters = sorted(q.loc[q.paid_lr_ttm.notna(), "qend"].unique())
    quarterly = {}
    for cik, g in q.groupby("cik"):
        g = g.drop_duplicates("qend").set_index("qend").reindex(quarters)
        if g["paid_lr_ttm"].notna().sum() == 0:
            continue
        quarterly[str(int(cik))] = {"paid": [_n(v) for v in g["paid_lr_ttm"]],
                                    "incurred": [_n(v) for v in g["incurred_lr_ttm"]]}
    triangles = _export_triangles(conn)
    latest = y[y["fiscal_year"] == years[-1]]
    n_inst = _q(conn, "select count(*) as n from raw.claims_instance")["n"].iloc[0]
    write("claims.json", {
        "version": 1,
        "generated": date.today().isoformat(),
        "years": years,
        "metrics": YEAR_METRICS,
        "amounts": AMOUNTS,
        "companies": companies,
        "segmentMedians": seg_med,
        "quarters": [pd.Timestamp(d).strftime("%Y-%m-%d") for d in quarters],
        "quarterly": quarterly,
        "triangles": triangles,
        "coverage": {
            "companies": len(companies),
            "companyYears": int(have.sum()),
            "withPaid": int(y["paid"].notna().sum()),
            "firstYear": years[0], "lastYear": years[-1],
            "lastYearCompanies": int(latest["paid"].notna().sum()),
            "triangleCompanies": len(triangles),
            "instancesRead": int(n_inst),
        },
    })


def _export_triangles(conn) -> dict:
    """The latest 10-K's triangles per company: per line, accident years x development age (1 = the accident year)."""
    t = _q(conn, "select cik, fy_filed, accession, line, accident_year, eval_year, metric, value from core.claims_triangle")
    if not len(t):
        return {}
    a = _q(conn, "select * from core.claims_ay")
    p = _q(conn, "select * from core.claims_payout")
    out = {}
    for cik, fy in t.groupby("cik")["fy_filed"].max().items():
        tt = t[(t.cik == cik) & (t.fy_filed == fy)]
        lines = []
        for line, g in tt.groupby("line"):
            ays = sorted(int(v) for v in g["accident_year"].unique())
            if len(ays) < 3:
                continue
            ages = int((g["eval_year"] - g["accident_year"]).max()) + 1
            mats = {}
            for metric in ("incurred", "paid"):
                mat: list[list] = [[None] * ages for _ in ays]
                for r in g[g.metric == metric].itertuples():
                    mat[ays.index(int(r.accident_year))][int(r.eval_year - r.accident_year)] = _n(r.value)
                mats[metric] = mat
            aa = a[(a.cik == cik) & (a.fy_filed == fy) & (a.line == line)].set_index("accident_year").reindex(ays)
            pp = p[(p.cik == cik) & (p.fy_filed == fy) & (p.line == line)].sort_values("year_n")
            latest_incurred = [next((v for v in reversed(row) if v is not None), None) for row in mats["incurred"]]
            lines.append({
                "name": line, "ays": ays, "incurred": mats["incurred"], "paid": mats["paid"],
                "ibnr": [_n(v) for v in aa["ibnr"]], "claims": [_n(v) for v in aa["reported_claims"]],
                "payout": [_n(v, 3) for v in pp["pct"]],
                "size": _n(sum(v for v in latest_incurred if v is not None)),
            })
        if lines:
            lines.sort(key=lambda d: -(d["size"] or 0))
            out[str(int(cik))] = {"fy": int(fy), "accession": str(tt["accession"].iloc[0]), "lines": lines[:10]}
    return out
