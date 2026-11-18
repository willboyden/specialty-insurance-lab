"""Export the database and the model to the dashboard's static JSON files (dashboard/public/data/).

Files:
  meta.json        build date, data sources with counts and coverage, model diagnostics
  companies.json   the universe: metadata, filing spans, latest metrics, exposures, estimated sensitivities
  panel.json       quarterly metrics per company (columnar: one array per metric per company)
  macro.json       quarterly risk drivers + labels, and the model's industry-shock series
  disclosure.json  share of each company's 10-K/10-Q filings mentioning each risk theme, by year
  model.json       everything the in-browser scenario engine needs (posterior draws, baseline paths, scenarios)
  backtest.json    out-of-sample accuracy (written by sil/model/backtest.py when it has run)
"""

from __future__ import annotations

import json
import logging
import math
import os
from datetime import date

import numpy as np
import pandas as pd

from .config import EXPORT_DIR
from .model import features as F
from .model import pipeline as P
from .standardize import _frame

log = logging.getLogger(__name__)

# Only drivers on this allowlist are published (all built from public-agency or freely citable data).
PUBLIC_DRIVERS = {
    "ust10y", "ust2y", "ust5y", "ust5y_end", "breakeven10", "ai_capex", "ai_capex_yoy", "ai_capex_to_ocf", "gpr",
    "gpr_threats", "gpr_acts", "epu", "brent", "cpi_yoy", "med_cpi_yoy", "auto_repair_cpi_yoy", "legal_ppi_yoy",
    "ppi_pc_yoy", "ppi_liab_yoy", "ppi_comauto_yoy", "ppi_cmp_yoy", "ppi_wc_yoy", "ppi_medmal_yoy", "ppi_home_yoy",
    "gdp_yoy", "real_gdp_yoy", "unrate", "recession", "nfci", "nonres_constr_yoy", "storm_damage",
    "storm_damage_hurricane", "storm_damage_convective", "storm_damage_wildfire", "storm_damage_flood", "storm_events",
    "billion_cost", "billion_count", "fema_major", "global_temp", "cat_index",
}

PANEL_METRICS = [
    "npe", "npe_ttm", "loss_ratio", "cy_loss_ratio", "pyd_ratio", "expense_ratio", "combined_ratio",
    "loss_ratio_ttm", "cy_loss_ratio_ttm", "pyd_ratio_ttm", "expense_ratio_ttm", "combined_ratio_ttm",
    "roe_ttm", "nii_yield", "npe_growth_yoy", "bv_growth_yoy", "equity", "reserve_to_npe", "npw_to_equity",
    "inv_to_equity", "equity_share_of_inv", "ceded_share",
]


def _num(x, digits: int = 4):
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    if abs(v) >= 1e5:
        return round(v)
    return float(f"{v:.{digits}g}")


def _arr(a, digits: int = 4):
    return [_num(v, digits) for v in a]


def _clean(obj):
    """NaN/inf -> None and numpy scalars -> Python, recursively (JSON has no NaN)."""
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        v = float(obj)
        return None if math.isnan(v) or math.isinf(v) else v
    if obj is pd.NaT:
        return None
    return obj


def _write(name: str, obj) -> int:
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(_clean(obj), separators=(",", ":"), allow_nan=False)
    (EXPORT_DIR / name).write_text(text)
    log.info("wrote %s (%.0f kB)", name, len(text) / 1024)
    return len(text)


write = _write  # the writer the data domains use (sil/domains.py)


def run(conn, bundle: P.ModelBundle | None = None) -> dict:
    if bundle is None:
        bundle = P.run(conn)
    cache = os.environ.get("SIL_BUNDLE_CACHE")
    if cache:
        import pickle

        with open(cache, "wb") as fh:
            pickle.dump(bundle, fh)
    sizes = {}
    end = bundle.end
    comp = _frame(conn, "select * from ref.company order by cohort, segment, ticker")
    sec = _frame(conn, "select cik, name, sic, sic_description, state_of_incorporation from raw.sec_company")
    spans = _frame(
        conn,
        "select cik, min(filing_date) first_filing, max(filing_date) last_filing, count(*) filter (where form like '10-K%%')"
        " n10k, count(*) filter (where form like '10-Q%%') n10q, count(*) filings from raw.sec_filing group by cik"
        .replace("%%", "%"),
    )
    fy = _frame(
        conn,
        "select cik, extract(year from filing_date)::int y, case"
        " when form in ('10-K','10-K405','10-KT','20-F','10-K/A','20-F/A') then 'annual'"
        " when form in ('10-Q','10-Q/A') then 'quarterly'"
        " when form in ('8-K','8-K/A','6-K') then 'current'"
        " when form in ('DEF 14A','DEFA14A','PRE 14A','DEFM14A') then 'proxy'"
        " when form in ('3','4','5','3/A','4/A','5/A') then 'insider'"
        " else 'other' end as kind, count(*) n from raw.sec_filing group by 1, 2, 3",
    )
    recent = _frame(
        conn,
        "select * from (select cik, form, filing_date, report_date, accession, primary_document,"
        " row_number() over (partition by cik order by filing_date desc, accession desc) rn"
        " from raw.sec_filing where form in ('10-K','10-Q','8-K','20-F','6-K','10-K/A','10-Q/A')) x where rn <= 12",
    )
    q = _frame(conn, "select * from core.company_quarter order by cik, qend")
    q["qend"] = pd.to_datetime(q["qend"])
    quarters = sorted(q.loc[q["qend"] <= end, "qend"].unique())
    qidx = {d: i for i, d in enumerate(quarters)}

    # ---------------------------------------------------------------- panel.json
    series = {}
    for cik, g in q[q["qend"] <= end].groupby("cik"):
        cols = {}
        pos = [qidx[d] for d in g["qend"]]
        for m in PANEL_METRICS:
            arr = [None] * len(quarters)
            for i, v in zip(pos, g[m]):
                arr[i] = _num(v)
            cols[m] = arr
        basis = [None] * len(quarters)
        for i, v in zip(pos, g["expense_basis"]):
            basis[i] = v
        cols["expense_basis"] = basis
        series[str(cik)] = cols
    sizes["panel"] = _write("panel.json", {"quarters": [d.strftime("%Y-%m-%d") for d in quarters],
                                           "metrics": PANEL_METRICS, "series": series})

    # ---------------------------------------------------------------- companies.json
    est = _frame(conn, "select cik, param, mean, lo, hi from model.loss_param where run_id = "
                       "(select max(run_id) from model.run where kind = 'loss_ratio_hierarchical')")
    latest = q[q["qend"] <= end].sort_values("qend").groupby("cik").tail(1).set_index("cik")
    first_q = q.dropna(subset=["npe"]).groupby("cik")["qend"].min()
    last_q = q.dropna(subset=["npe"]).groupby("cik")["qend"].max()
    listing = _frame(conn, "select cik, derived, pending_since, pending_forms, last_change_of_control,"
                           " last_delisting, last_deregistration, checked_on from core.company_status")
    listing = listing.set_index("cik") if len(listing) else listing
    companies = []
    for r in comp.itertuples():
        s = sec[sec.cik == r.cik]
        sp = spans[spans.cik == r.cik]
        rec = {
            "cik": r.cik, "ticker": r.ticker, "name": r.short_name, "cohort": r.cohort, "segment": r.segment,
            "status": r.status, "statusYear": r.status_year, "statusNote": r.status_note, "note": r.include_note,
            "comparable": bool(r.comparable),
            "secName": s.name.iloc[0] if len(s) else None, "sic": s.sic.iloc[0] if len(s) else None,
            "incorporated": s.state_of_incorporation.iloc[0] if len(s) else None,
            "firstFiling": str(sp.first_filing.iloc[0]) if len(sp) else None,
            "lastFiling": str(sp.last_filing.iloc[0]) if len(sp) else None,
            "n10k": int(sp.n10k.iloc[0]) if len(sp) else 0, "n10q": int(sp.n10q.iloc[0]) if len(sp) else 0,
            "filings": int(sp.filings.iloc[0]) if len(sp) else 0,
            "firstQuarter": first_q.get(r.cik).strftime("%Y-%m-%d") if r.cik in first_q.index else None,
            "lastQuarter": last_q.get(r.cik).strftime("%Y-%m-%d") if r.cik in last_q.index else None,
        }
        if len(listing) and r.cik in listing.index:
            st = listing.loc[r.cik]
            rec["listing"] = {
                "derived": st.derived, "checkedOn": str(st.checked_on),
                "pendingSince": str(st.pending_since) if st.pending_since else None,
                "pendingForms": st.pending_forms or None,
                "lastChangeOfControl": str(st.last_change_of_control) if st.last_change_of_control else None,
                "lastDelisting": str(st.last_delisting) if st.last_delisting else None,
                "lastDeregistration": str(st.last_deregistration) if st.last_deregistration else None,
            }
        f = fy[fy.cik == r.cik]
        rec["filingsByYear"] = {
            str(int(y)): {k: int(n) for k, n in zip(g.kind, g.n)} for y, g in f.groupby("y")
        }
        rr = recent[recent.cik == r.cik].sort_values("filing_date", ascending=False)
        rec["recentFilings"] = [
            {"form": x.form, "filed": str(x.filing_date), "period": str(x.report_date) if x.report_date else None,
             "url": f"https://www.sec.gov/Archives/edgar/data/{r.cik}/{x.accession.replace('-', '')}/"
                    + (x.primary_document or "")}
            for x in rr.itertuples()
        ]
        if r.cik in latest.index:
            L = latest.loc[r.cik]
            rec["latest"] = {k: _num(L.get(k)) for k in ("npe_ttm", "loss_ratio_ttm", "combined_ratio_ttm",
                                                          "roe_ttm", "npe_growth_yoy", "equity", "reserve_to_npe",
                                                          "pyd_ratio_ttm", "expense_ratio_ttm")}
        e = est[est.cik == r.cik]
        if len(e):
            rec["model"] = {row.param: [_num(row.mean), _num(row.lo), _num(row.hi)] for row in e.itertuples()}
        if r.cik in bundle.exposures.index:
            x = bundle.exposures.loc[r.cik]
            rec["exposure"] = {"geo": _num(x["geo_exposure"], 3), "prof": _num(x["prof_exposure"], 3)}
        if r.cik in bundle.inv.index:
            iv = bundle.inv.loc[r.cik]
            rec["investment"] = {k: _num(iv.get(f"{k}_shrunk"), 3) for k in ("kappa", "d_rate", "d_fin")}
        companies.append(rec)
    sizes["companies"] = _write("companies.json", companies)

    # ---------------------------------------------------------------- macro.json
    m = F.macro(conn)
    drivers = _frame(conn, "select driver, label, unit, grp from ref.driver")
    drivers = drivers[drivers.driver.isin(PUBLIC_DRIVERS)]
    keep = [d for d in drivers.driver if d in m.columns]
    mm = m.loc[m.index >= pd.Timestamp("2000-03-31")]
    shock = bundle.shock.set_index("qend")
    sizes["macro"] = _write("macro.json", {
        "quarters": [d.strftime("%Y-%m-%d") for d in mm.index],
        "partial": [bool(x) for x in mm["partial"]],
        "drivers": [{"key": r.driver, "label": r.label, "unit": r.unit, "group": r.grp} for r in drivers.itertuples()
                    if r.driver in keep],
        "values": {k: _arr(mm[k]) for k in keep},
        "industryShock": {
            "quarters": [pd.Timestamp(d).strftime("%Y-%m-%d") for d in shock.index],
            "mean": _arr(shock["f_mean"], 3), "p10": _arr(shock["f_p10"], 3), "p90": _arr(shock["f_p90"], 3),
        },
    })

    # ---------------------------------------------------------------- disclosure.json
    d = _frame(
        conn,
        "with f as (select cik, accession, extract(year from filing_date)::int y from raw.sec_filing"
        " where form in ('10-K','10-Q','10-K405','10-KT')),"
        " tot as (select cik, y, count(*) n from f group by 1, 2),"
        " hits as (select f.cik, f.y, h.term_key, count(distinct h.accession) k from raw.efts_term_hit h"
        " join f on f.accession = h.accession group by 1, 2, 3)"
        " select tot.cik, tot.y, tot.n, hits.term_key, hits.k from tot left join hits using (cik, y) order by 1, 2",
    )
    themes = sorted(t for t in d.term_key.dropna().unique())
    years = sorted(int(y) for y in d.y.unique() if y >= 2001)
    out = {}
    for cik, g in d.groupby("cik"):
        per = {}
        n_by_year = g.drop_duplicates("y").set_index("y")["n"]
        for t in themes:
            gg = g[g.term_key == t].set_index("y")["k"]
            per[t] = [_num(gg.get(y, 0) / n_by_year.get(y)) if n_by_year.get(y) else None for y in years]
        per["filings"] = [int(n_by_year.get(y, 0)) for y in years]
        out[str(int(cik))] = per
    sizes["disclosure"] = _write("disclosure.json", {"years": years, "themes": themes, "series": out})

    # ---------------------------------------------------------------- model.json
    b = bundle
    comp_models = []
    for ci, cik in enumerate(b.company_order):
        p = b.params[cik]
        comp_models.append({
            "cik": cik, "stream": ci,
            "mu": _arr(p.mu), "rho": _arr(p.rho), "beta": [_arr(row) for row in p.beta], "lam": _arr(p.lam),
            "sigma": _arr(p.sigma),
            "expenseRatio": _num(p.expense_ratio), "lastLrs": _arr(p.last_lrs), "lastF": _arr(p.last_f), "npeQ": _num(p.npe_q),
            "growth": _num(p.growth), "equity": _num(p.equity), "invToEquity": _num(p.inv_to_equity),
            "niiYield": _num(p.nii_yield), "kappa": _num(p.kappa), "kappaC": _num(p.kappa_c, 5),
            "dRate": _num(p.d_rate), "dFin": _num(p.d_fin), "eqSecToEquity": _num(p.eq_sec_to_equity),
            "otherIncomeQ": _num(p.other_income_q), "payout": _num(p.payout),
            "exposures": {k: _num(v) for k, v in p.exposures.items()},
        })
    bs = P.base_for_sim(b.base)
    scen_out = []
    for s in b.scen:
        si = P.scenario_inputs(s, b.base, b.feat_sd)
        scen_out.append({
            "key": s.key, "name": s.name, "story": s.story,
            "shock": {"features": [_arr(x) for x in si["features"]], "f": _arr(si["f"]), "ust5y": _arr(si["ust5y"]),
                      "nfci": _arr(si["nfci"]), "equity": _arr(si["equity"]), "growth": _arr(si["growth"])},
            "natural": {"legalPpiYoy": s.legal_ppi_yoy, "logGpr": s.log_gpr, "nfci": s.nfci,
                        "ust5y": s.ust5y, "equityRet": s.equity_ret, "growth": s.growth,
                        "fByQuarter": {str(k): v for k, v in s.f_by_quarter.items()}},
            "overlays": s.overlays,
        })
    summaries = {sc: {str(c): v for c, v in bysev[next(iter(bysev))].items()} for sc, bysev in b.summaries.items()
                 if not sc.endswith(":no_overlays")}
    no_overlays = {sc.split(":")[0]: {str(c): v for c, v in bysev[next(iter(bysev))].items()}
                   for sc, bysev in b.summaries.items() if sc.endswith(":no_overlays")}
    sizes["model"] = _write("model.json", {
        "end": b.end.strftime("%Y-%m-%d"),
        "horizon": [d.strftime("%Y-%m-%d") for d in b.base["quarters"]],
        "features": F.FEATURES,
        "featureLabels": F.FEATURE_LABELS, "featureUnits": F.FEATURE_UNITS,
        "featureMean": {k: _num(b.feat_mean[k]) for k in F.FEATURES},
        "featureSd": {k: _num(b.feat_sd[k]) for k in F.FEATURES},
        "draws": len(b.draws["mu"]), "tax": 0.21, "seedBase": 20261117,
        "diagnostics": b.diag,
        "companies": comp_models,
        "base": {"features": [[_arr(row) for row in mat] for mat in bs["features"]],
                 "f": [_arr(row) for row in bs["f"]], "ust5y": [_arr(row) for row in bs["ust5y"]],
                 "nfci": [_arr(row) for row in bs["nfci"]], "equity": [_arr(row) for row in bs["equity"]],
                 "start": {k: _num(v) for k, v in bs["start"].items()}},
        "scenarios": scen_out,
    })
    # reference simulations (Python), read by scripts/findings.py; the dashboard does not load this file
    sizes["reference"] = _write("reference.json", {"referenceSummaries": summaries, "referenceSummariesNoOverlays": no_overlays})

    # ---------------------------------------------------------------- meta.json
    counts = _frame(conn, "select source, max(finished_at) finished, max(rows_loaded) rows from meta.ingest_run"
                          " where status = 'ok' group by source")
    facts = _frame(conn, "select count(*) n, count(distinct tag) tags, min(period_end) first, max(filed) last_filed"
                         " from raw.xbrl_fact where cik in (select cik from ref.company where cohort <> 'ai_indicator')")
    sizes["meta"] = _write("meta.json", {
        "built": date.today().isoformat(),
        "dataThrough": b.end.strftime("%Y-%m-%d"),
        "sources": [{"source": r.source, "rows": int(r.rows or 0), "loaded": pd.Timestamp(r.finished).to_pydatetime().astimezone().date().isoformat()}
                    for r in counts.itertuples()],
        "xbrl": {"facts": int(facts.n[0]), "tags": int(facts.tags[0]), "lastFiled": str(facts.last_filed[0])},
        "panel": {"companies": int(b.panel.cik.nunique()), "observations": len(b.panel),
                  "first": b.panel.qend.min().strftime("%Y-%m-%d"), "last": b.panel.qend.max().strftime("%Y-%m-%d")},
        "diagnostics": b.diag,
    })

    # ---------------------------------------------------------------- data domains (claims, catastrophe, ...)
    from . import domains

    if os.environ.get("SIL_SKIP_DOMAINS") == "1":
        return sizes
    def recorded(name: str, obj) -> int:
        sizes[name.removesuffix(".json")] = n = _write(name, obj)
        return n

    domains.export(conn, recorded)
    return sizes
