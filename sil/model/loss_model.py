"""Bayesian hierarchical model of quarterly loss ratios (PyMC).

  LR[i,t] = mu[i] * (1 - rho[i]) + rho[i] * A[i,t-1] + sum_k beta[i,k] * x[k,t] + lam[i] * f[t] + e[i,t]

  A[i,t-1]   the average of the company's previous four ATTRITIONAL loss ratios, LR - lam[i] * f: the loss
             ratio with the catastrophe component taken out. Persistence applies to the attritional level only,
             so a catastrophe quarter does not raise later forecasts (catastrophes are one-offs).
  mu[i]      long-run loss ratio when every driver is at its 2010-2026 average
  rho[i]     persistence: how strongly the loss ratio stays near its recent level
  beta[i,k]  loss-ratio points per standard deviation of driver k
  f[t]       the INDUSTRY SHOCK: a latent quarterly factor shared by all carriers, with company loading
             lam[i] > 0. Estimated from loss ratios alone, its largest values fall on the big catastrophe
             quarters (2017 Q3, 2011 Q1, 2018 Q4, 2022 Q3, ...), so lam[i] is each carrier's estimated
             catastrophe sensitivity. Scenarios shock f to represent heavier catastrophe seasons.
  e[i,t]     Student-t (nu = 5) noise with a company-specific scale

Partial pooling: mu, rho, beta and lam are drawn around SEGMENT means (E&S, diversified, Bermuda, niche,
benchmark), so a carrier with a short history borrows strength from its peers. All are non-centered.

Domain prior: the SEGMENT means of the driver loadings are non-negative (half-normal). Litigation-cost inflation,
geopolitical shocks and financial stress should not lower loss ratios on average. Individual carriers can deviate.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
import pandas as pd
import pymc as pm

from .features import FEATURES

log = logging.getLogger(__name__)


@dataclass
class LossFit:
    idata: object
    companies: list[int]
    segments: list[str]
    quarters: list[pd.Timestamp]
    company_segment: np.ndarray
    seconds: float


def fit(panel: pd.DataFrame, draws: int = 1000, tune: int = 1000, chains: int = 4, seed: int = 20261117,
        target_accept: float = 0.9) -> LossFit:
    import time

    companies = sorted(panel["cik"].unique().tolist())
    segments = sorted(panel["segment"].unique().tolist())
    quarters = sorted(panel["qend"].unique().tolist())
    ci = {c: i for i, c in enumerate(companies)}
    si = {s: i for i, s in enumerate(segments)}
    qi = {q: i for i, q in enumerate(quarters)}
    comp_seg = (panel.drop_duplicates("cik").set_index("cik")["segment"].map(si).reindex(companies).to_numpy())
    c_idx = panel["cik"].map(ci).to_numpy()
    q_idx = panel["qend"].map(qi).to_numpy()
    X = panel[FEATURES].to_numpy(dtype=float)
    y = panel["loss_ratio"].to_numpy(dtype=float)
    lag_lr = panel[[f"lag{k}" for k in range(1, 5)]].to_numpy(dtype=float)
    lag_mask = (~np.isnan(lag_lr)).astype(float)
    lag_lr = np.nan_to_num(lag_lr)
    # quarter index of each lag in the model's quarter coordinate; quarters outside it point at an appended 0
    nq = len(quarters)
    lag_qi = np.stack([panel[f"lagq{k}"].map(qi).fillna(nq).astype(int).to_numpy() for k in range(1, 5)], axis=1)
    lag_n = lag_mask.sum(axis=1)

    coords = {"company": companies, "segment": segments, "feature": FEATURES, "quarter": list(range(len(quarters)))}
    t0 = time.time()
    with pm.Model(coords=coords):
        mu_seg = pm.Normal("mu_seg", 0.62, 0.15, dims="segment")
        sd_mu = pm.HalfNormal("sd_mu", 0.10)
        mu_z = pm.Normal("mu_z", 0, 1, dims="company")
        mu = pm.Deterministic("mu", mu_seg[comp_seg] + sd_mu * mu_z, dims="company")

        rho_seg = pm.Normal("rho_seg", 1.0, 1.0, dims="segment")  # logit scale
        sd_rho = pm.HalfNormal("sd_rho", 0.5)
        rho_z = pm.Normal("rho_z", 0, 1, dims="company")
        rho = pm.Deterministic("rho", pm.math.sigmoid(rho_seg[comp_seg] + sd_rho * rho_z), dims="company")

        beta_seg = pm.HalfNormal("beta_seg", 0.03, dims=("segment", "feature"))
        sd_beta = pm.HalfNormal("sd_beta", 0.02, dims="feature")
        beta_z = pm.Normal("beta_z", 0, 1, dims=("company", "feature"))
        beta = pm.Deterministic("beta", beta_seg[comp_seg] + sd_beta * beta_z, dims=("company", "feature"))

        # zero-sum: the shock is measured relative to the sample average, which separates it from each
        # company's long-run level mu (with a free mean, mu and the level of f trade off and mix slowly)
        f = pm.ZeroSumNormal("f", sigma=1.0, dims="quarter")
        # catastrophe sensitivity pooled within segment: a carrier with few quarters borrows its peers' level
        lam_seg = pm.Normal("lam_seg", np.log(0.03), 0.8, dims="segment")
        lam_sd = pm.HalfNormal("lam_sd", 0.5)
        lam_z = pm.Normal("lam_z", 0, 1, dims="company")
        lam = pm.Deterministic("lam", pm.math.exp(lam_seg[comp_seg] + lam_sd * lam_z), dims="company")

        sig_mu = pm.Normal("sig_mu", np.log(0.05), 0.5)
        sig_sd = pm.HalfNormal("sig_sd", 0.5)
        sig_z = pm.Normal("sig_z", 0, 1, dims="company")
        sigma = pm.Deterministic("sigma", pm.math.exp(sig_mu + sig_sd * sig_z), dims="company")

        f_ext = pm.math.concatenate([f, np.zeros(1)])
        attritional = (lag_lr - lam[c_idx][:, None] * f_ext[lag_qi]) * lag_mask
        level = attritional.sum(axis=1) / lag_n
        mean = (mu[c_idx] * (1 - rho[c_idx]) + rho[c_idx] * level + (beta[c_idx] * X).sum(axis=1)
                + lam[c_idx] * f[q_idx])
        pm.StudentT("lr", nu=5, mu=mean, sigma=sigma[c_idx], observed=y)
        idata = pm.sample(draws=draws, tune=tune, chains=chains, cores=chains, random_seed=seed,
                          target_accept=target_accept, progressbar=False)
    seconds = time.time() - t0
    log.info("loss model: %d obs, %d companies, %d quarters, %.0fs", len(y), len(companies), len(quarters), seconds)
    return LossFit(idata, companies, segments, quarters, comp_seg, seconds)


def draws(fitres: LossFit, n: int, seed: int = 7) -> dict[str, np.ndarray]:
    """n posterior draws (thinned evenly across chains) of every company-level parameter."""
    post = fitres.idata["posterior"]
    stacked = {}
    for name in ("mu", "rho", "beta", "lam", "sigma"):
        arr = post[name].values  # (chain, draw, ...)
        flat = arr.reshape(-1, *arr.shape[2:])
        stacked[name] = flat
    total = stacked["mu"].shape[0]
    rng = np.random.default_rng(seed)
    pick = np.sort(rng.choice(total, size=min(n, total), replace=False))
    return {k: v[pick] for k, v in stacked.items()}


def diagnostics(fitres: LossFit) -> dict:
    import arviz as az

    s = az.summary(fitres.idata, var_names=["mu_seg", "rho_seg", "beta_seg", "sd_beta", "lam_seg", "sig_mu",
                                            "sd_mu", "sd_rho", "lam_sd", "sig_sd", "f",
                                            "mu", "rho", "beta", "lam", "sigma"])
    stats = fitres.idata["sample_stats"]
    divergences = int(stats["diverging"].values.sum())
    return {
        "max_r_hat": float(s["r_hat"].max()),
        "min_ess_bulk": float(s["ess_bulk"].min()),
        "divergences": divergences,
        "parameters_checked": len(s),
        "seconds": round(fitres.seconds, 1),
    }


def common_shock(fitres: LossFit) -> pd.DataFrame:
    f = fitres.idata["posterior"]["f"].values.reshape(-1, len(fitres.quarters))
    return pd.DataFrame({"qend": fitres.quarters, "f_mean": f.mean(0), "f_p10": np.quantile(f, 0.1, 0),
                         "f_p90": np.quantile(f, 0.9, 0)})
