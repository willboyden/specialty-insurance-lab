"""Unit tests that need no database or network: parsing, tag resolution, trailing sums, shrinkage, the RNG."""

from __future__ import annotations

import math
from datetime import date

import numpy as np
import pandas as pd
import pytest

from sil.model.investment import _shrink
from sil.model.simulate import Mulberry32, stream_seed
from sil.sources.noaa import parse_damage
from sil.standardize import _ttm, resolve


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("10.00K", 10_000.0), ("2.5M", 2_500_000.0), ("1B", 1e9), ("0.00K", 0.0), ("K", 0.0), ("", 0.0),
     ("500", 500.0), ("1.5m", 1_500_000.0), ("garbage", 0.0), ("3H", 300.0)],
)
def test_parse_damage(raw, expected):
    assert parse_damage(raw) == pytest.approx(expected)


def _cands(rows):
    return pd.DataFrame(rows, columns=["cik", "qend", "concept", "tag", "priority", "value", "derivation"])


def test_resolve_prefers_priority_then_falls_back_when_implausible():
    q = date(2025, 3, 31)
    npe = pd.Series({(1, q): 100.0, (2, q): 100.0})
    df = _cands([
        # company 1: the primary tag is a sub-segment (5% of premium): rejected, the fallback wins
        (1, q, "losses", "PolicyholderBenefitsAndClaimsIncurredNet", 1, 5.0, "reported 3-month"),
        (1, q, "losses", "IncurredClaimsPropertyCasualtyAndLiability", 2, 61.0, "reported 3-month"),
        # company 2: the primary tag is plausible and wins over the fallback
        (2, q, "losses", "PolicyholderBenefitsAndClaimsIncurredNet", 1, 58.0, "reported 3-month"),
        (2, q, "losses", "IncurredClaimsPropertyCasualtyAndLiability", 2, 70.0, "reported 3-month"),
    ])
    out = resolve(df, npe).set_index("cik")
    assert out.loc[1, "value"] == 61.0 and out.loc[1, "tag"] == "IncurredClaimsPropertyCasualtyAndLiability"
    assert out.loc[2, "value"] == 58.0


def test_resolve_flips_a_negative_acquisition_cost():
    q = date(2025, 3, 31)
    npe = pd.Series({(7, q): 200.0})
    out = resolve(_cands([(7, q, "acq_cost", "DeferredPolicyAcquisitionCostAmortizationExpense", 1, -34.0, "x")]), npe)
    assert out.loc[0, "value"] == 34.0 and out.loc[0, "flag"] == "sign flipped"


def test_resolve_drops_values_without_premium():
    q = date(2025, 3, 31)
    empty = pd.Series(dtype=float, index=pd.MultiIndex.from_tuples([], names=["cik", "qend"]))
    out = resolve(_cands([(3, q, "losses", "PolicyholderBenefitsAndClaimsIncurredNet", 1, 50.0, "x")]), empty)
    assert out.empty


def test_ttm_needs_four_consecutive_quarters():
    g = pd.DataFrame({
        "qend": pd.to_datetime(["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-06-30", "2025-09-30"]),
        "x": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
    })
    t = _ttm(g, "x")
    assert math.isnan(t.iloc[2])
    assert t.iloc[3] == 10.0  # Q1-Q4 2024
    assert math.isnan(t.iloc[4])  # 2025 Q1 missing: the window is not consecutive
    assert math.isnan(t.iloc[5])


def test_shrink_pulls_noisy_estimates_harder():
    est = pd.Series([0.10, 0.12, 0.30])
    se = pd.Series([0.01, 0.01, 0.20])
    out = _shrink(est, se)
    # the precise estimates barely move; the noisy outlier moves most of the way to the median
    assert abs(out[0] - 0.10) < 0.02 and abs(out[1] - 0.12) < 0.02
    assert abs(out[2] - 0.12) < abs(0.30 - 0.12) * 0.5


def test_mulberry32_matches_javascript():
    # reference values printed by the JavaScript implementation (node) for the same seeds
    r = Mulberry32(20261117)
    js = [0.876015507383272, 0.0866415249183774, 0.9978529647924006, 0.0065161436796188354,
          0.19620617339387536, 0.1556000537239015]
    assert [r.next() for _ in range(6)] == js
    r2 = Mulberry32(4294967295)
    assert [r2.next(), r2.next()] == [0.8964226141106337, 0.189478256739676]


def test_student_t_draws_have_heavier_tails_than_normal():
    r = Mulberry32(stream_seed(3, 5))
    draws = np.array([r.student_t5() for _ in range(20000)])
    assert abs(draws.mean()) < 0.05
    assert 1.15 < draws.std() < 1.45  # sd of t(5) = sqrt(5/3) = 1.29
    assert (np.abs(draws) > 3).mean() > 0.01  # normal: 0.0027


def test_stream_seed_is_32_bit_and_distinct():
    seeds = {stream_seed(d, i) for d in range(160) for i in range(60)}
    assert len(seeds) == 160 * 60
    assert all(0 <= s < 2**32 for s in seeds)


def test_restricted_index_data_is_never_collected_or_published():
    from sil.drivers import DRIVERS
    from sil.export import PUBLIC_DRIVERS
    from sil.sources.fred import RESTRICTED, SERIES

    assert not (RESTRICTED & set(SERIES)), "restricted index series must not be downloaded"
    assert PUBLIC_DRIVERS <= set(DRIVERS), "every published driver must be a defined driver"
    banned = ("ndx", "vix", "sp500", "baa", "hy_oas", "ig_oas", "nasdaq")
    assert not [d for d in PUBLIC_DRIVERS if d.startswith(banned)]
    assert not [d for d in DRIVERS if d.startswith(banned)]
