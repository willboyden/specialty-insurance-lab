"""Catastrophes: public peril data, how well it explains the loss model's industry shock, where losses land,
which carriers carry the risk, and the catastrophe losses carriers report (see sil/domains.py).

Sources (sil/sources/perils.py): NOAA NHC HURDAT2, NOAA SPC severe weather database, USGS ComCat, NIFC, NOAA CPC
ONI, OpenFEMA NFIP claims; reused from the core layer: NOAA Storm Events, NOAA billion-dollar events, OpenFEMA
disaster declarations, NOAA global temperature, FRED CPI (deflator). Company-reported catastrophe losses come from
cached earnings releases (sil/sources/cat_losses.py). Nothing here touches the loss model: the industry shock and
each carrier's catastrophe sensitivity are read from the latest model run.

Core tables: core.peril_quarter, core.peril_year, core.peril_state, core.cat_shock_fit, core.cat_loss_reported.
Export: catastrophe.json.
"""

from __future__ import annotations

import logging
from datetime import date

import numpy as np
import pandas as pd

from .sources import cat_losses, perils
from .standardize import _frame

log = logging.getLogger(__name__)

SOURCES = {"perils": perils.ingest_perils, "nfip": perils.ingest_nfip}

FIRST_Q = pd.Timestamp("2000-03-31")
FIT_START = pd.Timestamp("2010-03-31")
REGRESSORS = [  # key, label, column, transform
    ("hurricane", "US hurricane landfalls (sum of category squared)", "us_landfall_index"),
    ("convective", "Significant hail, tornado and wind reports", "sig_convective"),
    ("flood", "NFIP flood claims paid", "nfip_paid"),
    ("wildfire", "Wildfire property damage (Storm Events)", "storm_damage_wildfire"),
]
FEMA_NOTE = ("This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA. "
             "The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the "
             "data have been retrieved from the Agency's website(s).")


def _qend(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s).dt.to_period("Q").dt.end_time.dt.normalize()


def _latest_run(conn) -> int | None:
    r = conn.execute("select max(run_id) from model.run where kind = 'loss_ratio_hierarchical'").fetchone()
    return r[0] if r else None


def _cpi_factor(conn) -> pd.Series:
    """Monthly factor to today's prices (latest CPI-U month / that month's CPI-U), indexed by month start."""
    cpi = _frame(conn, "select obs_date, value from raw.fred_observation where series_id = 'CPIAUCSL' order by obs_date")
    if cpi.empty:
        return pd.Series(dtype=float)
    s = cpi.set_index(pd.to_datetime(cpi["obs_date"]))["value"].astype(float)
    return s.iloc[-1] / s


def _real(nominal: pd.Series, months: pd.Series, factor: pd.Series) -> pd.Series:
    if factor.empty:
        return nominal
    f = pd.to_datetime(months).map(factor)
    f = f.fillna(factor.iloc[-1] if len(factor) else 1.0)  # months past the last CPI print: latest prices
    return nominal * f.to_numpy()


def _hurdat(conn) -> dict:
    rows = conn.execute("select storm_id, storm_name, season, obs_time, record_id, status, lat, lon, wind_kt,"
                        " pressure_mb from raw.hurdat_point order by storm_id, obs_time").fetchall()
    stats = perils.season_stats(rows)
    names = {r[0]: r[1] for r in rows}
    stats["names"] = names
    return stats


# ---------------------------------------------------------------- build

def build(conn) -> dict:
    factor = _cpi_factor(conn)
    hur = _hurdat(conn)
    out: dict = {}

    # ---- quarterly
    landf = pd.DataFrame([{"storm": k, "first": v["first"], "category": v["category"]}
                          for k, v in hur["us_landfalls"].items()])
    q = pd.DataFrame(index=pd.DatetimeIndex([], name="qend"))
    if len(landf):
        landf["qend"] = _qend(landf["first"])
        g = landf.groupby("qend")
        q = q.reindex(q.index.union(g.size().index))
        q["us_landfalls"] = g.size()
        q["us_major_landfalls"] = g["category"].apply(lambda c: int((c >= 3).sum()))
        q["us_landfall_index"] = g["category"].apply(lambda c: float((c ** 2).sum()))
    pts = conn.execute("select season, obs_time, status, wind_kt from raw.hurdat_point").fetchall()
    ace = pd.DataFrame(pts, columns=["season", "t", "status", "wind"])
    ace = ace[(ace["status"].isin(["TS", "HU", "SS"])) & (ace["wind"] >= 35)
              & ace["t"].map(lambda t: t.minute == 0 and t.hour in (0, 6, 12, 18))]
    ace["qend"] = _qend(ace["t"])
    ace_q = (ace["wind"].astype(float) ** 2 / 1e4).groupby(ace["qend"]).sum()

    spc = _frame(conn, "select month, kind, n_reports, n_significant from raw.spc_report_month")
    spc["qend"] = _qend(spc["month"])
    spc_q = spc.pivot_table(index="qend", columns="kind", values=["n_reports", "n_significant"], aggfunc="sum")
    quakes = _frame(conn, "select time_utc, mag from raw.usgs_quake")
    quakes["qend"] = _qend(quakes["time_utc"].dt.tz_convert(None))
    nfip = _frame(conn, "select month, state, n_claims, paid_building + paid_contents + paid_icc as paid"
                        " from raw.nfip_claim_month")
    if len(nfip):
        nfip["real"] = _real(nfip["paid"].astype(float), nfip["month"], factor)
        nfip["qend"] = _qend(nfip["month"])
    macro = _frame(conn, "select qend, storm_damage, storm_damage_hurricane, storm_damage_convective,"
                         " storm_damage_wildfire, storm_damage_flood, billion_cost, fema_major, partial"
                         " from core.macro_quarter")
    macro["qend"] = pd.to_datetime(macro["qend"])
    macro = macro.set_index("qend")
    oni = _frame(conn, "select year, mid_month, anom_c from raw.enso_oni")
    oni["qend"] = pd.to_datetime([date(int(y), int(m), 1) for y, m in zip(oni["year"], oni["mid_month"])])
    oni["qend"] = _qend(oni["qend"])
    run = _latest_run(conn)
    shock = _frame(conn, f"select qend, f_mean, f_p10, f_p90 from model.industry_shock where run_id = {int(run)}"
                   ) if run else pd.DataFrame(columns=["qend", "f_mean", "f_p10", "f_p90"])
    shock["qend"] = pd.to_datetime(shock["qend"])

    last_q = max(macro.index.max(), pd.Timestamp(date.today()).to_period("Q").end_time.normalize())
    idx = pd.date_range(FIRST_Q, last_q, freq="QE")
    pq = pd.DataFrame(index=idx)
    pq.index.name = "qend"
    last_season = max(hur["ace"]) if hur["ace"] else 1850
    in_hurdat = idx <= pd.Timestamp(f"{last_season}-12-31")
    for col in ("us_landfalls", "us_major_landfalls", "us_landfall_index"):
        pq[col] = q[col].reindex(idx) if col in q else np.nan
        pq.loc[in_hurdat, col] = pq.loc[in_hurdat, col].fillna(0)
    pq["ace"] = ace_q.reindex(idx)
    pq.loc[in_hurdat, "ace"] = pq.loc[in_hurdat, "ace"].fillna(0)
    spc_last = pd.to_datetime(spc["qend"]).max()
    in_spc = idx <= spc_last
    for kind, col_n, col_s in (("tornado", "tornadoes", "sig_tornadoes"), ("hail", None, "sig_hail"),
                               ("wind", None, "sig_wind")):
        if col_n:
            pq[col_n] = spc_q["n_reports"][kind].reindex(idx) if ("n_reports", kind) in spc_q else np.nan
            pq.loc[in_spc, col_n] = pq.loc[in_spc, col_n].fillna(0)
        pq[col_s] = spc_q["n_significant"][kind].reindex(idx) if ("n_significant", kind) in spc_q else np.nan
        pq.loc[in_spc, col_s] = pq.loc[in_spc, col_s].fillna(0)
    q_now = pd.Timestamp(date.today()).to_period("Q").end_time.normalize()
    pq["quakes_m5"] = quakes.groupby("qend").size().reindex(idx).fillna(0)
    pq["quakes_m6"] = quakes[quakes["mag"] >= 6].groupby("qend").size().reindex(idx).fillna(0)
    pq.loc[pq.index > q_now, ["quakes_m5", "quakes_m6"]] = np.nan
    if len(nfip):
        pq["nfip_paid"] = nfip.groupby("qend")["real"].sum().reindex(idx)
        pq["nfip_claims"] = nfip.groupby("qend")["n_claims"].sum().reindex(idx)
        nf_last = nfip["qend"].max()
        inside = idx <= nf_last
        pq.loc[inside, ["nfip_paid", "nfip_claims"]] = pq.loc[inside, ["nfip_paid", "nfip_claims"]].fillna(0)
    else:
        pq["nfip_paid"] = np.nan
        pq["nfip_claims"] = np.nan
    for col in ("storm_damage", "storm_damage_hurricane", "storm_damage_convective", "storm_damage_wildfire",
                "storm_damage_flood", "billion_cost"):
        pq[col] = macro[col].reindex(idx).astype(float) * 1e9  # macro holds $bn at today's prices
    pq["fema_major"] = macro["fema_major"].reindex(idx)
    pq["oni"] = oni.groupby("qend")["anom_c"].mean().reindex(idx)
    sh = shock.set_index("qend")
    for col in ("f_mean", "f_p10", "f_p90"):
        pq[col] = sh[col].reindex(idx) if len(sh) else np.nan
    _write_frame(conn, "core.peril_quarter", pq.reset_index().rename(columns={"index": "qend"}),
                 ["qend", "us_landfalls", "us_major_landfalls", "us_landfall_index", "ace", "tornadoes",
                  "sig_tornadoes", "sig_hail", "sig_wind", "quakes_m5", "quakes_m6", "nfip_paid", "nfip_claims",
                  "storm_damage", "storm_damage_hurricane", "storm_damage_convective", "storm_damage_wildfire",
                  "storm_damage_flood", "billion_cost", "fema_major", "oni", "f_mean", "f_p10", "f_p90"])
    out["quarters"] = len(pq)

    # ---- annual
    years = list(range(1950, last_season + 1))
    py = pd.DataFrame(index=pd.Index(years, name="year"))
    if len(landf):
        landf["year"] = pd.to_datetime(landf["first"]).dt.year
        py["us_landfalls"] = landf.groupby("year").size().reindex(years).fillna(0)
        for c in range(1, 6):
            py[f"us_landfalls_cat{c}"] = landf[landf["category"] == c].groupby("year").size().reindex(years).fillna(0)
    py["ace"] = pd.Series(hur["ace"]).reindex(years).fillna(0)
    py["named_storms"] = pd.Series(hur["named"]).reindex(years).fillna(0)
    py["hurricanes"] = pd.Series(hur["hurricanes"]).reindex(years).fillna(0)
    spc["year"] = pd.to_datetime(spc["month"]).dt.year
    spc_y = spc.pivot_table(index="year", columns="kind", values=["n_reports", "n_significant"], aggfunc="sum")
    for kind, col_n, col_s in (("tornado", "tornadoes", "sig_tornadoes"), ("hail", "hail_reports", "sig_hail"),
                               ("wind", "wind_reports", "sig_wind")):
        first = 1950 if kind == "tornado" else 1955
        for src, col in (("n_reports", col_n), ("n_significant", col_s)):
            s = spc_y[src][kind].reindex(years) if (src, kind) in spc_y else pd.Series(np.nan, index=years)
            s[s.index >= first] = s[s.index >= first].fillna(0)
            py[col] = s
    nifc = _frame(conn, "select year, fires, acres from raw.nifc_wildfire_year").set_index("year")
    py["wildfire_fires"] = nifc["fires"].reindex(years)
    py["wildfire_acres"] = nifc["acres"].reindex(years)
    if len(nfip):
        nfip["year"] = pd.to_datetime(nfip["month"]).dt.year
        ny = nfip.groupby("year")[["real", "n_claims"]].sum()
        py["nfip_paid"] = ny["real"].reindex(years)
        py["nfip_claims"] = ny["n_claims"].reindex(years)
    else:
        py["nfip_paid"] = np.nan
        py["nfip_claims"] = np.nan
    quakes["year"] = pd.to_datetime(quakes["time_utc"]).dt.year
    py["quakes_m5"] = quakes.groupby("year").size().reindex(years)
    py["quakes_m6"] = quakes[quakes["mag"] >= 6].groupby("year").size().reindex(years)
    py.loc[py.index >= 1973, ["quakes_m5", "quakes_m6"]] = py.loc[py.index >= 1973, ["quakes_m5", "quakes_m6"]].fillna(0)
    bd = _frame(conn, "select begin_date, cpi_adjusted_cost_musd from raw.noaa_billion_event")
    bd["year"] = pd.to_datetime(bd["begin_date"]).dt.year
    if len(bd):
        last_bd = int(bd["year"].max())
        py["billion_cost"] = (bd.groupby("year")["cpi_adjusted_cost_musd"].sum() * 1e6).reindex(years)
        py["billion_count"] = bd.groupby("year").size().reindex(years)
        inside = (py.index >= 1980) & (py.index <= last_bd)
        py.loc[inside, ["billion_cost", "billion_count"]] = py.loc[inside, ["billion_cost", "billion_count"]].fillna(0)
    sd = macro["storm_damage"].astype(float)
    sd_y = (sd * 1e9).groupby(sd.index.year).sum(min_count=1)
    py["storm_damage"] = sd_y.reindex(years)
    aso = oni[oni["mid_month"] == 9].set_index("year")["anom_c"]
    py["oni_aso"] = aso.reindex(years)
    gt = _frame(conn, "select year, anomaly_c from raw.noaa_global_temp").set_index("year")
    py["global_temp"] = gt["anomaly_c"].reindex(years)
    _write_frame(conn, "core.peril_year", py.reset_index(), ["year", *[c for c in py.columns]])
    out["years"] = len(py)

    # ---- states (2000 onward)
    st = pd.DataFrame(index=pd.Index(sorted(k for k in perils.STATES if k != "DC") + ["DC"], name="state"))
    st["nfip_paid"] = nfip.groupby("state")["real"].sum() if len(nfip) else np.nan
    ev = _frame(conn, "select month, state, event_type, property_damage_usd from raw.storm_event_month"
                      " where month >= '2000-01-01'")
    code = {v.lower(): k for k, v in perils.STATES.items()} | {"district of columbia": "DC", "virgin islands": "VI"}
    ev["code"] = ev["state"].str.lower().map(code)
    ev = ev.dropna(subset=["code"])
    ev["real"] = _real(ev["property_damage_usd"].astype(float), ev["month"], factor)
    et = ev["event_type"].str.lower()
    st["storm_damage"] = ev.groupby("code")["real"].sum()
    for col, mask in (("storm_damage_hurricane", et.str.contains("hurricane|tropical|storm surge|typhoon")),
                      ("storm_damage_convective", et.str.contains("hail|tornado|thunderstorm|funnel")),
                      ("storm_damage_wildfire", et.str.contains("wildfire")),
                      ("storm_damage_flood", et.str.contains("flood"))):
        st[col] = ev[mask].groupby("code")["real"].sum()
    spc_st = _frame(conn, "select state, kind, sum(n_significant) n from raw.spc_report_month"
                          " where month >= '2000-01-01' group by 1, 2")
    st["sig_hail"] = spc_st[spc_st["kind"] == "hail"].set_index("state")["n"]
    st["sig_tornadoes"] = spc_st[spc_st["kind"] == "tornado"].set_index("state")["n"]
    fe = _frame(conn, "select state, count(distinct disaster_number) n from raw.fema_declaration"
                      " where declaration_type = 'DR' and declaration_date >= '2000-01-01' group by 1")
    st["fema_major"] = fe.set_index("state")["n"]
    filled = [c for c in st.columns if c != "nfip_paid" or len(nfip)]
    st[filled] = st[filled].fillna(0)
    _write_frame(conn, "core.peril_state", st.reset_index(), ["state", "nfip_paid", "storm_damage",
                 "storm_damage_hurricane", "storm_damage_convective", "storm_damage_wildfire",
                 "storm_damage_flood", "sig_hail", "sig_tornadoes", "fema_major"])
    out["states"] = len(st)

    # ---- how much of the industry shock US perils explain
    out["fit"] = _fit_shock(conn, pq)

    # ---- catastrophe losses the carriers report (cached earnings releases only)
    from .http import Fetcher

    out["reported"] = cat_losses.run(conn, Fetcher())
    return out


def _write_frame(conn, table: str, df: pd.DataFrame, cols: list[str]) -> None:
    conn.execute(f"delete from {table}")
    rows = []
    for rec in df[cols].itertuples(index=False):
        row = []
        for v in rec:
            if isinstance(v, pd.Timestamp):
                row.append(v.date())
            elif v is None or (isinstance(v, float) and np.isnan(v)):
                row.append(None)
            elif isinstance(v, (np.integer,)):
                row.append(int(v))
            elif isinstance(v, (np.floating,)):
                row.append(None if np.isnan(v) else float(v))
            else:
                row.append(v)
        rows.append(tuple(row))
    with conn.cursor() as cur:
        cur.executemany(f"insert into {table} ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})", rows)
    conn.commit()


def regressors(pq: pd.DataFrame) -> pd.DataFrame:
    """The peril indices the shock is regressed on: log(1 + x), so a few huge quarters do not dominate."""
    x = pd.DataFrame(index=pq.index)
    x["hurricane"] = np.log1p(pq["us_landfall_index"].astype(float))
    x["convective"] = np.log1p((pq["sig_hail"] + pq["sig_tornadoes"] + pq["sig_wind"]).astype(float))
    x["flood"] = np.log1p(pq["nfip_paid"].astype(float) / 1e6)
    x["wildfire"] = np.log1p(pq["storm_damage_wildfire"].astype(float) / 1e6)
    return x


def ols(y: np.ndarray, x: np.ndarray) -> dict:
    """OLS with an intercept: coefficients, standard errors, R^2 and adjusted R^2."""
    n, k = x.shape
    xx = np.column_stack([np.ones(n), x])
    beta, *_ = np.linalg.lstsq(xx, y, rcond=None)
    resid = y - xx @ beta
    sse = float(resid @ resid)
    sst = float(((y - y.mean()) ** 2).sum())
    dof = max(1, n - k - 1)
    cov = sse / dof * np.linalg.pinv(xx.T @ xx)
    se = np.sqrt(np.clip(np.diag(cov), 0, None))
    r2 = 1 - sse / sst if sst > 0 else float("nan")
    return {"beta": beta, "se": se, "r2": r2, "adj_r2": 1 - (1 - r2) * (n - 1) / dof, "fitted": xx @ beta,
            "resid": resid}


def loyo_r2(y: np.ndarray, x: np.ndarray, groups: np.ndarray) -> float:
    """Leave-one-year-out cross-validated R^2: refit without each year, predict that year's quarters."""
    pred = np.empty_like(y)
    for g in np.unique(groups):
        test = groups == g
        fit = ols(y[~test], x[~test])
        pred[test] = np.column_stack([np.ones(test.sum()), x[test]]) @ fit["beta"]
    sst = float(((y - y.mean()) ** 2).sum())
    return 1 - float(((y - pred) ** 2).sum()) / sst if sst > 0 else float("nan")


def _fit_shock(conn, pq: pd.DataFrame) -> dict:
    x = regressors(pq)
    data = pd.concat([pq["f_mean"].rename("f"), x], axis=1)
    data = data[(data.index >= FIT_START)].dropna()
    conn.execute("delete from core.cat_shock_fit")
    if len(data) < 16:
        conn.commit()
        log.warning("shock fit: only %d complete quarters, skipped", len(data))
        return {"n": len(data)}
    keys = [k for k, _l, _c in REGRESSORS]
    xm = data[keys].to_numpy()
    mu, sdv = xm.mean(axis=0), xm.std(axis=0, ddof=0)
    sdv[sdv == 0] = 1.0
    z = (xm - mu) / sdv
    y = data["f"].to_numpy()
    fit = ols(y, z)
    cv = loyo_r2(y, z, data.index.year.to_numpy())
    rows = [("(intercept)", "Intercept", fit["beta"][0], fit["se"][0], None)]
    for j, (k, label, _c) in enumerate(REGRESSORS):
        r = float(np.corrcoef(y, xm[:, j])[0, 1])
        rows.append((k, label, fit["beta"][j + 1], fit["se"][j + 1], r))
    with conn.cursor() as cur:
        for term, label, b, se, r in rows:
            cur.execute("insert into core.cat_shock_fit(term, label, coef, se, t, r, n) values (%s,%s,%s,%s,%s,%s,%s)",
                        (term, label, float(b), float(se), float(b / se) if se else None, r, len(y)))
        cur.execute("insert into core.cat_shock_fit(term, label, n, r2, adj_r2, cv_r2, window_start, window_end)"
                    " values ('_summary', 'Model of the industry shock on US peril indices', %s, %s, %s, %s, %s, %s)",
                    (len(y), fit["r2"], fit["adj_r2"], cv, data.index.min().date(), data.index.max().date()))
    conn.commit()
    log.info("shock fit on %d quarters (%s to %s): R2 %.2f, adjusted %.2f, leave-one-year-out %.2f", len(y),
             data.index.min().date(), data.index.max().date(), fit["r2"], fit["adj_r2"], cv)
    return {"n": len(y), "r2": round(fit["r2"], 3), "adj_r2": round(fit["adj_r2"], 3), "cv_r2": round(cv, 3)}


def fitted_shock(conn) -> pd.Series:
    """The shock predicted by the stored fit, for every quarter with all four indices (in and after the window)."""
    pq = _frame(conn, "select * from core.peril_quarter order by qend")
    pq["qend"] = pd.to_datetime(pq["qend"])
    pq = pq.set_index("qend")
    terms = _frame(conn, "select term, coef from core.cat_shock_fit where term not like '\\_%%'").set_index("term")["coef"]
    if terms.empty:
        return pd.Series(dtype=float)
    x = regressors(pq)
    win = x[(x.index >= FIT_START) & pq["f_mean"].notna()].dropna()
    mu, sdv = win.mean(), win.std(ddof=0).replace(0, 1.0)
    z = (x - mu) / sdv
    return (terms.get("(intercept)", 0.0) + sum(terms[k] * z[k] for k in z.columns if k in terms.index)).where(
        x.notna().all(axis=1))


# ---------------------------------------------------------------- export

def _n(v, digits: int = 4):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f):
        return None
    if abs(f) >= 1e5:
        return round(f)
    return float(f"{f:.{digits}g}")


def _arr(s, digits: int = 4) -> list:
    return [_n(v, digits) for v in s]


def export(conn, write) -> None:
    pq = _frame(conn, "select * from core.peril_quarter order by qend")
    if pq.empty:
        log.warning("catastrophe: no peril data yet (python -m sil ingest perils nfip, then domains catastrophe)")
        return
    pq["qend"] = pd.to_datetime(pq["qend"])
    pq = pq.set_index("qend")
    fitted = fitted_shock(conn).reindex(pq.index)
    py = _frame(conn, "select * from core.peril_year order by year").set_index("year")
    ps = _frame(conn, "select * from core.peril_state order by state")
    fit = _frame(conn, "select * from core.cat_shock_fit")
    summary = fit[fit.term == "_summary"]
    terms = fit[fit.term != "_summary"]
    q_now = pd.Timestamp(date.today()).to_period("Q").end_time.normalize()

    # largest shock quarters and how much of each the US perils account for
    resid = []
    if len(summary):
        w0, w1 = pd.Timestamp(summary.window_start.iloc[0]), pd.Timestamp(summary.window_end.iloc[0])
        inwin = pq[(pq.index >= w0) & (pq.index <= w1)]
        top = inwin.sort_values("f_mean", ascending=False).head(8)
        for qe, r in top.iterrows():
            resid.append({"q": qe.strftime("%Y-%m-%d"), "f": _n(r["f_mean"]), "fitted": _n(fitted.get(qe))})

    # billion-dollar events vs the shock (simple correlation, years the NOAA list covers)
    bj = pq[["f_mean", "billion_cost"]].dropna()
    bj = bj[bj.index >= FIT_START]
    billion_r = float(np.corrcoef(bj["f_mean"], np.log1p(bj["billion_cost"] / 1e6))[0, 1]) if len(bj) > 8 else None

    run = _latest_run(conn)
    comp = _frame(conn, f"""
        select c.cik, c.ticker, c.short_name, c.segment, c.status, c.comparable, p.mean, p.lo, p.hi
        from model.loss_param p join ref.company c using (cik)
        where p.run_id = {int(run) if run else -1} and p.param = 'lam' order by p.mean desc""")

    rep = _frame(conn, "select r.cik, r.qend, r.cat_loss_usd, r.cat_points, r.basis, r.url, r.snippet, q.npe"
                       " from core.cat_loss_reported r left join core.company_quarter q"
                       " on q.cik = r.cik and q.qend = r.qend order by r.cik, r.qend")
    reported = _reported_block(conn, rep, pq, comp)

    events = _frame(conn, "select flood_event, first_loss, n_claims, paid_total, top_state from raw.nfip_event")
    factor = _cpi_factor(conn)
    if len(events):
        events["real"] = _real(events["paid_total"].astype(float),
                               pd.to_datetime(events["first_loss"]).dt.to_period("M").dt.to_timestamp(), factor)
        events = events.sort_values("real", ascending=False).head(12)  # ranked at today's prices, as displayed

    src = _frame(conn, """
        select distinct on (source) source, rows_loaded, finished_at, detail from meta.ingest_run
        where status = 'ok' and source in ('hurdat2', 'spc_severe_weather', 'usgs_earthquakes', 'nifc_wildfires',
          'cpc_oni', 'openfema_nfip_claims') order by source, finished_at desc""")
    loaded = {r.source: (int(r.rows_loaded or 0), pd.Timestamp(r.finished_at).date().isoformat(), r.detail or {})
              for r in src.itertuples()}

    def src_rec(key, name, url, coverage):
        rows, when, _d = loaded.get(key, (0, None, {}))
        return {"key": key, "name": name, "url": url, "coverage": coverage, "rows": rows, "retrieved": when}

    last_season = int(py.index.max())
    oni_rows = conn.execute("select year, season, anom_c from raw.enso_oni order by year, mid_month").fetchall()
    aso_rows = [r for r in oni_rows if r[1] == "ASO"]
    oni_now = {"latest": {"year": oni_rows[-1][0], "season": oni_rows[-1][1], "anom": _n(oni_rows[-1][2], 3)}
               if oni_rows else None,
               "latestAso": {"year": aso_rows[-1][0], "anom": _n(aso_rows[-1][2], 3)} if aso_rows else None}
    obj = {
        "version": 1,
        "built": date.today().isoformat(),
        "femaNote": FEMA_NOTE,
        "sources": [
            src_rec("hurdat2", "NOAA NHC HURDAT2 Atlantic best track", perils.HURDAT_DIR,
                    f"1851–{last_season} seasons"),
            src_rec("spc_severe_weather", "NOAA SPC severe weather database (tornado, hail, wind)", perils.SPC_PAGE,
                    f"1950–{int(pd.to_datetime(_frame(conn, 'select max(month) m from raw.spc_report_month').m[0]).year)}"),
            src_rec("usgs_earthquakes", "USGS ComCat earthquakes, M5+, US states and territories",
                    "https://earthquake.usgs.gov/fdsnws/event/1/", "1973 onward"),
            src_rec("nifc_wildfires", "NIFC wildland fires and acres", perils.NIFC_URL,
                    f"{int(py['wildfire_acres'].first_valid_index())}–{int(py['wildfire_acres'].last_valid_index())}"),
            src_rec("cpc_oni", "NOAA CPC Oceanic Niño Index", perils.ONI_URL, "1950 onward"),
            src_rec("openfema_nfip_claims", "OpenFEMA NFIP Redacted Claims (v3)",
                    "https://www.fema.gov/api/open/v3/NfipClaims", "losses from 2000"),
        ],
        "quarters": [d.strftime("%Y-%m-%d") for d in pq.index],
        "partial": [bool(d >= q_now) for d in pq.index],
        "q": {
            "f": _arr(pq["f_mean"]), "f10": _arr(pq["f_p10"]), "f90": _arr(pq["f_p90"]), "fitted": _arr(fitted),
            "landfallIndex": _arr(pq["us_landfall_index"]), "landfalls": _arr(pq["us_landfalls"]),
            "sigConvective": _arr(pq["sig_hail"] + pq["sig_tornadoes"] + pq["sig_wind"]),
            "nfipPaid": _arr(pq["nfip_paid"]), "wildfireDamage": _arr(pq["storm_damage_wildfire"]),
            "stormDamage": _arr(pq["storm_damage"]), "billionCost": _arr(pq["billion_cost"]), "oni": _arr(pq["oni"], 3),
            "quakesM6": _arr(pq["quakes_m6"]),
        },
        "fit": {
            "window": [str(summary.window_start.iloc[0]), str(summary.window_end.iloc[0])] if len(summary) else None,
            "n": int(summary.n.iloc[0]) if len(summary) else 0,
            "r2": _n(summary.r2.iloc[0], 3) if len(summary) else None,
            "adjR2": _n(summary.adj_r2.iloc[0], 3) if len(summary) else None,
            "cvR2": _n(summary.cv_r2.iloc[0], 3) if len(summary) else None,
            "terms": [{"key": r.term, "label": r.label, "coef": _n(r.coef, 3), "se": _n(r.se, 3), "t": _n(r.t, 3),
                       "r": _n(r.r, 3)} for r in terms.itertuples()],
            "billionR": _n(billion_r, 3), "billionN": len(bj),
            "largest": resid,
        },
        "oni": oni_now,
        "years": [int(y) for y in py.index],
        "y": {k: _arr(py[col]) for k, col in (
            ("landfalls", "us_landfalls"), ("cat1", "us_landfalls_cat1"), ("cat2", "us_landfalls_cat2"),
            ("cat3", "us_landfalls_cat3"), ("cat4", "us_landfalls_cat4"), ("cat5", "us_landfalls_cat5"),
            ("ace", "ace"), ("namedStorms", "named_storms"), ("hurricanes", "hurricanes"),
            ("tornadoes", "tornadoes"), ("sigTornadoes", "sig_tornadoes"), ("hailReports", "hail_reports"),
            ("sigHail", "sig_hail"), ("windReports", "wind_reports"), ("sigWind", "sig_wind"),
            ("wildfireFires", "wildfire_fires"), ("wildfireAcres", "wildfire_acres"), ("nfipPaid", "nfip_paid"),
            ("nfipClaims", "nfip_claims"), ("quakesM5", "quakes_m5"), ("quakesM6", "quakes_m6"),
            ("billionCost", "billion_cost"), ("billionCount", "billion_count"), ("stormDamage", "storm_damage"),
            ("oniAso", "oni_aso"), ("globalTemp", "global_temp"))},
        "states": {
            "codes": list(ps["state"]),
            "names": [perils.STATES.get(s, s) for s in ps["state"]],
            "values": {c: _arr(ps[c]) for c in ("nfip_paid", "storm_damage", "storm_damage_hurricane",
                                                 "storm_damage_convective", "storm_damage_wildfire",
                                                 "storm_damage_flood", "sig_hail", "sig_tornadoes", "fema_major")},
        },
        "nfipEvents": [{"name": r.flood_event, "date": str(r.first_loss), "claims": int(r.n_claims),
                        "paid": _n(r.real), "state": r.top_state} for r in events.itertuples()] if len(events) else [],
        "companies": [{"cik": int(r.cik), "ticker": r.ticker, "name": r.short_name, "segment": r.segment,
                       "status": r.status, "comparable": bool(r.comparable),
                       "lam": [_n(r.mean, 3), _n(r.lo, 3), _n(r.hi, 3)]} for r in comp.itertuples()],
        "reported": reported,
    }
    write("catastrophe.json", obj)


def _reported_block(conn, rep: pd.DataFrame, pq: pd.DataFrame, comp: pd.DataFrame) -> dict:
    listed = conn.execute("select count(*) from raw.sec_document where kind = 'earnings' and doc_type like 'EX-99%%'"
                          ).fetchone()[0]
    block: dict = {"available": bool(len(rep)), "documentsListed": int(listed), "companyQuarters": len(rep),
                   "series": {}, "validation": None, "examples": []}
    if rep.empty:
        return block
    rep["qend"] = pd.to_datetime(rep["qend"])
    rep["ratio"] = rep["cat_loss_usd"] / rep["npe"].astype(float)
    lam = comp.set_index("cik")["mean"] if len(comp) else pd.Series(dtype=float)
    f = pq["f_mean"]
    per = []
    pool_x, pool_y = [], []
    for cik, g in rep.groupby("cik"):
        g = g.sort_values("qend")
        model = (float(lam[cik]) * f.reindex(g["qend"]).to_numpy()) if cik in lam.index else None
        # every quarter from the first to the last reported one: a quarter whose release states no figure stays
        # empty (the chart must not draw a line through it), while the model's component is known for all of them
        grid = pd.date_range(g["qend"].min(), g["qend"].max(), freq="QE")
        gg = g.set_index("qend").reindex(grid)
        model_all = (float(lam[cik]) * f.reindex(grid).to_numpy()) if cik in lam.index else None
        block["series"][str(int(cik))] = {
            "q": [d.strftime("%Y-%m-%d") for d in grid], "usd": _arr(gg["cat_loss_usd"]),
            "ratio": _arr(gg["ratio"], 3), "basis": [b if isinstance(b, str) else None for b in gg["basis"]],
            "model": _arr(model_all, 3) if model_all is not None else None,
            "reported": int(g["ratio"].notna().sum()),
        }
        if model is not None:
            ok = np.isfinite(model) & g["ratio"].notna().to_numpy()
            if ok.sum() >= 8:
                r = float(np.corrcoef(model[ok], g["ratio"].to_numpy()[ok])[0, 1])
                per.append({"cik": int(cik), "r": _n(r, 3), "n": int(ok.sum())})
                pool_x.extend(model[ok])
                pool_y.extend(g["ratio"].to_numpy()[ok])
    if len(pool_x) >= 20:
        block["validation"] = {"pooledR": _n(float(np.corrcoef(pool_x, pool_y)[0, 1]), 3), "n": len(pool_x),
                               "perCompany": per}
    ex = rep.sort_values("cat_loss_usd", ascending=False).head(6)
    block["examples"] = [{"cik": int(r.cik), "q": r.qend.strftime("%Y-%m-%d"), "usd": _n(r.cat_loss_usd),
                          "snippet": (r.snippet or "")[:300], "url": r.url} for r in ex.itertuples()]
    return block
