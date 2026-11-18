"""Unit tests for the catastrophe domain: peril parsers, the US-landfall rule, aggregation, the reported
catastrophe-loss extractor and the shock regression. Offline: synthetic inputs only."""

from datetime import date, datetime

import numpy as np
import pandas as pd
import pytest

from sil.catastrophe import loyo_r2, ols, regressors
from sil.sources import cat_losses as cl
from sil.sources import perils as P

HURDAT = """AL092017,             HARVEY,      4,
20170825, 1800,  , HU, 27.0N,  96.0W, 110,  941,
20170826, 0300, L, HU, 28.0N,  97.0W, 115,  937,
20170826, 0600,  , HU, 28.2N,  97.1W, 105,  948,
20170901, 0000,  , EX, 36.0N,  85.0W,  20, 1004,
AL122017,              OTHER,      2,
20170901, 0000,  , TS, 25.0N,  50.0W,  40, 1000,
20170901, 0300, L, HU, 22.0N,  80.0W,  70,  990,
"""


def test_parse_hurdat_and_coordinates():
    rows = P.parse_hurdat(HURDAT)
    assert len(rows) == 6
    sid, name, season, t, rec, status, lat, lon, wind, pres = rows[1]
    assert (sid, name, season, rec, status) == ("AL092017", "HARVEY", 2017, "L", "HU")
    assert t == datetime(2017, 8, 26, 3, 0)
    assert (lat, lon, wind, pres) == (28.0, -97.0, 115, 937)


@pytest.mark.parametrize(("wind", "cat"), [(None, 0), (63, 0), (64, 1), (82, 1), (83, 2), (96, 3), (113, 4),
                                           (136, 4), (137, 5)])
def test_saffir_simpson(wind, cat):
    assert P.saffir_simpson(wind) == cat


@pytest.mark.parametrize(("lat", "lon", "us"), [
    (28.0, -97.0, True),    # Harvey, Rockport TX
    (24.7, -81.5, True),    # Irma, Florida Keys
    (18.0, -65.9, True),    # Maria, Puerto Rico
    (29.3, -89.6, True),    # Katrina, Louisiana
    (39.4, -74.4, True),    # Sandy, New Jersey
    (43.8, -69.8, True),    # Maine
    (25.97, -97.15, True),  # Brownsville, TX
    (22.0, -80.0, False),   # Cuba
    (26.5, -77.0, False),   # Bahamas
    (24.0, -97.7, False),   # Tamaulipas, Mexico
    (44.5, -63.5, False),   # Nova Scotia
    (32.3, -64.8, False),   # Bermuda
])
def test_us_landfall_boxes(lat, lon, us):
    assert (P.us_landfall_state(lat, lon) is not None) is us


def test_season_stats_ace_and_landfalls():
    stats = P.season_stats(P.parse_hurdat(HURDAT))
    # ACE: synoptic 6-hourly points only, TS/HU/SS at >= 35 kt: 1800 (110) and 0600 (105) for Harvey, 0000 (40)
    assert stats["ace"][2017] == pytest.approx((110**2 + 105**2 + 40**2) / 1e4)
    assert stats["named"][2017] == 2
    assert stats["hurricanes"][2017] == 2
    us = stats["us_landfalls"]
    assert set(us) == {"AL092017"}  # the Cuba landfall is not a US landfall
    assert us["AL092017"]["category"] == 4


def test_hurdat_file_picks_latest_season_and_revision():
    listing = ('<a href="hurdat2-1851-2024-040425.txt"></a><a href="hurdat2-1851-2025-02272026.txt"></a>'
               '<a href="hurdat2-1851-2025-092326.txt"></a><a href="hurdat2-nepac-1949-2025-092926.txt"></a>')
    assert P.hurdat_file(listing) == "hurdat2-1851-2025-092326.txt"


def test_spc_loss_scale_unit_changes():
    scale = P.spc_loss_scale({1995: [8.0, 3.0], 2001: [0.05, 305.0], 2010: [10_000.0, 386_035_000.0], 2015: []})
    assert scale == {1995: None, 2001: 1e6, 2010: 1.0, 2015: 1.0}


def test_aggregate_spc_significance():
    head = "om,yr,mo,dy,date,time,tz,st,stf,stn,mag,inj,fat,loss,closs\n"
    rows = ("1,2010,5,1,2010-05-01,1,3,OK,40,0,2.75,1,0,0,0\n"
            "2,2010,5,2,2010-05-02,1,3,OK,40,0,1.00,0,0,0,0\n"
            "3,2010,5,3,2010-05-03,1,3,KS,20,0,2.00,0,1,5000,0\n")
    out = {(r[1], r[2]): r for r in P.aggregate_spc(head + rows, "hail")}
    ok = out[("OK", "hail")]
    assert ok[3:7] == (2, 1, 1, 0)        # reports, significant (>= 2 in), injuries, fatalities
    assert out[("KS", "hail")][4] == 1     # exactly 2.00 inches counts as significant
    assert out[("KS", "hail")][7] == 5000  # 2010 losses are dollars


@pytest.mark.parametrize(("place", "state"), [
    ("10 km NE of Ridgecrest, CA", "CA"),
    ("Fox Islands, Aleutian Islands, Alaska", "AK"),
    ("113 km SE of Perryville, Alaska", "AK"),
    ("off the coast of Oregon", "OR"),
    ("5 km S of Indios, Puerto Rico", "PR"),
    ("Hawaii region, Hawaii", "HI"),
    ("Baja California, Mexico", None),
    ("Vancouver Island, Canada region", None),
    ("Rat Islands, Aleutian Islands", "AK"),
    (None, None),
])
def test_quake_state(place, state):
    assert P.quake_state(place) == state


def test_parse_nifc_footnote_row():
    page = ("<table><tr><td>Year</td><td>Fires</td><td>Acres</td></tr>"
            "<tr><td class='x'>2025</td><td>77,850</td><td>5,131,474</td></tr>"
            "<tr><td>2004</td><td>65,461</td><td>*8,097,880</td></tr>"
            "<tr><td colspan='3'><p>* 2004 fires and acres do not include state lands</p></td></tr></table>")
    assert P.parse_nifc(page) == [(2004, 65461, 8097880.0), (2025, 77850, 5131474.0)]


def test_parse_oni():
    text = " SEAS  YR   TOTAL   ANOM\n  DJF 1950  25.01  -1.32\n  ASO 2026  29.23   2.46\n"
    assert P.parse_oni(text) == [(1950, "DJF", 1, 25.01, -1.32), (2026, "ASO", 9, 29.23, 2.46)]


def test_nfip_aggregator():
    agg = P.NfipAggregator()
    agg.add({"dateOfLoss": "2017-08-27T00:00:00.000Z", "state": "TX", "floodEvent": "Hurricane Harvey",
             "amountPaidOnBuildingClaim": 100.0, "amountPaidOnContentsClaim": 50.0,
             "amountPaidOnIncreasedCostOfComplianceClaim": None})
    agg.add({"dateOfLoss": "2017-08-30", "state": "TX", "floodEvent": "Hurricane Harvey",
             "amountPaidOnBuildingClaim": None, "amountPaidOnContentsClaim": None,
             "amountPaidOnIncreasedCostOfComplianceClaim": None})
    agg.add({"dateOfLoss": "2017-09-02", "state": "LA", "floodEvent": "Hurricane Harvey",
             "amountPaidOnBuildingClaim": "25", "amountPaidOnContentsClaim": "",
             "amountPaidOnIncreasedCostOfComplianceClaim": "5"})
    months = {(r[0], r[1]): r[2:] for r in agg.month_rows()}
    assert months[(date(2017, 8, 1), "TX")] == (2, 1, 100.0, 50.0, 0.0)
    assert months[(date(2017, 9, 1), "LA")] == (1, 1, 25.0, 0.0, 5.0)
    (ev,) = agg.event_rows()
    assert ev == ("Hurricane Harvey", date(2017, 8, 27), date(2017, 9, 2), 3, 180.0, "TX")


# ---------------------------------------------------------------- reported catastrophe losses

def _amounts(text):
    return [(c.value, c.scope, c.source) for c in cl.extract(text) if c.kind == "amount"]


def test_extract_sentence_after_and_before():
    t = ("Third quarter 2024 results. Catastrophe losses, net of reinsurance, were $45.2 million in the third "
         "quarter. The prior year included $1.1 billion of net catastrophe losses.")
    got = _amounts(t)
    assert got[0] == (pytest.approx(45.2e6), "quarter", "sentence")
    assert len(got) == 1  # "The prior year included $1.1 billion ...": the comparison period, not a candidate


def test_extract_scopes_and_points():
    t = ("For the nine months ended September 30, 2024, catastrophe losses were $310.5 million.\n"
         "Catastrophe losses added 5.3 points to the combined ratio in the quarter.\n"
         "There were no significant catastrophe losses in the quarter.")
    cands = cl.extract(t)
    amounts = [(c.value, c.scope) for c in cands if c.kind == "amount"]
    assert (pytest.approx(310.5e6), "ytd") in amounts
    assert (0.0, "quarter") in amounts
    points = [c.value for c in cands if c.kind == "points"]
    assert points == [5.3]


def test_extract_table_row_with_units_and_period_header():
    t = ("($ in millions)\n | Three Months Ended September 30, | | Nine Months Ended September 30,\n"
         " | 2024 | | 2023 | | 2024 | | 2023\n"
         "Net premiums earned | $ | 1,000.0 | | $ | 900.0 | | $ | 2,900.0 | | $ | 2,600.0\n"
         "Catastrophe losses | $ | 123.4 | | $ | 56.7 | | $ | 300.1 | | $ | 210.0\n")
    (c,) = [c for c in cl.extract(t) if c.source == "table"]
    assert c.value == pytest.approx(123.4e6)
    assert c.scope == "quarter"


def test_choose_prefers_quarter_and_keeps_year_in_q4():
    t = ("Fourth quarter catastrophe losses were $80 million. For the full year, catastrophe losses were "
         "$500 million.")
    ch = cl.choose(cl.extract(t), date(2024, 12, 31))
    assert ch["quarter"].value == pytest.approx(80e6)
    assert ch["year"].value == pytest.approx(500e6)
    only_year = cl.choose(cl.extract("For the full year 2024, catastrophe losses were $500 million."),
                          date(2024, 12, 31))
    assert only_year["quarter"] is None and only_year["year"].value == pytest.approx(500e6)


NOT_THE_QUARTERS_LOSSES = [
    "Core operating income was strong; underwriting income excluding catastrophe losses was $2.26 billion, up 3.3%.",
    "Our results include $14.1 million of attritional and $0.2 million of catastrophe loss favorable prior year development.",
    "This range includes an estimate of $8 million to $12 million of catastrophe losses for the remainder of the year.",
    "Q4 AFTER-TAX CATASTROPHE LOSSES OF $24M",
    "In the quarter, after-tax catastrophe losses were $400 million.",
    "Catastrophe losses for the quarter included an approximate $65 million preliminary provision for COVID-19 claims.",
    "Included in September results is $167.6 million of catastrophe losses, or 4.7 loss ratio points, from Hurricane Ida.",
    "During September 2024, we incurred $563 million of catastrophe losses, or 9.0 loss ratio points.",
    "The Commercial Lines combined ratio was 95.4%. Catastrophe losses were $29.5 million, or 4.8 points.",
    "Underwriting loss in the first quarter of 2020 included $153 million of catastrophe losses at TransRe.",
    "Strong quarter. In the prior year quarter, natural catastrophe losses were $181.1 million.",
    "Ratios\n | Net catastrophe losses | 5.5 | | pts | 3.1 | | 2.4 |\n",
    "Reinsurance. Underwriting gain of $228 million including $125 million of catastrophe losses net of recoveries.",
]

# statements a release for a given quarter (year) must not take as that quarter's figure
ASPEN_2017 = ("Pre-tax catastrophe losses, net of reinsurance recoveries, totaled $54.6 million, or 8.9 percentage points,"
              " in the fourth quarter of 2016.")
ALLSTATE_2009 = ("Fourth quarter 2009 included catastrophe losses of $210 million from 13 events during the quarter and"
                 " $148 million related to reestimates of events during the first nine months of 2009.")
OTHER_QUARTER = [(ASPEN_2017, 2017), (ALLSTATE_2009, 2009)]


@pytest.mark.parametrize(("text", "year"), OTHER_QUARTER)
def test_extract_skips_other_quarters_and_partial_figures(text, year):
    assert [c.value for c in cl.extract(text, quarter_year=year) if c.kind == "amount"] == []


def test_no_catastrophe_losses_only_when_no_amount_is_stated_and_only_for_this_quarter():
    seg = "Catastrophe losses were $40 million in the quarter.\nSpecialty. There were no catastrophe losses in the quarter."
    assert all(c.source != "none" for c in cl.extract(seg, quarter_year=2024))
    prior = ("Loss ratio of 62.0% compared to 60.5% for the first quarter of 2019 with no catastrophe losses in 2019 and"
             " COVID-19 as the only potential catastrophe thus far in 2020.")
    assert [c for c in cl.extract(prior, quarter_year=2020) if c.source == "none"] == []
    quiet = "There were no catastrophe losses in the quarter."
    assert [c.value for c in cl.extract(quiet, quarter_year=2024) if c.source == "none"] == [0.0]


def test_points_imply_the_premium_base():
    assert cl.consistent_with_premium(40e6, 1.5, 2.6e9)          # CNA: $40 million, 1.5 points
    assert not cl.consistent_with_premium(12.5e6, 5.2, 1.1e9)    # a segment's $12.5 million, 5.2 points
    assert cl.consistent_with_premium(12.5e6, None, 1.1e9)       # no points stated: nothing to check


@pytest.mark.parametrize("text", NOT_THE_QUARTERS_LOSSES)
def test_extract_skips_figures_that_are_not_the_quarters_catastrophe_losses(text):
    assert [c.value for c in cl.extract(text) if c.kind == "amount"] == []


def test_fourth_quarter_release_needs_the_quarter_named():
    t = "Pre-tax catastrophe losses were $2.39 billion compared with $1.83 billion last year."
    assert cl.choose(cl.extract(t, quarter_year=2024), date(2024, 12, 31))["quarter"] is None
    assert cl.choose(cl.extract(t, quarter_year=2024), date(2024, 9, 30))["quarter"].value == pytest.approx(2.39e9)


def test_full_year_statement_in_a_fourth_quarter_release_is_the_year():
    t = "Full year favorable development was $120 million. Catastrophe losses were $46 million in 2011 compared to $49 million."
    ch = cl.choose(cl.extract(t, quarter_year=2011), date(2011, 12, 31))
    assert ch["quarter"] is None and ch["year"].value == pytest.approx(46e6)


def test_choose_takes_the_group_figure_before_the_segments_and_ignores_comparisons():
    t = ("First quarter 2015 results. Estimated pre-tax catastrophe losses were $3.0 million or 0.9 points on the combined"
         " ratio, compared to $4.2 million in 2014.\nExcess and Surplus Lines. Catastrophe losses for the quarter were $0.5"
         " million or 0.4 points.\nCommercial Specialty. Catastrophe losses for the quarter were $1.0 million or 1.0 point"
         " on the combined ratio, compared to no catastrophe losses in the first quarter of 2014.")
    ch = cl.choose(cl.extract(t), date(2015, 3, 31))
    assert ch["quarter"].value == pytest.approx(3.0e6)
    assert all(c.source != "none" for c in cl.extract(t))  # "compared to no catastrophe losses" is the prior year
    scopes = [c.scope for c in cl.extract(t) if c.kind == "amount"]
    assert scopes.count("quarter") == 2  # "for the quarter were $0.5 million": period words before the amount


def test_q4_derivation_and_plausibility():
    assert cl.derive_q4(500.0, 100.0, 150.0, 170.0) == 80.0
    assert cl.derive_q4(500.0, 100.0, None, 170.0) is None
    assert cl.derive_q4(300.0, 100.0, 150.0, 170.0) is None  # negative: inconsistent inputs
    assert cl.plausible(80e6, npe_q=1e9, losses_q=600e6)
    assert not cl.plausible(2e9, npe_q=1e9, losses_q=600e6)    # above 1.5x premiums
    assert not cl.plausible(700e6, npe_q=1e9, losses_q=600e6)  # above total incurred losses
    assert not cl.plausible(-1.0, None, None)


@pytest.mark.parametrize(("filed", "q"), [(date(2024, 10, 28), date(2024, 9, 30)), (date(2025, 2, 5), date(2024, 12, 31)),
                                          (date(2024, 4, 30), date(2024, 3, 31)), (date(2024, 9, 30), date(2024, 6, 30))])
def test_quarter_for_filing(filed, q):
    assert cl.quarter_for_filing(filed) == q


# ---------------------------------------------------------------- the shock regression

def test_ols_recovers_coefficients_and_r2():
    rng = np.random.default_rng(0)
    x = rng.normal(size=(64, 3))
    y = 0.5 + x @ np.array([1.0, -2.0, 0.0])
    fit = ols(y, x)
    assert fit["beta"] == pytest.approx([0.5, 1.0, -2.0, 0.0], abs=1e-9)
    assert fit["r2"] == pytest.approx(1.0)
    noise = rng.normal(size=64)
    assert loyo_r2(noise, x, np.repeat(np.arange(16), 4)) < 0.2  # nothing to explain: no out-of-sample skill


def test_regressors_are_log_scaled():
    pq = pd.DataFrame({"us_landfall_index": [0.0, 16.0], "sig_hail": [10, 0], "sig_tornadoes": [5, 0],
                       "sig_wind": [0, 0], "nfip_paid": [0.0, 1e9], "storm_damage_wildfire": [0.0, 2e6]})
    x = regressors(pq)
    assert list(x.columns) == ["hurricane", "convective", "flood", "wildfire"]
    assert x.loc[1, "hurricane"] == pytest.approx(np.log1p(16.0))
    assert x.loc[0, "convective"] == pytest.approx(np.log1p(15.0))
    assert x.loc[1, "flood"] == pytest.approx(np.log1p(1000.0))


# ---------------------------------------------------------------- the extraction run, end to end on fakes

class _Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def __iter__(self):
        return iter(self.rows)


class _Cursor:
    def __init__(self, sink):
        self.sink = sink

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def executemany(self, sql, rows):
        self.sink.extend(rows)


class _Conn:
    def __init__(self, docs, fin):
        self.docs, self.fin, self.written = docs, fin, []

    def execute(self, sql, params=None):
        if "from raw.sec_document" in sql:
            return _Rows(self.docs)
        if "from core.company_quarter" in sql:
            return _Rows(self.fin)
        return _Rows([])

    def cursor(self):
        return _Cursor(self.written)

    def commit(self):
        pass


class _Fetcher:
    def __init__(self, tmp, bodies):
        self.tmp, self.bodies = tmp, bodies

    def _paths(self, url):
        name = url.rsplit("/", 1)[-1]
        body, meta = self.tmp / name, self.tmp / f"{name}.meta.json"
        if url in self.bodies and not body.exists():
            body.write_text(self.bodies[url])
            meta.write_text('{"status": 200}')
        return body, meta


def test_run_extracts_quarters_and_derives_q4(tmp_path):
    rel = {
        "u/q1.htm": "First quarter 2024: catastrophe losses were $40.0 million in the quarter.",
        "u/q2.htm": "Second quarter 2024: catastrophe losses were $90.0 million in the quarter.",
        "u/q3.htm": "Third quarter 2024: catastrophe losses were $150.0 million in the quarter.",
        "u/q4.htm": "For the full year 2024, catastrophe losses were $380.0 million.",
        "u/bad.htm": "Catastrophe losses were $9.0 billion in the quarter.",  # above premiums: rejected
    }
    docs = [(1, "a1", "u/q1.htm", "EX-99.1", date(2024, 4, 25)), (1, "a2", "u/q2.htm", "EX-99.1", date(2024, 7, 25)),
            (1, "a3", "u/q3.htm", "EX-99.1", date(2024, 10, 24)), (1, "a4", "u/q4.htm", "EX-99.1", date(2025, 2, 6)),
            (2, "b1", "u/bad.htm", "EX-99.1", date(2024, 10, 24)),
            (1, "a5", "u/missing.htm", "EX-99.1", date(2024, 10, 24))]  # not cached: skipped, never fetched
    fin = [(1, date(2024, m, d), 1e9, 6e8) for m, d in ((3, 31), (6, 30), (9, 30), (12, 31))] + [(2, date(2024, 9, 30), 1e9, 6e8)]
    conn = _Conn(docs, fin)
    stats = cl.run(conn, _Fetcher(tmp_path, rel))
    got = {(r[0], r[1]): (r[2], r[4]) for r in conn.written}
    assert got[(1, date(2024, 3, 31))] == (pytest.approx(40e6), "quarter")
    assert got[(1, date(2024, 9, 30))] == (pytest.approx(150e6), "quarter")
    assert got[(1, date(2024, 12, 31))] == (pytest.approx(100e6), "derived")  # 380 - 40 - 90 - 150
    assert (2, date(2024, 9, 30)) not in got
    assert stats["documents_cached"] == 5 and stats["derived_q4"] == 1
