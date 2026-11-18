"""Model features: quarterly risk drivers, built from core.macro_quarter, and the loss-ratio panel.

Each feature is a transformation of public data, chosen so its effect on loss ratios has a clear mechanism:

  social     producer-price inflation of law offices (4-quarter mean): a litigation-cost / social-inflation proxy
  geo        geopolitical shock: log GPR index minus its mean over the previous 8 quarters
  finstress  Chicago Fed National Financial Conditions Index (quarter average; 0 = average, positive = tighter):
             financial stress, recessions, credit events. (Public data; the Baa spread was tested too, but
             Moody's data may not be republished.)

Catastrophes are NOT an observed feature. Public proxies (NOAA Storm Events damage, FEMA declarations) miss
international and wildfire losses; the model's latent industry shock captures them better (see loss_model.py).
Three candidates were tested and dropped: a cat index built from storm damage and FEMA declarations (the latent
shock tracks insured catastrophes better; docs/findings.md gives the correlations), lagged insurance pricing (its
loading came out positive: prices rise when loss costs rise) and general CPI inflation (its loading came out
negative for Bermuda groups because 2022-23 inflation coincided with a hard reinsurance market; forcing it positive
made the out-of-sample forecasts worse). Both confounds are the pricing cycle, which the model does not represent.

Features are standardized on 2010Q1 to the last complete quarter, so a loading is "loss-ratio points per
one standard deviation of the driver". The means and standard deviations are exported with the model.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..standardize import _frame

FEATURES = ["social", "geo", "finstress"]
FEATURE_LABELS = {
    "social": "Litigation-cost inflation (social inflation proxy)",
    "geo": "Geopolitical shock (GPR index vs its 2-year mean)",
    "finstress": "Financial stress (Chicago Fed NFCI)",
}
FEATURE_UNITS = {
    "social": "% y/y, 4-quarter average",
    "geo": "log points",
    "finstress": "index (0 = average conditions)",
}
STD_START = pd.Timestamp("2010-03-31")


def macro(conn) -> pd.DataFrame:
    m = _frame(conn, "select * from core.macro_quarter order by qend")
    m["qend"] = pd.to_datetime(m["qend"])
    return m.set_index("qend")


def raw_features(m: pd.DataFrame) -> pd.DataFrame:
    f = pd.DataFrame(index=m.index)
    f["social"] = m["legal_ppi_yoy"].rolling(4).mean()
    lg = np.log(m["gpr"])
    f["geo"] = lg - lg.shift(1).rolling(8).mean()
    f["finstress"] = m["nfci"]
    return f


def last_complete_quarter(m: pd.DataFrame) -> pd.Timestamp:
    return m.index[~m["partial"].astype(bool)].max()


def standardize(f: pd.DataFrame, end: pd.Timestamp) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
    window = f.loc[(f.index >= STD_START) & (f.index <= end)]
    mean, sd = window.mean(), window.std()
    return (f - mean) / sd, mean, sd


def panel(conn, z: pd.DataFrame, end: pd.Timestamp, min_npe: float = 15e6, min_obs: int = 6) -> pd.DataFrame:
    """Company-quarter rows for the loss-ratio model.

    Each row carries its company's four previous quarterly loss ratios (lag1..lag4, NaN when missing) and
    their quarter ends (lagq1..lagq4). The model averages the CATASTROPHE-ADJUSTED values of these lags
    (loss ratio minus the company's loading times that quarter's industry shock), so a catastrophe quarter
    does not propagate into later quarters' forecasts. Rows need at least two of the four lags.
    """
    q = _frame(
        conn,
        "select q.cik, c.ticker, c.short_name, c.segment, c.cohort, c.status, q.qend, q.npe, q.losses,"
        " q.loss_ratio, q.losses_ttm, q.npe_ttm from core.company_quarter q join ref.company c using (cik)"
        " where c.cohort in ('specialty', 'benchmark') and c.comparable order by q.cik, q.qend",
    )
    q["qend"] = pd.to_datetime(q["qend"])
    for col in ("npe", "losses", "loss_ratio", "losses_ttm", "npe_ttm"):
        q[col] = q[col].astype(float)
    valid = q[q["loss_ratio"].between(0.05, 2.5) & (q["npe"] >= min_npe)]
    lr_by = {(int(r.cik), r.qend): float(r.loss_ratio) for r in valid.itertuples()}
    for k in range(1, 5):
        lagq = (q["qend"] - pd.offsets.QuarterEnd(k)).dt.normalize()
        q[f"lagq{k}"] = lagq
        q[f"lag{k}"] = [lr_by.get((int(c), d), np.nan) for c, d in zip(q["cik"], lagq, strict=True)]
    lags = q[[f"lag{k}" for k in range(1, 5)]]
    q["n_lags"] = lags.notna().sum(axis=1)
    q["lag_mean"] = lags.mean(axis=1)
    q = q[(q["qend"] >= STD_START) & (q["qend"] <= end)]
    q = q[(q["npe"] >= min_npe) & q["loss_ratio"].between(0.05, 2.5) & (q["n_lags"] >= 2)]
    q = q.join(z, on="qend")
    q = q.dropna(subset=list(z.columns))
    counts = q.groupby("cik")["qend"].transform("count")
    return q[counts >= min_obs].reset_index(drop=True)
