"""Fit every model, build the scenario inputs, run the reference simulations and store the results.

Writes model.* tables and returns a ModelBundle that sil/export.py turns into the dashboard's JSON.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .. import drivers, standardize
from ..db import copy_rows
from ..standardize import _frame
from . import features, investment, loss_model, scenarios, simulate

log = logging.getLogger(__name__)
N_DRAWS = 160


@dataclass
class ModelBundle:
    end: pd.Timestamp
    feat_mean: pd.Series
    feat_sd: pd.Series
    panel: pd.DataFrame
    fit: loss_model.LossFit
    diag: dict
    draws: dict
    shock: pd.DataFrame
    inv: pd.DataFrame
    jump: pd.DataFrame
    base: dict
    scen: list
    exposures: pd.DataFrame
    params: dict          # cik -> CompanyParams (active companies only)
    company_order: list   # ciks in the order used for random streams
    summaries: dict       # scenario -> severity -> cik -> summary


def disclosure_exposures(conn, end: pd.Timestamp) -> pd.DataFrame:
    """Share of each company's 10-K/10-Q filings in the last three years that mention each theme."""
    start = (end - pd.DateOffset(years=3)).date()
    q = _frame(
        conn,
        "with f as (select cik, accession from raw.sec_filing where form in ('10-K','10-Q') and filing_date > %s),"
        " tot as (select cik, count(*) n from f group by cik)"
        " select tot.cik, h.term_key, count(distinct h.accession)::float / tot.n as share, tot.n"
        " from tot left join raw.efts_term_hit h on h.cik = tot.cik and h.accession in (select accession from f)"
        " group by tot.cik, h.term_key, tot.n".replace("%s", f"'{start}'"),
    )
    wide = q.pivot_table(index="cik", columns="term_key", values="share", aggfunc="first").fillna(0.0)
    for col in ("political_risk_line", "war_conflict", "trade_credit_line", "d_and_o", "cyber"):
        if col not in wide.columns:
            wide[col] = 0.0
    geo = wide[["political_risk_line", "war_conflict", "trade_credit_line"]].mean(axis=1)
    prof = wide[["d_and_o", "cyber"]].mean(axis=1)
    wide["geo_exposure"] = geo / geo.max() if geo.max() > 0 else 0.0
    wide["prof_exposure"] = prof / prof.max() if prof.max() > 0 else 0.0
    return wide


def build_params(bundle_parts: dict) -> tuple[dict, list]:
    fit, dr, inv, jump, expo = (bundle_parts[k] for k in ("fit", "draws", "inv", "jump", "exposures"))
    macro = bundle_parts["macro"]
    end = bundle_parts["end"]
    ust5y_recent = macro.loc[macro.index <= end, "ust5y"].tail(8)
    params, order = {}, []
    for idx, cik in enumerate(fit.companies):
        if cik not in jump.index or not bool(jump.loc[cik, "active"]):
            continue
        j = jump.loc[cik]
        lrs = [x for x in (j["last_lrs"] or []) if pd.notna(x)]
        if len(lrs) < 4 or not (j["equity"] > 0) or not (j["npe_q"] > 0):
            continue
        f_mean = bundle_parts["f_mean"]
        last_f = [float(f_mean.get(pd.Timestamp(qq), 0.0)) for qq in j["last_lr_q"][-4:]]
        er = j["expense_ratio"]
        if pd.isna(er):
            er = float(np.nanmedian(jump["expense_ratio"]))
        kappa = float(inv.loc[cik, "kappa_shrunk"]) if cik in inv.index else float(inv["kappa_shrunk"].median())
        # yield target: 5-year Treasury plus the company's recent spread over it
        hist_y = bundle_parts["yields"].get(cik)
        spread = 0.0
        if hist_y is not None and len(hist_y):
            aligned = pd.concat([hist_y, ust5y_recent / 100], axis=1, join="inner").dropna()
            if len(aligned):
                spread = float(np.clip((aligned.iloc[:, 0] - aligned.iloc[:, 1]).mean(), -0.01, 0.03))
        y0 = j["nii_yield"] if pd.notna(j["nii_yield"]) else float(ust5y_recent.iloc[-1] / 100 + spread)
        growth = j["growth"] if pd.notna(j["growth"]) else 0.05
        growth = float(np.clip(0.5 * growth + 0.5 * 0.05, -0.2, 0.4))
        e = expo.loc[cik] if cik in expo.index else None
        exposures = {
            "geo_exposure": float(e["geo_exposure"]) if e is not None else 0.0,
            "prof_exposure": float(e["prof_exposure"]) if e is not None else 0.0,
            "reserve_charge": float(0.04 * j["reserve_to_npe"] * 4 / 6 * 100) if pd.notna(j["reserve_to_npe"]) else 0.0,
        }
        params[cik] = simulate.CompanyParams(
            mu=dr["mu"][:, idx], rho=dr["rho"][:, idx], beta=dr["beta"][:, idx, :], lam=dr["lam"][:, idx],
            sigma=dr["sigma"][:, idx], expense_ratio=float(er), last_lrs=lrs[-4:], last_f=last_f, npe_q=float(j["npe_q"]),
            growth=growth, equity=float(j["equity"]),
            inv_to_equity=float(j["inv_to_equity"]) if pd.notna(j["inv_to_equity"]) else 3.0,
            nii_yield=float(y0), kappa=kappa, kappa_c=kappa * spread,
            d_rate=float(inv.loc[cik, "d_rate_shrunk"]) if cik in inv.index else float(inv["d_rate_shrunk"].median()),
            d_fin=float(inv.loc[cik, "d_fin_shrunk"]) if cik in inv.index else float(inv["d_fin_shrunk"].median()),
            eq_sec_to_equity=float(j["eq_sec_to_equity"]) if pd.notna(j["eq_sec_to_equity"]) else 0.0,
            other_income_q=float(j["other_income_q"]) if pd.notna(j["other_income_q"]) else 0.0,
            payout=float(j["payout"]) if pd.notna(j["payout"]) else 0.2,
            exposures=exposures,
        )
        order.append(cik)
    return params, order


def scenario_inputs(s: scenarios.Scenario | None, base: dict, feat_sd: pd.Series) -> dict:
    if s is None:
        z = [0.0] * scenarios.H
        return {"features": [z] * len(features.FEATURES), "f": z, "ust5y": z, "nfci": z, "equity": z, "growth": z,
                "overlays": []}
    fs = scenarios.shock_features(s, feat_sd)
    return {
        "features": [fs[k] for k in features.FEATURES],
        "f": scenarios.f_shock(s, base["quarters"]),
        "ust5y": list(s.ust5y), "nfci": list(s.nfci), "equity": list(s.equity_ret), "growth": list(s.growth),
        "overlays": s.overlays,
    }


def base_for_sim(base: dict) -> dict:
    return {
        "features": [base["features"][k] for k in features.FEATURES],
        "f": base["f"], "ust5y": base["ust5y"], "nfci": base["nfci"], "equity": base["equity"], "start": base["start"],
    }


def run(conn, draws: int = 2000, tune: int = 3000, chains: int = 4) -> ModelBundle:
    t0 = time.time()
    standardize.build(conn)
    drivers.build(conn)
    m = features.macro(conn)
    end = features.last_complete_quarter(m)
    raw = features.raw_features(m)
    z, mean, sd = features.standardize(raw, end)
    panel = features.panel(conn, z, end)
    fit = loss_model.fit(panel, draws=draws, tune=tune, chains=chains)
    diag = loss_model.diagnostics(fit)
    dr = loss_model.draws(fit, N_DRAWS)
    shock = loss_model.common_shock(fit)
    inv = investment.estimate(conn, m, end)
    base = scenarios.baseline_paths(m, end, shock.set_index("qend")["f_mean"], N_DRAWS, feat_mean=mean, feat_sd=sd)
    expo = disclosure_exposures(conn, end)
    jump, params, order, scen, summaries = _simulations(conn, m, end, fit, dr, shock, inv, base, expo, sd)
    bundle = ModelBundle(end, mean, sd, panel, fit, diag, dr, shock, inv, jump, base, scen, expo, params, order,
                         summaries)
    _store(conn, bundle)
    log.info("model pipeline done in %.0fs: %s", time.time() - t0, json.dumps(diag))
    return bundle


def resimulate(conn, b: ModelBundle) -> ModelBundle:
    """Re-run the company simulations on an existing fit (no MCMC): for when only the set of independent,
    reporting companies changed (sil/status.py). The posterior, drivers and scenarios stay as they were."""
    t0 = time.time()
    m = features.macro(conn)
    jump, params, order, scen, summaries = _simulations(conn, m, b.end, b.fit, b.draws, b.shock, b.inv, b.base,
                                                        b.exposures, b.feat_sd)
    out = ModelBundle(b.end, b.feat_mean, b.feat_sd, b.panel, b.fit, b.diag, b.draws, b.shock, b.inv, jump, b.base,
                      scen, b.exposures, params, order, summaries)
    log.info("re-simulated %d companies on the stored fit in %.0fs", len(order), time.time() - t0)
    return out


def _simulations(conn, m, end, fit, dr, shock, inv, base, expo, sd):
    jump = investment.jump_off(conn, end)
    yq = investment.company_panel(conn)
    yields = {cik: g.set_index("qend")["nii_yield"].tail(8) for cik, g in yq.groupby("cik")}
    f_mean = {pd.Timestamp(r.qend): float(r.f_mean) for r in shock.itertuples()}
    params, order = build_params({"fit": fit, "draws": dr, "inv": inv, "jump": jump, "exposures": expo,
                                  "macro": m, "end": end, "yields": yields, "f_mean": f_mean})
    scen = scenarios.all_scenarios()
    bsim = base_for_sim(base)
    summaries: dict = {}
    for s in [None, *scen]:
        key = "baseline" if s is None else s.key
        shock_in = scenario_inputs(s, base, sd)
        summaries[key] = {}
        for sev in ((1.0,) if s is not None else (0.0,)):
            summaries[key][sev] = {}
            for ci, cik in enumerate(order):
                sim = simulate.simulate_company(ci, params[cik], bsim, shock_in, sev)
                summaries[key][sev][cik] = simulate.summarize(sim)
    # the same scenarios with the assumption overlays switched off: how much of each hit is assumption
    for s in scen:
        if not s.overlays:
            continue
        shock_in = scenario_inputs(s, base, sd)
        summaries[f"{s.key}:no_overlays"] = {1.0: {
            cik: simulate.summarize(simulate.simulate_company(ci, params[cik], bsim, shock_in, 1.0, overlays_on=False))
            for ci, cik in enumerate(order)
        }}
    return jump, params, order, scen, summaries


def _store(conn, b: ModelBundle) -> None:
    import arviz as az

    run_id = conn.execute(
        "insert into model.run(kind, params, metrics) values ('loss_ratio_hierarchical', %s, %s) returning run_id",
        (json.dumps({"features": features.FEATURES, "end": str(b.end.date()), "draws_exported": N_DRAWS}),
         json.dumps(b.diag)),
    ).fetchone()[0]
    s = az.summary(b.fit.idata, var_names=["mu", "rho", "lam", "sigma", "beta"])
    conn.execute("create table if not exists model.loss_param (run_id bigint, cik integer, param text,"
                 " mean double precision, sd double precision, lo double precision, hi double precision,"
                 " r_hat double precision)")
    rows = []
    for name, r in s.iterrows():
        base, _, inside = name.partition("[")
        parts = inside.rstrip("]").split(", ")
        cik = int(parts[0])
        param = base if len(parts) == 1 else f"{base}:{parts[1]}"
        rows.append((run_id, cik, param, float(r["mean"]), float(r["sd"]), float(r.iloc[2]), float(r.iloc[3]),
                     float(r["r_hat"])))
    copy_rows(conn, "model.loss_param", ("run_id", "cik", "param", "mean", "sd", "lo", "hi", "r_hat"), rows)
    conn.execute("create table if not exists model.industry_shock (run_id bigint, qend date, f_mean double precision,"
                 " f_p10 double precision, f_p90 double precision)")
    copy_rows(conn, "model.industry_shock", ("run_id", "qend", "f_mean", "f_p10", "f_p90"),
              [(run_id, pd.Timestamp(r.qend).date(), float(r.f_mean), float(r.f_p10), float(r.f_p90))
               for r in b.shock.itertuples()])
    conn.execute("create table if not exists model.scenario_summary (run_id bigint, scenario text, severity double"
                 " precision, cik integer, summary jsonb)")
    copy_rows(conn, "model.scenario_summary", ("run_id", "scenario", "severity", "cik", "summary"),
              [(run_id, sc, sev, cik, json.dumps(v)) for sc, bysev in b.summaries.items()
               for sev, bycik in bysev.items() for cik, v in bycik.items()])
    conn.commit()
