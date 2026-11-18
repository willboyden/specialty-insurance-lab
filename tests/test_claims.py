"""Claims domain: the XBRL instance reader, the triangle builder and the roll-forward arithmetic (no DB, no network)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from sil.claims import (
    PAID_BOUNDS,
    compose_paid,
    resolve,
    triangle_rows,
    ttm_series,
    year_metrics,
)
from sil.sources import xbrl_instance as xi

# ---------------------------------------------------------------- synthetic instances

EX101_INS = b"""<?xml version="1.0" encoding="utf-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:us-gaap="http://fasb.org/us-gaap/2017-01-31" xmlns:dei="http://xbrl.sec.gov/dei/2014-01-31"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:abc="http://www.abc.com/20171231">
  <xbrli:context id="FY2017_AY2016_Casualty">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier>
      <xbrli:segment>
        <xbrldi:explicitMember dimension="us-gaap:ShortdurationInsuranceContractsAccidentYearAxis">abc:AccidentYear2016Member</xbrldi:explicitMember>
        <xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">abc:CasualtySegmentMember</xbrldi:explicitMember>
      </xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:startDate>2017-01-01</xbrli:startDate><xbrli:endDate>2017-12-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="FY2016_AY2016_Casualty">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier>
      <xbrli:segment>
        <xbrldi:explicitMember dimension="us-gaap:ShortdurationInsuranceContractsAccidentYearAxis">abc:AccidentYear2016Member</xbrldi:explicitMember>
        <xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">abc:CasualtySegmentMember</xbrldi:explicitMember>
      </xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:startDate>2016-01-01</xbrli:startDate><xbrli:endDate>2016-12-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="FY2017_AY2017_Casualty">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier>
      <xbrli:segment>
        <xbrldi:explicitMember dimension="us-gaap:ShortdurationInsuranceContractsAccidentYearAxis">abc:AccidentYear2017Member</xbrldi:explicitMember>
        <xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">abc:CasualtySegmentMember</xbrldi:explicitMember>
      </xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:instant>2017-12-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="FY2017_Casualty">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier>
      <xbrli:segment>
        <xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">abc:CasualtySegmentMember</xbrldi:explicitMember>
      </xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:startDate>2017-01-01</xbrli:startDate><xbrli:endDate>2017-12-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="FY2017">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2017-01-01</xbrli:startDate><xbrli:endDate>2017-12-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  <xbrli:unit id="claim"><xbrli:measure>abc:Claim</xbrli:measure></xbrli:unit>
  <xbrli:unit id="pure"><xbrli:measure>xbrli:pure</xbrli:measure></xbrli:unit>
  <us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet contextRef="FY2016_AY2016_Casualty" unitRef="usd" decimals="-3">100000000</us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet>
  <us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet contextRef="FY2017_AY2016_Casualty" unitRef="usd" decimals="-3">108000000</us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet>
  <us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet contextRef="FY2017_AY2016_Casualty" unitRef="usd" decimals="-3">108000000</us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet>
  <us-gaap:ShortdurationInsuranceContractsCumulativePaidClaimsAndAllocatedClaimAdjustmentExpenseNet contextRef="FY2017_AY2016_Casualty" unitRef="usd" decimals="-3">40000000</us-gaap:ShortdurationInsuranceContractsCumulativePaidClaimsAndAllocatedClaimAdjustmentExpenseNet>
  <us-gaap:ShortdurationInsuranceContractsIncurredButNotReportedIBNRClaimsLiabilityPlusExpectedDevelopmentOnReportedClaims contextRef="FY2017_AY2017_Casualty" unitRef="usd" decimals="-3">30000000</us-gaap:ShortdurationInsuranceContractsIncurredButNotReportedIBNRClaimsLiabilityPlusExpectedDevelopmentOnReportedClaims>
  <us-gaap:ShortdurationInsuranceContractsCumulativeNumberOfReportedClaims contextRef="FY2017_AY2017_Casualty" unitRef="claim" decimals="INF">1250</us-gaap:ShortdurationInsuranceContractsCumulativeNumberOfReportedClaims>
  <us-gaap:ShortdurationInsuranceContractsHistoricalClaimsDurationYear1 contextRef="FY2017_Casualty" unitRef="pure" decimals="3">0.125</us-gaap:ShortdurationInsuranceContractsHistoricalClaimsDurationYear1>
  <us-gaap:ShortdurationInsuranceContractsHistoricalClaimsDurationYear2 contextRef="FY2017_Casualty" unitRef="pure" decimals="1">21.5</us-gaap:ShortdurationInsuranceContractsHistoricalClaimsDurationYear2>
  <us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet contextRef="FY2017_Casualty" unitRef="usd" xsi:nil="true"/>
  <us-gaap:PremiumsEarnedNet contextRef="FY2017" unitRef="usd" decimals="-3">500000000</us-gaap:PremiumsEarnedNet>
  <abc:ShortdurationCustomTotal contextRef="FY2017" unitRef="usd" decimals="-3">1</abc:ShortdurationCustomTotal>
  <dei:DocumentType contextRef="FY2017">10-K</dei:DocumentType>
</xbrli:xbrl>
"""

# the instance SEC extracts from an inline-XBRL 10-K (<name>_htm.xml): default namespace for xbrli, a typed
# accident-year dimension, a newer us-gaap namespace and ids on facts
HTM_XML = b"""<?xml version="1.0" encoding="utf-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:us-gaap="http://fasb.org/us-gaap/2024" xmlns:xyz="http://www.xyz.com/20241231"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217">
  <context id="c-1">
    <entity><identifier scheme="http://www.sec.gov/CIK">0000000002</identifier>
      <segment>
        <xbrldi:typedMember dimension="xyz:AccidentYearAxis"><xyz:AccidentYearDomain>2022</xyz:AccidentYearDomain></xbrldi:typedMember>
        <xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">xyz:WorkersCompensationInsuranceMember</xbrldi:explicitMember>
      </segment></entity>
    <period><startDate>2024-01-01</startDate><endDate>2024-12-31</endDate></period>
  </context>
  <context id="c-2">
    <entity><identifier scheme="http://www.sec.gov/CIK">0000000002</identifier>
      <segment>
        <xbrldi:explicitMember dimension="xyz:ShortDurationAccidentYearAxis">xyz:AccidentYearsPriorTo2015Member</xbrldi:explicitMember>
      </segment></entity>
    <period><startDate>2024-01-01</startDate><endDate>2024-12-31</endDate></period>
  </context>
  <unit id="u-1"><measure>iso4217:USD</measure></unit>
  <us-gaap:ShortdurationInsuranceContractsClaimsDevelopmentIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet id="f-1" contextRef="c-1" unitRef="u-1" decimals="-5">2,500,000</us-gaap:ShortdurationInsuranceContractsClaimsDevelopmentIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet>
  <us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet id="f-2" contextRef="c-2" unitRef="u-1" decimals="-5">900000</us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet>
  <us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet id="f-3" contextRef="missing" unitRef="u-1" decimals="-5">1</us-gaap:ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet>
</xbrl>
"""


def test_parse_ex101_instance_keeps_only_requested_us_gaap_facts():
    facts = xi.parse_instance(EX101_INS, xi.is_claims_element)
    names = sorted({f.element for f in facts})
    assert "PremiumsEarnedNet" not in names  # not requested
    assert "ShortdurationCustomTotal" not in names  # company extension, not us-gaap
    incurred = [f for f in facts if f.element.endswith("IncurredClaimsAndAllocatedClaimAdjustmentExpenseNet")]
    # the repeated fact is kept once; the nil fact has no value
    assert sorted(f.value for f in incurred if f.value is not None) == [100_000_000.0, 108_000_000.0]
    assert any(f.value is None for f in incurred)
    f = next(f for f in incurred if f.value == 108_000_000.0)
    assert f.unit == "USD" and f.decimals == "-3"
    assert f.context.end.isoformat() == "2017-12-31" and f.context.start.isoformat() == "2017-01-01"
    assert f.context.dims == {"ShortdurationInsuranceContractsAccidentYearAxis": "AccidentYear2016Member",
                              "StatementBusinessSegmentsAxis": "CasualtySegmentMember"}
    ibnr = next(f for f in facts if "IncurredButNotReported" in f.element)
    assert ibnr.context.start is None and ibnr.context.end.isoformat() == "2017-12-31"


def test_parse_extracted_inline_instance_with_typed_dimension_and_commas():
    facts = xi.parse_instance(HTM_XML, xi.is_claims_element)
    assert len(facts) == 2  # the fact with an unknown context is dropped
    f = next(f for f in facts if f.context.dims.get("AccidentYearAxis") == "2022")
    assert f.value == 2_500_000.0 and f.unit == "USD"
    assert xi.accident_year(f.context.dims) == (2022, "AccidentYearAxis")
    assert xi.line_name(f.context.dims, "AccidentYearAxis") == "Workers Compensation Insurance"
    prior = next(f for f in facts if "ShortDurationAccidentYearAxis" in f.context.dims)
    # 'accident years prior to 2015' is an aggregate column, not accident year 2015
    assert xi.accident_year(prior.context.dims) == (None, "ShortDurationAccidentYearAxis")
    assert xi.accident_year({"AccidentYearAxis": "AccidentYear2015AndPriorMember"}) == (None, "AccidentYearAxis")


@pytest.mark.parametrize(("name", "expected"), [
    ("ShortdurationInsuranceContractsIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet", ("incurred", None)),
    ("ShortdurationInsuranceContractsClaimsDevelopmentIncurredClaimsAndAllocatedClaimAdjustmentExpenseNet", ("incurred", None)),
    ("ShortdurationInsuranceContractsCumulativePaidClaimsAndAllocatedClaimAdjustmentExpenseNet", ("paid", None)),
    ("ShortdurationInsuranceContractsIncurredButNotReportedIBNRClaimsLiabilityPlusExpectedDevelopmentOnReportedClaims", ("ibnr", None)),
    ("ShortdurationInsuranceContractsCumulativeNumberOfReportedClaims", ("claims", None)),
    ("ShortDurationInsuranceContractsHistoricalClaimsDurationYear7", ("payout", 7)),
    ("ShortdurationInsuranceContractsLiabilityForUnpaidClaimsAndAllocatedClaimAdjustmentExpenseNet", ("liability", None)),
    ("ShortdurationInsuranceContractsLiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseAccumulatedUnallocatedClaimAdjustmentExpense", None),
    ("ShortdurationInsuranceContractsLiabilityForUnpaidClaimsAndClaimAdjustmentExpenseOtherReconcilingItem", None),
])
def test_classify(name, expected):
    assert xi.classify(name) == expected


def test_accident_year_needs_a_year_axis_and_a_single_year():
    assert xi.accident_year({"StatementBusinessSegmentsAxis": "Casualty2016Member"}) == (None, None)
    assert xi.accident_year({"UnderwritingYearAxis": "UnderwritingYear2019Member"}) == (2019, "UnderwritingYearAxis")
    assert xi.accident_year({"AccidentYearAxis": "AllPriorYearsMember"}) == (None, "AccidentYearAxis")


def test_line_name_splits_camel_case_and_drops_generic_words():
    assert xi.line_name({"AccidentYearAxis": "AY2018Member", "StatementBusinessSegmentsAxis": "ExcessAndSurplusLinesSegmentMember"},
                        "AccidentYearAxis") == "Excess And Surplus Lines"
    assert xi.line_name({"AccidentYearAxis": "AY2018Member"}, "AccidentYearAxis") == "All lines"


def test_triangle_rows_from_parsed_facts():
    facts = xi.parse_instance(EX101_INS, xi.is_claims_element)
    df = pd.DataFrame([{"cik": 1, "fy_filed": 2017, "accession": "0000000001-18-000001", "element": f.element,
                        "value": f.value, "period_end": f.context.end, "dims": f.context.dims} for f in facts])
    tri, ay, payout = triangle_rows(df)
    cells = {(t[4], t[5], t[6]): t[7] for t in tri}  # (accident year, evaluation year, metric) -> value
    assert cells == {(2016, 2016, "incurred"): 100e6, (2016, 2017, "incurred"): 108e6, (2016, 2017, "paid"): 40e6}
    assert all(t[3] == "Casualty" for t in tri)
    rows = {(a[3]): a for a in ay}
    assert rows[2016][4:7] == (100e6, 108e6, 40e6)  # first incurred, latest incurred, latest paid
    assert rows[2017][7:9] == (30e6, 1250.0)  # IBNR and reported claims of the newest accident year
    # payout percentages: a fraction stays a fraction, a percent (21.5) becomes 0.215
    assert sorted((p[3], p[4]) for p in payout) == [(1, 0.125), (2, 0.215)]


# ---------------------------------------------------------------- roll-forward arithmetic

def test_compose_paid_cases():
    w = pd.DataFrame({
        "paid_cy": [10.0, 10.0, np.nan, 30.0, np.nan],
        "paid_py": [20.0, np.nan, np.nan, np.nan, np.nan],
        "paid_total": [99.0, 25.0, 40.0, 20.0, np.nan],
    })
    out = compose_paid(w)
    assert out["paid"].tolist()[:4] == [30.0, 25.0, 40.0, 20.0] and np.isnan(out["paid"].iloc[4])
    assert out["paid_basis"].tolist() == ["cy+py", "total-cy", "total", "total", "none"]
    assert out["paid_py"].iloc[1] == 15.0  # derived: total - current year
    assert np.isnan(out["paid_py"].iloc[3])  # total below the current-year part: nothing derived


def test_resolve_prefers_priority_flips_signs_and_drops_implausible():
    t = pd.Timestamp("2024-12-31")
    cands = pd.DataFrame([
        (1, t, "paid_total", "A", 1, 9000.0),   # 90x premium: dropped
        (1, t, "paid_total", "B", 2, -60.0),    # negative but plausible when flipped
        (2, t, "paid_cy", "C", 1, 50.0),
        (2, t, "paid_cy", "D", 2, 40.0),
    ], columns=["cik", "period", "concept", "tag", "priority", "value"])
    base = pd.Series([100.0, 100.0], index=pd.MultiIndex.from_tuples([(1, t), (2, t)], names=["cik", "period"]))
    out = resolve(cands, base, PAID_BOUNDS).set_index(["cik", "concept"])
    assert out.loc[(1, "paid_total"), "value"] == 60.0 and out.loc[(1, "paid_total"), "flag"] == "sign flipped"
    assert out.loc[(2, "paid_cy"), "tag"] == "C"


def test_year_metrics_definitions_and_bounds():
    y = pd.DataFrame([{
        "npe": 1000.0, "losses": 600.0, "cy_losses": 650.0, "py_development": -50.0, "paid_cy": 130.0, "paid_py": 270.0,
        "paid": 400.0, "acquired": 0.0, "fx": 0.0, "net_reserves": 2200.0, "net_reserves_open": 2000.0,
        "gross_reserves": 3000.0, "recoverable_unpaid": np.nan, "ibnr": 900.0, "case_reserves": 600.0, "equity": 1100.0,
    }])
    m = year_metrics(y).iloc[0]
    assert m["paid_lr"] == pytest.approx(0.4)
    assert m["incurred_lr"] == pytest.approx(0.6)
    assert m["paid_to_incurred"] == pytest.approx(400 / 600)
    assert m["first_year_payout"] == pytest.approx(0.2)
    assert m["runoff_speed"] == pytest.approx(270 / 2000)
    assert m["survival"] == pytest.approx(5.5)
    assert m["reserve_leverage"] == pytest.approx(2.0)
    assert m["dev_pct_open"] == pytest.approx(-0.025)
    assert m["ceded_share"] == pytest.approx(1 - 2200 / 3000)  # no recoverable tagged: 1 - net / gross
    assert m["ibnr_share"] == pytest.approx(0.6)
    assert m["reserve_growth"] == pytest.approx(0.1)
    # 2000 + 650 - 50 - 400 = 2200: the roll-forward closes
    assert m["rollforward_gap"] == pytest.approx(0.0)
    bad = year_metrics(y.assign(paid=0.0001, equity=1.0))  # survival and leverage far out of bounds
    assert np.isnan(bad["survival"].iloc[0]) and np.isnan(bad["reserve_leverage"].iloc[0])


def test_ttm_series_needs_four_consecutive_quarters():
    q = pd.DataFrame({
        "cik": [1] * 6,
        "qend": pd.to_datetime(["2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31", "2024-06-30", "2024-09-30"]),
        "paid": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
    })
    s = ttm_series(q, "paid")
    assert s.iloc[3] == 10.0
    assert s.iloc[:3].isna().all() and s.iloc[4:].isna().all()  # 2024Q1 missing: no trailing sum across the gap
