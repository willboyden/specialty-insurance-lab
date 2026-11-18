"""Monte Carlo simulation of each carrier's next eight quarters under a scenario.

This is the reference implementation. dashboard/src/engine.ts runs the same arithmetic in the browser, and
dashboard/tests/engine.test.ts checks the two agree to 1e-9 on a fixture (scripts/make_engine_fixture.py). Both draw their random numbers from
the same tiny generator (mulberry32 + Box-Muller), seeded per (draw, company), so the results match exactly.

Per company i, posterior draw d, quarter h (driver path p = d mod P):
  x      = baseline features[p, h] + severity * scenario feature shock[h]
  f      = baseline industry shock[p, h] + severity * scenario shock[h]
  LR     = mu (1 - rho) + rho * A + beta . x + lam * f + sigma * t5 + overlays
           where A = mean of the last four ATTRITIONAL loss ratios (LR - lam * f): catastrophes do not persist.
           The four observed quarters enter as last_lrs - lam * last_f (last_f = the model's estimate of the
           industry shock in those quarters).
  CR     = LR + expense ratio (company's last-four-quarter average)
  NPE    grows at baseline growth + severity * scenario growth shock
  yield  moves kappa of the way to the 5-year Treasury each quarter (+ the company's own spread term)
  pretax = (1 - CR) NPE + yield * investments / 4 + equity securities x equity return + other income
  NI     = 79% of pretax (21% US federal rate; a simplification for Bermuda groups)
  BV     = BV + NI - dividends + (d_rate * change in 5y yield + d_fin * change in NFCI) * BV
  cap    = cumulative (NI + OCI) / starting equity: capital generated before any distribution, the headline
           balance-sheet measure (distributions are management choices that companies cut in a stress)
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

H = 8
TAX = 0.21
MASK = 0xFFFFFFFF
SEED_BASE = 20261117


def _imul(a: int, b: int) -> int:
    return (a * b) & MASK


class Mulberry32:
    """Bit-exact port of the JavaScript mulberry32 generator."""

    def __init__(self, seed: int):
        self.a = seed & MASK

    def next(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & MASK
        a = self.a
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & MASK) ^ t
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0

    def normal(self) -> float:
        u1 = 1.0 - self.next()
        u2 = self.next()
        return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)

    def student_t5(self) -> float:
        z = self.normal()
        chi2 = sum(self.normal() ** 2 for _ in range(5))
        return z / math.sqrt(chi2 / 5.0)


def stream_seed(draw: int, company_index: int) -> int:
    return (SEED_BASE + draw * 7919 + company_index * 104729) & MASK


@dataclass
class CompanyParams:
    mu: np.ndarray        # (D,)
    rho: np.ndarray       # (D,)
    beta: np.ndarray      # (D, K)
    lam: np.ndarray       # (D,)
    sigma: np.ndarray     # (D,)
    expense_ratio: float
    last_lrs: list[float]
    last_f: list[float]
    npe_q: float
    growth: float
    equity: float
    inv_to_equity: float
    nii_yield: float
    kappa: float
    kappa_c: float
    d_rate: float
    d_fin: float
    eq_sec_to_equity: float
    other_income_q: float
    payout: float
    exposures: dict[str, float]


def simulate_company(ci: int, p: CompanyParams, base: dict, shock: dict, severity: float,
                     overlays_on: bool = True) -> dict[str, np.ndarray]:
    """base: features (K, P, H) z-units, f (P, H), ust5y (P, H), nfci (P, H), equity (P, H), start {ust5y, nfci}
    shock: features (K, H), f (H), ust5y (H), nfci (H), equity (H), growth (H), overlays [{exposure, points}]"""
    D = p.mu.shape[0]
    K = p.beta.shape[1]
    P = base["f"].shape[0]
    out = {k: np.empty((D, H)) for k in ("lr", "cr", "roe", "bvx", "cap", "npe")}
    for d in range(D):
        rng = Mulberry32(stream_seed(d, ci))
        path = d % P
        attr = [lr - p.lam[d] * lf for lr, lf in zip(p.last_lrs[-4:], p.last_f[-4:], strict=True)]
        bv = p.equity
        npe = p.npe_q
        y = p.nii_yield
        r_prev = base["start"]["ust5y"]
        b_prev = base["start"]["nfci"]
        generated = 0.0
        for h in range(H):
            xb = 0.0
            for k in range(K):
                xk = base["features"][k][path][h] + severity * shock["features"][k][h]
                xb += p.beta[d, k] * xk
            f = base["f"][path][h] + severity * shock["f"][h]
            ov = 0.0
            if overlays_on:
                for o in shock["overlays"]:
                    ov += p.exposures.get(o["exposure"], 0.0) * o["points"][h] / 100.0
            eps = p.sigma[d] * rng.student_t5()
            level = sum(attr[-4:]) / len(attr[-4:])
            lr = p.mu[d] * (1 - p.rho[d]) + p.rho[d] * level + xb + p.lam[d] * f + eps + severity * ov
            attr.append(lr - p.lam[d] * f)
            cr = lr + p.expense_ratio
            g = p.growth + severity * shock["growth"][h] / 100.0
            npe = npe * (1.0 + max(g, -0.9)) ** 0.25
            r = base["ust5y"][path][h] + severity * shock["ust5y"][h]
            b = base["nfci"][path][h] + severity * shock["nfci"][h]
            y = y + p.kappa * (r / 100.0 - y) + p.kappa_c
            inv = bv * p.inv_to_equity
            eq_ret = (base["equity"][path][h] + severity * shock["equity"][h]) / 100.0
            pretax = (1.0 - cr) * npe + y * inv / 4.0 + p.eq_sec_to_equity * bv * eq_ret + p.other_income_q
            ni = (1.0 - TAX) * pretax
            oci = (p.d_rate * (r - r_prev) + p.d_fin * (b - b_prev)) * bv
            div = p.payout * max(ni, 0.0)
            roe = 4.0 * ni / bv
            generated += ni + oci
            bv = bv + ni - div + oci
            r_prev, b_prev = r, b
            out["lr"][d, h] = lr
            out["cr"][d, h] = cr
            out["roe"][d, h] = roe
            out["bvx"][d, h] = bv / p.equity
            out["cap"][d, h] = generated / p.equity
            out["npe"][d, h] = npe
    return out


def summarize(sim: dict[str, np.ndarray]) -> dict:
    qs = [0.05, 0.25, 0.5, 0.75, 0.95]
    res = {}
    for k in ("lr", "cr", "roe", "bvx", "cap"):
        res[k] = np.quantile(sim[k], qs, axis=0).round(5).tolist()
    res["p_cr_over_100"] = (sim["cr"] > 1.0).mean(axis=0).round(4).tolist()
    year1 = (sim["cr"][:, :4] * sim["npe"][:, :4]).sum(1) / sim["npe"][:, :4].sum(1)
    year2 = (sim["cr"][:, 4:] * sim["npe"][:, 4:]).sum(1) / sim["npe"][:, 4:].sum(1)
    res["p_year_cr_over_100"] = [round(float((year1 > 1).mean()), 4), round(float((year2 > 1).mean()), 4)]
    res["bv_8q"] = np.quantile(sim["bvx"][:, -1], qs).round(5).tolist()
    res["p_bv_down_10"] = round(float((sim["bvx"][:, -1] < 0.9).mean()), 4)
    res["cap_8q"] = np.quantile(sim["cap"][:, -1], qs).round(5).tolist()
    res["p_cap_negative"] = round(float((sim["cap"][:, -1] < 0).mean()), 4)
    return res
