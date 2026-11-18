"""M&A domain: the curated deal list stays in step with the universe, the checks are built the way the docs say,
listing dates follow the rules, and the document extractor reads deal terms from proxy and press-release text."""

from __future__ import annotations

from datetime import date

from sil import ma
from sil.deals import DEALS, GROUPS, UNKNOWN, Deal, by_key
from sil.sources import deal_docs
from sil.universe import COMPANIES


def test_every_acquired_carrier_has_a_deal_and_every_deal_a_carrier():
    tickers = {c.ticker for c in COMPANIES}
    acquired = {c.ticker for c in COMPANIES if c.status == "acquired"}
    closed = {d.ticker for d in DEALS if not d.pending}
    assert all(d.ticker in tickers for d in DEALS)
    assert acquired == closed, f"acquired without a deal: {acquired - closed}; deal without status: {closed - acquired}"
    assert len(by_key()) == len(DEALS)


def test_deal_fields_are_consistent():
    for d in DEALS:
        if d.pending and not d.acquirer:  # a pending deal before its buyer is known
            assert d.group == UNKNOWN and not d.acquirer_phrases and d.price is None
            continue
        assert d.group in GROUPS
        assert d.acquirer and d.acquirer_phrases
        assert d.consideration in ("cash", "stock", "mixed")
        if d.consideration == "cash":
            assert d.price is not None and d.price_phrases
        else:
            assert d.terms_phrases, d.key
        for _p, phrase, kind in d.earlier_prices:
            assert kind in ("agreed", "proposed") and phrase


def test_acquirer_check_requires_the_price_in_the_same_document():
    hcc = by_key()["HCC-2015"]
    checks = ma.checks_for(hcc)
    assert ("acquirer", ("Tokio Marine", "$78.00 per share")) in checks
    assert ("price", ("$78.00 per share",)) in checks
    assert any(f == "cash" and p == ("$78.00 per share in cash",) for f, p in checks)
    pros = ma.checks_for(by_key()["PROS-2021"])
    assert ("acquirer", ("Further Global", "TowerBrook", "$12.85 per share")) in pros  # a consortium: all names
    natl = ma.checks_for(by_key()["NATL-2016"])
    assert ("earlier_price:proposed", ("$30.00 per share",)) in natl


def test_pending_deals_are_checked_like_closed_ones():
    bow = ma.checks_for(by_key()["BOW-pending"])
    assert ("acquirer", ("American Family", "$34.00 per share")) in bow
    assert ("price", ("$34.00 per share",)) in bow
    assert ma.checks_for(Deal("X-pending", "X", 2026, pending=True)) == []  # no candidate yet: nothing to search


def test_cash_variants_format_thousands():
    assert ma.cash_variants(848.02)[0] == "$848.02 per share in cash"
    assert ma.cash_variants(1234.5)[0] == "$1,234.50 per share in cash"


def test_filing_url():
    assert ma.filing_url(888919, "0001104659-15-044017") == (
        "https://www.sec.gov/Archives/edgar/data/888919/000110465915044017/0001104659-15-044017-index.htm")
    assert ma.filing_url(1, None) is None


def test_ipo_date_rules():
    d = date.fromisoformat
    # an IPO prospectus months before the first periodic report (a foreign filer's first 20-F)
    assert ma.ipo_date([("F-1", d("2023-04-14")), ("424B4", d("2023-06-30")), ("20-F", d("2024-03-15")),
                        ("424B4", d("2024-05-23"))], d("2024-03-15")) == d("2023-06-30")
    # a later secondary offering is not the IPO
    assert ma.ipo_date([("S-1", d("2022-11-14")), ("424B4", d("2023-01-13")), ("10-K", d("2023-03-28")),
                        ("424B4", d("2023-06-08"))], d("2023-03-28")) == d("2023-01-13")
    # no prospectus: the exchange registration after a registration statement
    assert ma.ipo_date([("S-1", d("2014-07-15")), ("8-A12B", d("2014-10-28")), ("10-Q", d("2014-11-18"))],
                       d("2014-11-18")) == d("2014-10-28")
    # a preferred-stock prospectus long after the first report is not an IPO
    assert ma.ipo_date([("10-K", d("1996-05-14")), ("424B4", d("2017-06-12"))], d("1996-05-14")) is None


PROXY = """
AGREEMENT AND PLAN OF MERGER, dated as of December 15, 2022, by and among Treetop Holdings, LLC, a Delaware
limited liability company ("Parent"), Treetop Merger Sub, Inc. ("Merger Sub") and Example Insurance Group, Inc.
If the merger is completed, you will be entitled to receive $6.15 in cash, without interest, for each share of
common stock you own. The merger consideration of $6.15 per share in cash represents a premium of 23%.
Holders will receive $6.15 per share in cash at closing. A $5.00 per share dividend was paid in 2019.
"""

PRESS = """
Example Re Ltd. today announced that it has entered into a definitive agreement under which Big Insurer Holdings
will acquire all of the outstanding shares of Example Re for $78.00 per share in cash, for a total of
approximately $7.5 billion. Shareholders will receive $78.00 per share.
"""

STOCK = """
Each Alpha share will be converted into the right to receive 0.04315 of a share of Markel common stock and
$10.00 in cash, which values Alpha at $31.40 per share based on the exchange ratio and Markel's closing price.
"""


def test_extract_from_a_merger_proxy():
    got = deal_docs.extract(PROXY)
    assert got["price"] == 6.15
    assert got["consideration"] == "cash"
    assert got["parent"] == "Treetop Holdings, LLC"
    assert got["agreement_date"] == date(2022, 12, 15)
    assert 5.00 not in got["prices"]  # a dividend amount outside the deal language is not a price


def test_extract_from_a_press_release():
    got = deal_docs.extract(PRESS)
    assert got["price"] == 78.00
    assert got["consideration"] == "cash"
    assert got["parent"] == "Big Insurer Holdings"


def test_extract_mixed_consideration():
    got = deal_docs.extract(STOCK)
    assert got["price"] == 31.40
    assert got["consideration"] in ("stock", "mixed")


def test_extract_skips_par_value_and_suffix_only_names():
    text = ("In the merger, Alterra shareholders will be entitled to receive for each common share, par value $1.00 per"
            " share, of Alterra, 0.04315 of a share of Markel common stock and $10.00 in cash.")
    assert 1.00 not in deal_docs.extract(text)["prices"]
    assert deal_docs._clean_name("LLC") is None and deal_docs._clean_name("Company, Inc") is None
    assert deal_docs._clean_name("Treadstone Parent Inc") == "Treadstone Parent Inc"
    assert deal_docs._clean_name("Company, Evergreen Parent, L.P") == "Evergreen Parent, L.P"


def test_extract_nothing_from_unrelated_text():
    got = deal_docs.extract("Net premiums earned were $1,234.5 million. Book value per share was $41.10 per share.")
    assert got["price"] is None and got["parent"] is None
