"""Rolling-origin backtest of the loss-ratio model against naive benchmarks.

For each origin (year-ends 2017-2024): standardize the drivers and fit the hierarchical model on data up to
the origin only, then forecast every active company's quarterly loss ratio 1-8 quarters ahead.

  model, drivers forecast   the honest forecast: drivers simulated from AR(1)s fitted up to the origin
  model, drivers known      a conditional forecast with the realized driver values plugged in (shows how much
                            the drivers explain; not available in real time)
  last four quarters        naive: the average of the last four quarterly loss ratios
  company average           naive: the company's average loss ratio up to the origin

In both model variants the industry (catastrophe) shock is drawn from its own history for the same quarter
of the year: catastrophes cannot be forecast, only their distribution.

Known limitation: company figures are the latest filed values (restatements included), not the values as
first reported, so the backtest has a small look-ahead advantage on restated quarters.
"""

from __future__ import annotations

import json
import logging
import time

import numpy as np
import pandas as pd

from ..db import copy_rows
from . import features, loss_model, scenarios
from .simulate import Mulberry32, stream_seed

log = logging.getLogger(__name__)
ORIGINS = [pd.Timestamp(f"{y}-12-31") for y in range(2017, 2025)]
H = 8
D = 160


def _lr_paths(params: dict, idx: int, ci: int, last4: list[float], last_f: list[float], feats: np.ndarray,
              f: np.ndarray) -> np.ndarray:
    """feats: (D or 1, H, K) z-units; f: (D, H). Returns (D, H) loss ratios (same recursion as simulate.py)."""
    out = np.empty((D, H))
    for d in range(D):
        rng = Mulberry32(stream_seed(d, ci))
        lam = params["lam"][d, idx]
        attr = [lr - lam * lf for lr, lf in zip(last4, last_f, strict=True)]
        fx = feats[d % feats.shape[0]]
        for h in range(H):
            level = sum(attr[-4:]) / len(attr[-4:])
            lr = (params["mu"][d, idx] * (1 - params["rho"][d, idx]) + params["rho"][d, idx] * level
                  + float(params["beta"][d, idx] @ fx[h]) + lam * f[d, h]
                  + params["sigma"][d, idx] * rng.student_t5())
            attr.append(lr - lam * f[d, h])
            out[d, h] = lr
    return out


def run(conn, origins: list[pd.Timestamp] = ORIGINS) -> dict:
    t0 = time.time()
    m = features.macro(conn)
    raw = features.raw_features(m)
    end_all = features.last_complete_quarter(m)
    zall, _, _ = features.standardize(raw, end_all)
    full_panel = features.panel(conn, zall, end_all, min_obs=1)
    actual = full_panel.set_index(["cik", "qend"])["loss_ratio"]
    rows = []
    for origin in origins:
        z, mean, sd = features.standardize(raw, origin)
        panel = features.panel(conn, z, origin)
        fit = loss_model.fit(panel, draws=400, tune=800, chains=4, seed=int(origin.year))
        params = loss_model.draws(fit, D, seed=origin.year)
        shock = loss_model.common_shock(fit).set_index("qend")["f_mean"]
        base = scenarios.baseline_paths(m, origin, shock, D, seed=origin.year, feat_mean=mean, feat_sd=sd)
        horizon = base["quarters"]
        fpaths = base["f"]
        feats_fc = np.stack([base["features"][k] for k in features.FEATURES], axis=2)  # (D, H, K)
        known = z.reindex(horizon)[features.FEATURES].to_numpy()  # realized, standardized at the origin
        hist = panel[panel.qend <= origin]
        for ci, cik in enumerate(fit.companies):
            g = hist[hist.cik == cik].sort_values("qend")
            if g.empty or g.qend.iloc[-1] != origin or len(g) < 4:
                continue
            last4 = g.loss_ratio.tail(4).tolist()
            last_f = [float(shock.get(qq, 0.0)) for qq in g.qend.tail(4)]
            idx = fit.companies.index(cik)
            fc = _lr_paths(params, idx, ci, last4, last_f, feats_fc, fpaths)
            kn = None
            if not np.isnan(known).any():
                kn = _lr_paths(params, idx, ci, last4, last_f, known[None, :, :], fpaths)
            naive4 = float(np.mean(last4))
            avg = float(g.loss_ratio.mean())
            for h, q in enumerate(horizon):
                a = actual.get((cik, q))
                if a is None or pd.isna(a):
                    continue
                rec = {"origin": origin.date(), "cik": cik, "h": h + 1, "qend": q.date(), "actual": float(a),
                       "naive4": naive4, "avg": avg,
                       "fc_p50": float(np.median(fc[:, h])), "fc_p10": float(np.quantile(fc[:, h], 0.1)),
                       "fc_p90": float(np.quantile(fc[:, h], 0.9)), "fc_p25": float(np.quantile(fc[:, h], 0.25)),
                       "fc_p75": float(np.quantile(fc[:, h], 0.75))}
                if kn is not None:
                    rec.update(kn_p50=float(np.median(kn[:, h])), kn_p10=float(np.quantile(kn[:, h], 0.1)),
                               kn_p90=float(np.quantile(kn[:, h], 0.9)))
                rows.append(rec)
        log.info("backtest origin %s: %d forecasts so far (%.0fs)", origin.date(), len(rows), time.time() - t0)
    df = pd.DataFrame(rows)
    _store(conn, df)
    return summarize(df)


def summarize(df: pd.DataFrame) -> dict:
    out = {"origins": sorted({str(o) for o in df.origin}), "forecasts": len(df),
           "companies": int(df.cik.nunique()), "by_horizon": [], "annual": {}}
    for h, g in df.groupby("h"):
        rec = {"h": int(h), "n": len(g)}
        for name, col in (("model", "fc_p50"), ("model_known", "kn_p50"), ("last4", "naive4"), ("average", "avg")):
            if col in g and g[col].notna().any():
                gg = g.dropna(subset=[col])
                rec[f"mae_{name}"] = round(float((gg[col] - gg.actual).abs().mean() * 100), 3)
        rec["cover80"] = round(float(((g.actual >= g.fc_p10) & (g.actual <= g.fc_p90)).mean()), 3)
        rec["cover50"] = round(float(((g.actual >= g.fc_p25) & (g.actual <= g.fc_p75)).mean()), 3)
        out["by_horizon"].append(rec)
    # four-quarter (annual) loss ratio: average of quarters 1-4 and 5-8 ahead
    for label, hs in (("year1", range(1, 5)), ("year2", range(5, 9))):
        g = df[df.h.isin(hs)].groupby(["origin", "cik"]).filter(lambda x: len(x) == 4)
        a = g.groupby(["origin", "cik"]).agg(actual=("actual", "mean"), model=("fc_p50", "mean"),
                                             last4=("naive4", "mean"), average=("avg", "mean"))
        if "kn_p50" in g:
            a["model_known"] = g.groupby(["origin", "cik"])["kn_p50"].mean()
        out["annual"][label] = {"n": len(a)}
        for name in ("model", "model_known", "last4", "average"):
            if name in a and a[name].notna().any():
                aa = a.dropna(subset=[name])
                out["annual"][label][f"mae_{name}"] = round(float((aa[name] - aa.actual).abs().mean() * 100), 3)
    return out


def _store(conn, df: pd.DataFrame) -> None:
    conn.execute("drop table if exists model.backtest")
    cols = list(df.columns)
    types = {c: ("date" if c in ("origin", "qend") else "integer" if c in ("cik", "h") else "double precision")
             for c in cols}
    conn.execute("create table model.backtest (" + ", ".join(f"{c} {types[c]}" for c in cols) + ")")
    copy_rows(conn, "model.backtest", cols,
              ([None if (isinstance(v, float) and pd.isna(v)) else v for v in r] for r in df.itertuples(index=False)))
    conn.commit()


def main() -> None:
    from ..config import EXPORT_DIR
    from ..db import connect

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    conn = connect()
    res = run(conn)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    (EXPORT_DIR / "backtest.json").write_text(json.dumps(res, separators=(",", ":")))
    log.info("backtest: %s", json.dumps(res["annual"]))


if __name__ == "__main__":
    main()
