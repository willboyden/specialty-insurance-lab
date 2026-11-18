"""Standardize every company's quarterly financials into one wide table of concepts and ratios.

Inputs: core.fact_quarter / core.fact_instant / core.fact_annual (SQL views over raw XBRL facts).
Outputs:
  core.concept_value     one row per (company, quarter, concept): value, the tag it came from, how the
                         quarter was derived, and any quality flag
  core.company_quarter   one row per (company, quarter): concepts + ratios (quarterly and trailing four quarters)
  core.company_year      one row per (company, fiscal year): annual ratios incl. Schedule III expense ratio

Plausibility rules (a fallback tag is used only when it passes; the primary tag must pass too):
  losses, cy_losses      between 15% and 250% of net premiums earned
  py_development         within +/-100% of net premiums earned
  acq_cost               0-60% of net premiums earned (a negative value whose absolute value fits is sign-flipped
                         and flagged: at least one filer tags this expense with the wrong sign)
  other_uw_exp           2-30% of net premiums earned (the broadest tags often include acquisition costs or
                         non-insurance operations; those fail the bound and the next source is used)

Expense ratio = acquisition-cost ratio + other-underwriting-expense ratio. Each part comes from the quarterly
tag when it passes, else from the company's annual Schedule III ratio for that fiscal year (carried forward
for quarters after the latest 10-K). Where neither exists, the ratio implied by the income statement is used:
(NPE - losses + NII - (pre-tax income - investment gains)) / NPE over four quarters, i.e. every non-loss cost net of
other income. expense_basis records the source: quarterly, annual, mixed or implied.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .concepts import AI_CONCEPTS, CONCEPTS, concept_rows
from .db import apply_views, copy_rows

log = logging.getLogger(__name__)

RATIO_BOUNDS = {
    "losses": (0.15, 2.5),
    "cy_losses": (0.15, 2.5),
    "py_development": (-1.0, 1.0),
    "acq_cost": (0.0, 0.6),
    "other_uw_exp": (0.02, 0.30),
}


def load_concept_tags(conn) -> None:
    conn.execute(
        "create table if not exists ref.concept_tag (concept text not null, tag text not null, priority integer not null,"
        " kind text not null, note text, primary key (concept, tag))"
    )
    conn.execute("delete from ref.concept_tag")
    copy_rows(conn, "ref.concept_tag", ("concept", "tag", "priority", "kind", "note"), concept_rows())
    conn.commit()


def refresh(conn) -> None:
    load_concept_tags(conn)
    apply_views(conn)


def _frame(conn, sql: str) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def resolve(candidates: pd.DataFrame, npe: pd.Series | None) -> pd.DataFrame:
    """Pick one value per (cik, qend, concept) from tag candidates in priority order.

    candidates: columns cik, qend, concept, tag, priority, value, derivation
    npe:        Series indexed by (cik, qend) of net premiums earned, for the ratio checks
    """
    df = candidates.copy()
    df["value"] = df["value"].astype(float)
    df["flag"] = ""
    if npe is not None:
        ratio_base = npe.rename("npe_ref")
        df = df.join(ratio_base, on=["cik", "qend"])
        for concept, (lo, hi) in RATIO_BOUNDS.items():
            m = df["concept"] == concept
            r = df.loc[m, "value"] / df.loc[m, "npe_ref"]
            ok = r.between(lo, hi)
            if concept == "acq_cost":
                flip = (~ok) & (-r).between(lo, hi)
                idx = r[flip].index
                df.loc[idx, "value"] = -df.loc[idx, "value"]
                df.loc[idx, "flag"] = "sign flipped"
                ok = ok | flip
            bad = r.index[~ok.fillna(False)]
            df = df.drop(index=bad)
        df = df.drop(columns="npe_ref")
    df = df.sort_values(["cik", "qend", "concept", "priority"])
    return df.drop_duplicates(["cik", "qend", "concept"], keep="first").reset_index(drop=True)


def build(conn) -> dict:
    refresh(conn)
    for mv in ("core.fact_latest", "core.fact_quarter", "core.fact_instant"):
        conn.execute(f"refresh materialized view {mv}")
    conn.commit()
    tags = _frame(conn, "select concept, tag, priority, kind from ref.concept_tag")
    dur = _frame(conn, "select q.cik, q.tag, q.qend, q.value, q.derivation from core.fact_quarter q")
    inst = _frame(conn, "select i.cik, i.tag, i.qend, i.value, 'balance sheet' as derivation from core.fact_instant i")
    ann = _frame(conn, "select a.cik, a.tag, a.fy_end as qend, a.value, 'fiscal year' as derivation from core.fact_annual a")
    companies = _frame(conn, "select cik, ticker, short_name, cohort, segment, status from ref.company")

    annual_concepts = {"s3_premium", "s3_losses", "s3_acq", "s3_other_opex"}
    # insurer concepts only (the AI-indicator capex/revenue concepts are read separately by ai_capex)
    dtags = tags[(tags.kind == "duration") & (~tags.concept.isin(annual_concepts)) & (~tags.concept.isin(list(AI_CONCEPTS)))]
    itags = tags[tags.kind == "instant"]
    atags = tags[tags.concept.isin(annual_concepts)]

    cand_d = dur.merge(dtags, on="tag")
    cand_i = inst.merge(itags, on="tag")
    cand_a = ann.merge(atags, on="tag")

    # net premiums earned first (no ratio check), then everything else checked against it
    npe = resolve(cand_d[cand_d.concept == "npe"], None)
    npe = npe[npe.value > 0]
    npe_s = npe.set_index(["cik", "qend"])["value"]
    other_d = resolve(cand_d[cand_d.concept != "npe"], npe_s)
    inst_v = resolve(cand_i, None)
    ann_v = resolve(cand_a, None)

    long = pd.concat([npe, other_d, inst_v], ignore_index=True)
    long["qend"] = pd.to_datetime(long["qend"])
    ann_v["qend"] = pd.to_datetime(ann_v["qend"])

    conn.execute("drop table if exists core.concept_value")
    conn.execute(
        "create table core.concept_value (cik integer, qend date, concept text, value double precision, tag text,"
        " derivation text, flag text, primary key (cik, qend, concept))"
    )
    copy_rows(
        conn, "core.concept_value", ("cik", "qend", "concept", "value", "tag", "derivation", "flag"),
        [(int(r.cik), r.qend.date(), r.concept, float(r.value), r.tag, r.derivation, r.flag or None)
         for r in pd.concat([long, ann_v]).itertuples()],
    )
    conn.commit()

    wide = long.pivot_table(index=["cik", "qend"], columns="concept", values="value", aggfunc="first")
    wide = wide.reset_index().sort_values(["cik", "qend"])
    quarterly = _metrics(wide, ann_v)
    quarterly = quarterly.merge(companies[["cik", "ticker"]], on="cik", how="left")
    _write_wide(conn, "core.company_quarter", quarterly)
    yearly = _annual(quarterly, ann_v)
    _write_wide(conn, "core.company_year", yearly)
    stats = {
        "quarter_rows": len(quarterly),
        "companies_with_npe": int(quarterly.loc[quarterly.npe.notna(), "cik"].nunique()),
        "year_rows": len(yearly),
        "sign_flips": int((long.flag == "sign flipped").sum()),
    }
    log.info("standardize: %s", stats)
    return stats


def _ttm(g: pd.DataFrame, col: str) -> pd.Series:
    """Trailing-four-quarter sum, only where the four quarters are consecutive and present."""
    s = g[col]
    q = g["qend"]
    consecutive = (q - q.shift(3)).dt.days.between(270, 280)
    out = s.rolling(4, min_periods=4).sum()
    return out.where(consecutive)


def npe_of(w: pd.DataFrame) -> pd.Series:
    return w["npe"]


def _metrics(w: pd.DataFrame, ann: pd.DataFrame) -> pd.DataFrame:
    for c in CONCEPTS:
        if c not in w.columns and not c.startswith("s3_"):
            w[c] = np.nan
    w = w.copy()
    g = w.groupby("cik", group_keys=False)
    flows = ["npe", "npw", "gpw", "losses", "cy_losses", "py_development", "acq_cost", "other_uw_exp", "nii", "net_income",
             "pretax_income", "inv_gains", "oci", "dividends", "buybacks"]
    for c in flows:
        w[f"{c}_ttm"] = g.apply(lambda x, c=c: _ttm(x, c))
    # previous quarter / previous year values for averages and growth
    for c in ("equity", "investments"):
        w[f"{c}_prev"] = g[c].shift(1).where((w.qend - g.qend.shift(1)).dt.days.between(85, 95))
    for c in ("npe_ttm", "npw_ttm", "equity"):
        w[f"{c}_lag4"] = g[c].shift(4).where((w.qend - g.qend.shift(4)).dt.days.between(360, 370))

    npe = w["npe"]
    w["loss_ratio"] = w["losses"] / npe
    w["cy_loss_ratio"] = w["cy_losses"] / npe
    w["pyd_ratio"] = w["py_development"] / npe
    w["acq_ratio"] = w["acq_cost"] / npe
    w["loss_ratio_ttm"] = w["losses_ttm"] / w["npe_ttm"]
    w["cy_loss_ratio_ttm"] = w["cy_losses_ttm"] / w["npe_ttm"]
    w["pyd_ratio_ttm"] = w["py_development_ttm"] / w["npe_ttm"]
    w["acq_ratio_ttm"] = w["acq_cost_ttm"] / w["npe_ttm"]

    # ---- expense ratio: quarterly tags first, the annual Schedule III ratios as the fallback
    s3 = ann.pivot_table(index=["cik", "qend"], columns="concept", values="value", aggfunc="first").reset_index()
    for col in ("s3_premium", "s3_acq", "s3_other_opex"):
        if col not in s3.columns:
            s3[col] = np.nan
    s3["year"] = s3["qend"].dt.year
    s3["acq_ratio_y"] = (s3["s3_acq"] / s3["s3_premium"]).where(lambda r: r.between(0.0, 0.6))
    s3["oth_ratio_y"] = (s3["s3_other_opex"] / s3["s3_premium"]).where(lambda r: r.between(0.0, 0.30))
    w["year"] = w["qend"].dt.year
    w = w.merge(s3[["cik", "year", "acq_ratio_y", "oth_ratio_y"]], on=["cik", "year"], how="left")
    w = w.sort_values(["cik", "qend"]).reset_index(drop=True)
    for col in ("acq_ratio_y", "oth_ratio_y"):
        w[col] = w.groupby("cik")[col].ffill()
    w["oth_ratio_q"] = w["other_uw_exp"] / npe_of(w)
    w["oth_ratio_ttm_q"] = w["other_uw_exp_ttm"] / w["npe_ttm"]
    acq_q, oth_q = w["acq_ratio"], w["oth_ratio_q"]
    w["acq_used"] = acq_q.fillna(w["acq_ratio_y"])
    w["oth_used"] = oth_q.fillna(w["oth_ratio_y"])
    w["acq_used_ttm"] = w["acq_ratio_ttm"].fillna(w["acq_ratio_y"])
    w["oth_used_ttm"] = w["oth_ratio_ttm_q"].fillna(w["oth_ratio_y"])
    both_q = acq_q.notna() & oth_q.notna()
    both_y = acq_q.isna() & oth_q.isna() & w["acq_ratio_y"].notna() & w["oth_ratio_y"].notna()
    w["expense_basis"] = np.select([both_q, both_y], ["quarterly", "annual"], default="mixed")
    w["expense_ratio"] = (w["acq_used"] + w["oth_used"]).where(lambda r: r.between(0.10, 0.55))
    w["expense_ratio_ttm"] = (w["acq_used_ttm"] + w["oth_used_ttm"]).where(lambda r: r.between(0.10, 0.55))
    # last fallback: the expense ratio implied by the income statement (all non-loss costs, net of other
    # income): (NPE - losses + NII - (pre-tax income - investment gains)) / NPE, trailing four quarters
    implied = ((w["npe_ttm"] - w["losses_ttm"] + w["nii_ttm"] - (w["pretax_income_ttm"] - w["inv_gains_ttm"].fillna(0)))
               / w["npe_ttm"]).where(lambda r: r.between(0.10, 0.55))
    w["implied_expense_ratio"] = implied
    use = w["expense_ratio"].isna() & implied.notna()
    w.loc[use, "expense_ratio"] = implied[use]
    w.loc[use, "expense_basis"] = "implied"
    use_t = w["expense_ratio_ttm"].isna() & implied.notna()
    w.loc[use_t, "expense_ratio_ttm"] = implied[use_t]
    w.loc[w["expense_ratio"].isna(), "expense_basis"] = "none"
    w["combined_ratio"] = w["loss_ratio"] + w["expense_ratio"]
    w["combined_ratio_ttm"] = w["loss_ratio_ttm"] + w["expense_ratio_ttm"]
    w["other_opex_ratio"] = w["oth_used"]

    avg_inv = (w["investments"] + w["investments_prev"]) / 2
    avg_eq = (w["equity"] + w["equity_prev"]) / 2
    w["nii_yield"] = 4 * w["nii"] / avg_inv
    w["roe"] = 4 * w["net_income"] / avg_eq
    w["roe_ttm"] = w["net_income_ttm"] / ((w["equity"] + w["equity_lag4"]) / 2)
    w["npe_growth_yoy"] = w["npe_ttm"] / w["npe_ttm_lag4"] - 1
    w["npw_growth_yoy"] = w["npw_ttm"] / w["npw_ttm_lag4"] - 1
    w["bv_growth_yoy"] = w["equity"] / w["equity_lag4"] - 1
    w["reserve_to_npe"] = w["net_reserves"] / w["npe_ttm"]
    w["npw_to_equity"] = w["npw_ttm"] / w["equity"]
    w["inv_to_equity"] = w["investments"] / w["equity"]
    w["equity_share_of_inv"] = w["equity_securities"] / w["investments"]
    w["aoci_to_equity"] = w["aoci"] / w["equity"]
    w["ceded_share"] = 1 - w["npw_ttm"] / w["gpw_ttm"]
    w = w.replace([np.inf, -np.inf], np.nan)
    return w


def _annual(q: pd.DataFrame, ann: pd.DataFrame) -> pd.DataFrame:
    """Fiscal-year view: Q4 rows carry the trailing-four-quarter values; Schedule III fills gaps."""
    y = q[q["qend"].dt.month == 12].copy()
    y["fiscal_year"] = y["qend"].dt.year
    keep = ["cik", "ticker", "fiscal_year", "qend", "npe_ttm", "npw_ttm", "losses_ttm", "cy_losses_ttm",
            "py_development_ttm", "acq_cost_ttm", "nii_ttm", "net_income_ttm", "equity", "net_reserves",
            "investments", "loss_ratio_ttm", "cy_loss_ratio_ttm", "pyd_ratio_ttm", "expense_ratio_ttm",
            "combined_ratio_ttm", "roe_ttm", "npe_growth_yoy", "bv_growth_yoy", "reserve_to_npe", "npw_to_equity",
            "expense_basis"]
    y = y[keep].rename(columns=lambda c: c.replace("_ttm", "") if c.endswith("_ttm") else c)
    # companies with annual-only filings (foreign private issuers): build the year from the 10-K values
    s3 = ann.pivot_table(index=["cik", "qend"], columns="concept", values="value", aggfunc="first").reset_index()
    s3["fiscal_year"] = s3["qend"].dt.year
    y = y.merge(s3.drop(columns="qend"), on=["cik", "fiscal_year"], how="outer")
    return y


def _write_wide(conn, table: str, df: pd.DataFrame) -> None:
    df = df.copy()
    cols = []
    for c in df.columns:
        if c in ("cik", "fiscal_year", "year"):
            cols.append((c, "integer"))
        elif c in ("qend",):
            cols.append((c, "date"))
        elif c in ("ticker", "expense_basis"):
            cols.append((c, "text"))
        elif df[c].dtype == bool:
            cols.append((c, "boolean"))
        else:
            cols.append((c, "double precision"))
            df[c] = pd.to_numeric(df[c], errors="coerce")
    conn.execute(f"drop table if exists {table} cascade")
    conn.execute(f"create table {table} (" + ", ".join(f'"{c}" {t}' for c, t in cols) + ")")

    def rows():
        for rec in df.itertuples(index=False):
            out = []
            for (c, t), v in zip(cols, rec):
                if v is None or (isinstance(v, float) and np.isnan(v)) or v is pd.NaT:
                    out.append(None)
                elif t == "date":
                    out.append(pd.Timestamp(v).date())
                elif t == "integer":
                    out.append(int(v))
                elif t == "boolean":
                    out.append(bool(v))
                else:
                    out.append(v if t == "text" else float(v))
            yield out

    copy_rows(conn, table, [c for c, _ in cols], rows())
    conn.commit()


def ai_capex(conn) -> pd.DataFrame:
    """Quarterly capex of the AI-infrastructure spenders, calendar-aligned (their fiscal years differ)."""
    tags = [(c, t, i + 1) for c, (_, ts, _) in AI_CONCEPTS.items() for i, t in enumerate(ts)]
    q = _frame(
        conn,
        "select q.cik, q.tag, q.qend, q.value from core.fact_quarter q join ref.company c using (cik)"
        " where c.cohort = 'ai_indicator'",
    )
    t = pd.DataFrame(tags, columns=["concept", "tag", "priority"])
    q = q.merge(t, on="tag").sort_values(["cik", "qend", "concept", "priority"])
    q = q.drop_duplicates(["cik", "qend", "concept"])
    return q.pivot_table(index=["cik", "qend"], columns="concept", values="value", aggfunc="first").reset_index()
