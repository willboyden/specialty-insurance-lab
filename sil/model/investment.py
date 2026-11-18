"""Investment-side sensitivities, estimated per company with empirical-Bayes shrinkage to the peer median.

1. Reinvestment speed (kappa): the portfolio yield moves a fraction kappa of the gap to market yields each
   quarter:   d(yield)[t] = kappa * (ust5y[t] - yield[t-1]) + c   (c lets the target sit above Treasuries)
   kappa near 0.05 means roughly 5% of the gap closes per quarter (a portfolio of ~5 years' duration).
2. Rate and financial-conditions sensitivity of book value: other comprehensive income as a share of equity
   responds to changes in the 5-year Treasury and in the Chicago Fed NFCI (which moves with credit spreads):
       OCI[t] / equity[t-1] = d_rate * d(ust5y)[t] + d_fin * d(nfci)[t] + e
   d_rate around -0.15 means a 1-point rise in yields cuts book value ~15% through unrealized bond losses.
Company estimates with few quarters or wide standard errors are pulled toward the peer median, by the ratio
of between-company variance to (between-company variance + the company's sampling variance).
"""

from __future__ import annotations

import pandas as pd
import statsmodels.api as sm

from ..standardize import _frame


def _shrink(est: pd.Series, se: pd.Series) -> pd.Series:
    """James-Stein style shrinkage of company estimates toward the median."""
    center = est.median()
    between = max(float(est.var() - (se ** 2).mean()), 1e-8)
    w = between / (between + se ** 2)
    return center + w * (est - center)


def company_panel(conn) -> pd.DataFrame:
    q = _frame(
        conn,
        "select q.cik, q.qend, q.nii_yield, q.oci, q.equity, q.investments, q.npe, q.net_income, q.pretax_income,"
        " q.dividends, q.buybacks, q.equity_securities, q.combined_ratio, q.expense_ratio, q.loss_ratio,"
        " q.npe_growth_yoy, q.reserve_to_npe, q.inv_to_equity, q.equity_share_of_inv, q.nii"
        " from core.company_quarter q join ref.company c using (cik) where c.cohort in ('specialty', 'benchmark')"
        " order by q.cik, q.qend",
    )
    q["qend"] = pd.to_datetime(q["qend"])
    for c in q.columns:
        if c not in ("cik", "qend"):
            q[c] = pd.to_numeric(q[c], errors="coerce")
    return q


def estimate(conn, macro: pd.DataFrame, end: pd.Timestamp) -> pd.DataFrame:
    q = company_panel(conn)
    q = q[(q.qend >= pd.Timestamp("2010-03-31")) & (q.qend <= end)]
    rates = macro[["ust5y", "ust5y_end", "nfci"]].copy()
    rates["d_ust5y"] = rates["ust5y_end"].diff()
    rates["d_fin"] = rates["nfci"].diff()
    q = q.join(rates, on="qend")
    g = q.groupby("cik", group_keys=False)
    consecutive = (q["qend"] - g["qend"].shift(1)).dt.days.between(85, 95)
    q["yield_prev"] = g["nii_yield"].shift(1).where(consecutive)
    q["equity_prev"] = g["equity"].shift(1).where(consecutive)
    q["d_yield"] = q["nii_yield"] - q["yield_prev"]
    q["oci_share"] = q["oci"] / q["equity_prev"]

    rows = []
    for cik, d in q.groupby("cik"):
        rec = {"cik": cik}
        a = d.dropna(subset=["d_yield", "yield_prev", "ust5y"])
        a = a[a["d_yield"].abs() < 0.02]
        if len(a) >= 12:
            X = sm.add_constant((a["ust5y"] / 100 - a["yield_prev"]).rename("gap"))
            r = sm.OLS(a["d_yield"], X).fit()
            rec.update(kappa=r.params["gap"], kappa_se=r.bse["gap"], kappa_c=r.params["const"], kappa_n=len(a))
        b = d.dropna(subset=["oci_share", "d_ust5y", "d_fin"])
        b = b[b["oci_share"].abs() < 0.3]
        if len(b) >= 12:
            r = sm.OLS(b["oci_share"], sm.add_constant(b[["d_ust5y", "d_fin"]])).fit()
            rec.update(d_rate=r.params["d_ust5y"], d_rate_se=r.bse["d_ust5y"], d_fin=r.params["d_fin"],
                       d_fin_se=r.bse["d_fin"], oci_n=len(b))
        rows.append(rec)
    est = pd.DataFrame(rows).set_index("cik")
    for name in ("kappa", "d_rate", "d_fin"):
        ok = est[name].notna()
        est.loc[ok, f"{name}_shrunk"] = _shrink(est.loc[ok, name], est.loc[ok, f"{name}_se"])
        est[f"{name}_shrunk"] = est[f"{name}_shrunk"].fillna(est.loc[ok, f"{name}_shrunk"].median())
    est["kappa_shrunk"] = est["kappa_shrunk"].clip(0.005, 0.25)
    est["kappa_c"] = est["kappa_c"].fillna(est["kappa_c"].median())
    return est


def jump_off(conn, end: pd.Timestamp) -> pd.DataFrame:
    """Each company's latest state, the starting point of every simulation."""
    q = company_panel(conn)
    q = q[q.qend <= end]
    last = q.sort_values("qend").groupby("cik").tail(8)
    recent = last.groupby("cik").tail(4)
    s = pd.DataFrame(index=sorted(q.cik.unique()))
    lastrow = q.sort_values("qend").groupby("cik").tail(1).set_index("cik")
    s["last_qend"] = lastrow["qend"]
    s["equity"] = lastrow["equity"]
    s["investments"] = lastrow["investments"]
    s["npe_q"] = recent.groupby("cik")["npe"].mean()
    s["nii_yield"] = lastrow["nii_yield"]
    s["expense_ratio"] = recent.groupby("cik")["expense_ratio"].mean()
    s["growth"] = lastrow["npe_growth_yoy"]
    s["eq_sec_to_equity"] = (lastrow["equity_securities"] / lastrow["equity"])
    s["inv_to_equity"] = lastrow["inv_to_equity"]
    s["reserve_to_npe"] = lastrow["reserve_to_npe"]
    # pre-tax income not explained by underwriting + net investment income (fees, interest, other)
    other = (last["pretax_income"] - (1 - last["combined_ratio"]) * last["npe"] - last["nii"])
    s["other_income_q"] = other.groupby(last["cik"]).median()
    # capital returned (dividends + buybacks) as a share of net income, over the last eight quarters
    sums = last.groupby("cik")[["dividends", "buybacks", "net_income"]].sum(min_count=1)
    returned = sums["dividends"].fillna(0).clip(lower=0) + sums["buybacks"].fillna(0).clip(lower=0)
    s["payout"] = (returned / sums["net_income"].where(sums["net_income"] > 0)).clip(0, 1.0)
    lr_hist = q.dropna(subset=["loss_ratio"]).sort_values("qend").groupby("cik")
    s["last_lrs"] = lr_hist["loss_ratio"].apply(lambda x: list(x.tail(4)))
    s["last_lr_q"] = lr_hist["qend"].apply(lambda x: list(x.tail(4)))
    s["active"] = s["last_qend"] >= end - pd.Timedelta(days=200)
    return s
