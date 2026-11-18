"""Baseline driver paths and stress scenarios for the next eight quarters.

Baseline: each underlying series follows an AR(1) fitted on quarterly data from 2000 (rates follow a random
walk; equity returns are drawn around their historical mean). The industry shock f is drawn from the model's
own estimates of f for the same quarter of the year (2010 onward), which keeps the hurricane season and the
skew of catastrophe losses. Every path starts from the last complete quarter.

Scenarios are SHOCKS added to the baseline, written in natural units (percentage points, log points, standard
deviations of the industry shock) for severity 1. The severity setting in the dashboard scales them linearly.
Where the 2010-2026 data cannot identify a channel, the scenario carries an explicit loss-ratio OVERLAY,
weighted by each company's exposure; overlays are assumptions and the dashboard can switch them off.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .features import FEATURES

H = 8  # quarters ahead
EQUITY_MEAN_Q = 2.0  # % per quarter, baseline equity return (assumption)
EQUITY_SD_Q = 8.0  # % per quarter (assumption)


@dataclass
class Scenario:
    key: str
    name: str
    story: str
    # natural-unit shock paths, length H
    legal_ppi_yoy: list[float] = field(default_factory=lambda: [0.0] * H)   # pp
    log_gpr: list[float] = field(default_factory=lambda: [0.0] * H)         # log points
    nfci: list[float] = field(default_factory=lambda: [0.0] * H)            # NFCI points (sd 1 since 1971; 0.16 in 2010-26)
    ust5y: list[float] = field(default_factory=lambda: [0.0] * H)           # pp, level shift
    equity_ret: list[float] = field(default_factory=lambda: [0.0] * H)      # % per quarter, added
    growth: list[float] = field(default_factory=lambda: [0.0] * H)          # pp of annual premium growth
    f_by_quarter: dict[int, float] = field(default_factory=dict)            # industry shock (sd) by quarter of year
    overlays: list[dict] = field(default_factory=list)


SCENARIOS: list[Scenario] = [
    Scenario(
        "ai_unwind", "AI equity unwind",
        "The AI investment boom reverses: tech-led equities fall, credit spreads widen, the economy slows and "
        "the Fed cuts. Insurers lose on equity holdings and book lower reinvestment yields; slower payrolls and "
        "revenues shrink exposure growth; securities, D&O and cyber claims follow with a lag. Read the loss-ratio "
        "effect as indicative: the loading on financial stress is pooled within segments and identified mostly "
        "by the 2020 shock.",
        # NFCI peaks +0.45 at severity 1: the size of the 2020 rise (quarterly average -0.54 -> -0.08);
        # severity 2 is +0.9, still well short of 2008 (+2.8). The 2001-02 dot-com bust barely moved the NFCI.
        nfci=[0.2, 0.4, 0.45, 0.35, 0.25, 0.15, 0.1, 0.05],
        ust5y=[-0.5, -0.9, -1.1, -1.2, -1.2, -1.1, -1.0, -0.9],
        equity_ret=[-16, -12, -8, -4, 0, 1, 1, 1],
        growth=[-2, -4, -6, -6, -5, -4, -3, -2],
        overlays=[{
            "key": "professional_lines", "label": "Professional-lines claims after a market bust (D&O, E&O, cyber)",
            "exposure": "prof_exposure", "points": [0, 0, 0.5, 1.0, 2.0, 2.5, 3.0, 3.0],
            "basis": "Assumption: securities-related claims surface 1-2 years after a market collapse. Weighted "
                     "by how often a company's recent 10-K/10-Q filings discuss D&O and cyber.",
        }],
    ),
    Scenario(
        "geo_escalation", "Geopolitical escalation",
        "A major conflict widens: the geopolitical risk index jumps ~70%, energy prices spike, rates "
        "and spreads rise and equities sell off. Political-risk, war, trade-credit and specialty marine and "
        "aviation books take event losses. Most of the underwriting hit comes from the labeled overlay, an "
        "assumption: past geopolitical spikes barely moved consolidated loss ratios.",
        log_gpr=[0.55, 0.45, 0.30, 0.20, 0.10, 0.05, 0, 0],
        nfci=[0.1, 0.15, 0.2, 0.15, 0.1, 0.05, 0, 0],
        ust5y=[0.2, 0.4, 0.5, 0.5, 0.4, 0.3, 0.2, 0.2],
        equity_ret=[-8, -5, -2, 0, 1, 1, 0, 0],
        growth=[0, -1, -2, -2, -1, 0, 0, 0],
        overlays=[{
            "key": "conflict_losses", "label": "Event losses on political-risk, war and trade-credit books",
            "exposure": "geo_exposure", "points": [4.0, 2.0, 1.0, 0.5, 0, 0, 0, 0],
            "basis": "Assumption sized like the 2022 war-related charges at specialty carriers. Weighted by how "
                     "often a company's recent filings discuss political risk, war and trade credit.",
        }],
    ),
    Scenario(
        "climate", "Climate-driven catastrophe years",
        "Two heavy catastrophe years in a row: an active hurricane season each third quarter and more secondary "
        "perils (convective storms, wildfire, flood) in the others. Property rates harden and E&S property grows.",
        growth=[1, 2, 3, 3, 3, 3, 2, 2],
        f_by_quarter={1: 0.6, 2: 0.6, 3: 2.0, 4: 0.8},
    ),
    Scenario(
        "social_inflation", "Social-inflation surge",
        "Litigation costs accelerate (larger verdicts, litigation funding, attorney involvement). Casualty loss "
        "trends outrun the assumptions behind existing reserves, so carriers strengthen prior-year reserves. The "
        "estimated litigation-cost channel is small; the reserve-strengthening overlay, an assumption scaled by "
        "each carrier's reserves, carries most of the hit.",
        # litigation-cost inflation 3 points above its path: above anything in 2010-2026 (a surge, by design)
        legal_ppi_yoy=[1, 2, 3, 3, 3, 3, 3, 3],
        overlays=[{
            "key": "reserve_strengthening", "label": "Prior-year reserve strengthening (4% of net reserves)",
            "exposure": "reserve_charge", "points": [0, 0, 1, 1, 1, 1, 1, 1],
            "basis": "Assumption: 4% of net loss reserves is added over quarters 3-8. In loss-ratio points that is "
                     "0.04 x reserves / (6 x quarterly premium), so long-tail carriers with more reserves per "
                     "dollar of premium take bigger hits.",
        }],
    ),
]


def polycrisis() -> Scenario:
    s = Scenario("polycrisis", "Everything at once",
                 "All four stresses together: an equity unwind, a geopolitical shock, heavy catastrophe years and a "
                 "social-inflation surge. Shocks add up; it is a tail scenario, not a forecast.")
    for part in SCENARIOS:
        for name in ("legal_ppi_yoy", "log_gpr", "nfci", "ust5y", "equity_ret", "growth"):
            setattr(s, name, [a + b for a, b in zip(getattr(s, name), getattr(part, name))])
        for q, v in part.f_by_quarter.items():
            s.f_by_quarter[q] = s.f_by_quarter.get(q, 0.0) + v
        s.overlays.extend(part.overlays)
    return s


def all_scenarios() -> list[Scenario]:
    return [*SCENARIOS, polycrisis()]


# ---------------------------------------------------------------- baseline paths
def _ar1(x: pd.Series) -> tuple[float, float, float]:
    x = x.dropna()
    y, xl = x.iloc[1:].to_numpy(), x.iloc[:-1].to_numpy()
    A = np.column_stack([np.ones_like(xl), xl])
    (c, phi), *_ = np.linalg.lstsq(A, y, rcond=None)
    phi = float(np.clip(phi, -0.98, 0.98))
    resid = y - (c + phi * xl)
    return float(c), phi, float(resid.std(ddof=2))


def baseline_paths(m: pd.DataFrame, end: pd.Timestamp, f_hist: pd.Series, n: int, seed: int = 11,
                   feat_mean: pd.Series | None = None, feat_sd: pd.Series | None = None) -> dict:
    """Simulate n baseline paths of the underlying series and derive the model features (z units).

    m       core.macro_quarter indexed by qend; history used up to `end` only
    f_hist  posterior-mean industry shock by quarter (index qend), 2010 onward, up to `end`
    """
    rng = np.random.default_rng(seed)
    hist = m.loc[m.index <= end]
    start = pd.Timestamp("2000-03-31")
    qtrs = pd.date_range(end + pd.offsets.QuarterEnd(1), periods=H, freq="QE").normalize()

    def sim_ar1(series: pd.Series) -> np.ndarray:
        c, phi, sd = _ar1(series.loc[series.index >= start])
        out = np.empty((n, H))
        prev = np.full(n, series.dropna().iloc[-1])
        for h in range(H):
            prev = c + phi * prev + rng.normal(0, sd, n)
            out[:, h] = prev
        return out

    legal = sim_ar1(hist["legal_ppi_yoy"])
    lgpr = sim_ar1(np.log(hist["gpr"]))
    nfci = sim_ar1(hist["nfci"])
    d5 = hist["ust5y_end"].diff().loc[lambda s: s.index >= pd.Timestamp("2010-03-31")].dropna()
    ust5y = hist["ust5y_end"].dropna().iloc[-1] + np.cumsum(rng.normal(0, d5.std(), (n, H)), axis=1)
    # equity returns: a long-run ASSUMPTION (2% a quarter, about 8% a year; 8% quarterly volatility, about 16% a
    # year), not fitted to the last decade's unusually strong market (and no index data is needed)
    equity = rng.normal(EQUITY_MEAN_Q, EQUITY_SD_Q, (n, H))

    # industry shock: resample the model's own f for the same quarter of the year
    fh = f_hist.loc[f_hist.index <= end].dropna()
    f = np.empty((n, H))
    for h, q in enumerate(qtrs):
        pool = fh[fh.index.quarter == q.quarter].to_numpy()
        f[:, h] = rng.choice(pool, size=n)

    feats = features_from_underlying(hist, legal, lgpr, nfci)
    if feat_mean is not None:
        for k in FEATURES:
            feats[k] = (feats[k] - feat_mean[k]) / feat_sd[k]
    return {"quarters": qtrs, "features": feats, "ust5y": ust5y, "nfci": nfci, "equity": equity, "f": f,
            "start": {"ust5y": float(hist["ust5y_end"].dropna().iloc[-1]),
                      "nfci": float(hist["nfci"].dropna().iloc[-1])}}


def features_from_underlying(hist: pd.DataFrame, legal: np.ndarray, lgpr: np.ndarray,
                             nfci: np.ndarray) -> dict[str, np.ndarray]:
    """The same transformations as features.raw_features, applied to history + simulated future quarters."""
    n = legal.shape[0]

    def roll_mean(past: pd.Series, fut: np.ndarray, window: int) -> np.ndarray:
        p = past.dropna().to_numpy()[-(window - 1):]
        full = np.concatenate([np.tile(p, (n, 1)), fut], axis=1)
        return np.stack([full[:, h:h + window].mean(axis=1) for h in range(H)], axis=1)

    social = roll_mean(hist["legal_ppi_yoy"], legal, 4)
    lg_past = np.log(hist["gpr"].dropna()).to_numpy()[-8:]
    full = np.concatenate([np.tile(lg_past, (n, 1)), lgpr], axis=1)
    geo = np.stack([full[:, 8 + h] - full[:, h:8 + h].mean(axis=1) for h in range(H)], axis=1)
    return {"social": social, "geo": geo, "finstress": nfci.copy()}


def shock_features(s: Scenario, feat_sd: pd.Series) -> dict[str, list[float]]:
    """Feature-level shock paths (z units) implied by a scenario's natural-unit shocks.

    The transformations are linear, so a shock applied with zero history gives the feature shock exactly.
    """
    def roll(x: list[float], w: int) -> list[float]:
        full = [0.0] * (w - 1) + list(x)
        return [sum(full[h:h + w]) / w for h in range(H)]

    lg = [0.0] * 8 + list(s.log_gpr)
    geo = [lg[8 + h] - sum(lg[h:8 + h]) / 8 for h in range(H)]
    return {
        "social": [v / feat_sd["social"] for v in roll(s.legal_ppi_yoy, 4)],
        "geo": [v / feat_sd["geo"] for v in geo],
        "finstress": [v / feat_sd["finstress"] for v in s.nfci],
    }


def f_shock(s: Scenario, quarters: pd.DatetimeIndex) -> list[float]:
    return [float(s.f_by_quarter.get(q.quarter, 0.0)) for q in quarters]
