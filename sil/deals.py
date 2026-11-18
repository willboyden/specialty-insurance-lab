"""The deals that took a carrier of the universe off the public market, plus the take-privates pending now.

Everything here is a CANDIDATE until sil/ma.py checks it against the record:
  - dates come from the filing index only (announcement 8-K, merger proxy, closing 8-K item 5.01 or Form 25);
  - the acquirer name, the headline price and the form of payment are exact phrases that must be found by SEC
    full-text search inside the target's own deal filings (press release, proxy, tender documents);
  - a field whose check finds nothing is published as unverified, never as fact.

The acquirer check is the strongest: the acquirer's name and the deal price must appear in the SAME document
(full-text search ANDs quoted phrases), so a buyer that was already a shareholder, and named in every filing,
is not verified by its name alone.

`acquirer_type` is a classification of the verified acquirer (who it is), `group` the four colour groups the
dashboard uses. A deal with a mixed or all-stock price carries the phrases that prove its terms instead of one
price per share.
"""

from __future__ import annotations

from dataclasses import dataclass, field

US = "US insurer"
JP = "Japanese insurer"
NONUS = "Other non-US insurer"
PRIVATE = "Private capital"
UNKNOWN = "Buyer not yet identified"
GROUPS = (US, JP, NONUS, PRIVATE)


@dataclass(frozen=True)
class Deal:
    key: str                      # target ticker + closing year, e.g. "HCC-2015"
    ticker: str                   # the target (a universe ticker)
    close_year: int               # anchors the search windows; the closing date itself comes from the filings
    acquirer: str = ""
    acquirer_type: str = ""
    group: str = UNKNOWN
    acquirer_phrases: tuple[str, ...] = ()   # any one found in the target's deal filings verifies the acquirer
    consideration: str = ""       # cash | stock | mixed
    price: float | None = None    # headline value per target share, USD
    price_phrases: tuple[str, ...] = ()      # prove the headline price
    cash_phrases: tuple[str, ...] = ()       # prove an all-cash payment
    terms_phrases: tuple[str, ...] = ()      # prove the terms of a mixed or stock deal (all must be found)
    stated_value_phrases: tuple[str, ...] = ()  # for mixed deals: a headline transaction value
    stated_value: float | None = None
    earlier_prices: tuple[tuple[float, str, str], ...] = ()  # (price, phrase, 'agreed' | 'proposed') before the final
    acquirer_all: bool = False    # a consortium: every phrase must be found (in the same document as the price)
    pending: bool = False
    note: str = ""
    forms_extra: tuple[str, ...] = field(default=())   # e.g. 6-K for a foreign private issuer


DEALS: list[Deal] = [
    Deal("SBX-2013", "SBX", 2013, "Enstar Group", "Bermuda (re)insurer, run-off acquirer", NONUS, ("Enstar",),
         "cash", 11.11, ("$11.11 per share",), ("$11.11 per share in cash",)),
    Deal("ALTE-2013", "ALTE", 2013, "Markel", "US insurer", US, ("Markel",), "mixed",
         terms_phrases=("0.04315", "$10.00 in cash"), stated_value_phrases=("$3.13 billion",), stated_value=3.13e9,
         note="stock and cash: 0.04315 of a Markel share plus $10.00 in cash per Alterra share"),
    Deal("ASI-2013", "ASI", 2013, "Fairfax Financial", "Canadian insurer", NONUS, ("Fairfax",),
         "cash", 30.25, ("$30.25 per share",), ("$30.25 per share in cash", "$30.25 in cash"),
         earlier_prices=((29.25, "$29.25 per share", "agreed"),),
         note="the June 2013 agreement at $29.25 was amended to $30.25 in August 2013"),
    Deal("TWGP-2014", "TWGP", 2014, "ACP Re", "Bermuda (re)insurer", NONUS, ("ACP Re",),
         "cash", 2.50, ("$2.50 per share",), ("$2.50 per share in cash",),
         earlier_prices=((3.00, "$3.00 in cash", "agreed"),),
         note="after reserve charges; the price agreed in January 2014 was cut in an amended agreement"),
    Deal("HCC-2015", "HCC", 2015, "Tokio Marine", "Japanese insurer", JP, ("Tokio Marine",),
         "cash", 78.00, ("$78.00 per share",), ("$78.00 per share in cash",)),
    Deal("MIG-2015", "MIG", 2015, "Fosun International", "Chinese conglomerate", NONUS, ("Fosun",),
         "cash", 8.65, ("$8.65 per share",), ("$8.65 per share in cash",)),
    Deal("NATL-2016", "NATL", 2016, "American Financial Group (Great American)", "US insurer (majority owner)", US,
         ("Great American Insurance",), "cash", 32.00, ("$32.00 per share",), ("$32.00 per share in cash",),
         earlier_prices=((30.00, "$30.00 per share", "proposed"),),
         note="Great American already owned about half of the shares: a minority buy-out (Schedule 13E-3)"),
    Deal("ENH-2017", "ENH", 2017, "Sompo Holdings", "Japanese insurer", JP, ("Sompo",),
         "cash", 93.00, ("$93.00 per share",), ("$93.00 per share in cash",)),
    Deal("AWH-2017", "AWH", 2017, "Fairfax Financial", "Canadian insurer", NONUS, ("Fairfax",), "mixed",
         54.00, ("$54.00 per share",), terms_phrases=("0.030392", "$10.00 in cash", "$5.00 per share special dividend"),
         note="0.030392 of a Fairfax subordinate voting share plus $10.00 in cash per Allied World share through an"
              " exchange offer, and a $5.00 per share special dividend before closing: $54.00 at announcement"),
    Deal("OB-2017", "OB", 2017, "Intact Financial", "Canadian insurer", NONUS, ("Intact Financial",),
         "cash", 18.10, ("$18.10 per share",), ("$18.10 per share in cash",)),
    Deal("SNC-2017", "SNC", 2017, "Markel", "US insurer", US, ("Markel",),
         "cash", 21.00, ("$21.00 per share",), ("$21.00 per share in cash",)),
    Deal("VR-2018", "VR", 2018, "AIG", "US insurer", US, ("American International Group",),
         "cash", 68.00, ("$68.00 per share",), ("$68.00 per share in cash",)),
    Deal("XL-2018", "XL", 2018, "AXA", "European insurer", NONUS, ("AXA",),
         "cash", 57.60, ("$57.60 per share",), ("$57.60 per share in cash",)),
    Deal("AFSI-2018", "AFSI", 2018, "Karfunkel-Zyskind family and Stone Point Capital",
         "Family buy-out with private equity", PRIVATE, ("Stone Point", "Karfunkel"), "cash", 14.75,
         ("$14.75 per share",), ("$14.75 per share in cash",), earlier_prices=((13.50, "$13.50 per share", "agreed"),),
         acquirer_all=True,
         note="taken private by its founding family with Stone Point; the price was raised in an amended agreement"),
    Deal("AHL-2019", "AHL", 2019, "Apollo Global Management", "Private equity", PRIVATE, ("Apollo",),
         "cash", 42.75, ("$42.75 per share",), ("$42.75 per share in cash",)),
    Deal("NAVG-2019", "NAVG", 2019, "The Hartford", "US insurer", US, ("Hartford",),
         "cash", 70.00, ("$70.00 per share",), ("$70.00 per share in cash",)),
    Deal("PTVCB-2021", "PTVCB", 2021, "Progressive", "US insurer", US, ("Progressive",),
         "cash", 23.30, ("$23.30 per share",), ("$23.30 per share in cash",)),
    Deal("PROS-2021", "PROS", 2021, "TowerBrook Capital Partners and Further Global Capital Management",
         "Private equity", PRIVATE, ("Further Global", "TowerBrook"),
         "cash", 12.85, ("$12.85 per share",), ("$12.85 per share in cash",), acquirer_all=True,
         note="its majority holders consented in writing, so an information statement replaced the proxy vote"),
    Deal("Y-2022", "Y", 2022, "Berkshire Hathaway", "US insurer", US, ("Berkshire Hathaway",),
         "cash", 848.02, ("$848.02 per share",), ("$848.02 per share in cash",)),
    Deal("TIG-2023", "TIG", 2023, "Altaris", "Private equity (majority owner)", PRIVATE, ("Altaris",),
         "cash", 6.15, ("$6.15 per share",), ("$6.15 per share in cash",),
         note="Altaris already controlled Trean: a minority buy-out (Schedule 13E-3)"),
    Deal("ARGO-2023", "ARGO", 2023, "Brookfield Reinsurance", "Alternative-capital reinsurer", PRIVATE,
         ("Brookfield Reinsurance", "Brookfield Re"), "cash", 30.00, ("$30.00 per share",),
         ("$30.00 per share in cash",)),
    Deal("AHL-2026", "AHL", 2026, "Sompo Holdings", "Japanese insurer", JP, ("Sompo",),
         "cash", 37.50, ("$37.50 per share",), ("$37.50 per share in cash",), forms_extra=("6-K",),
         note="second exit: listed again in May 2025 after Apollo's ownership; a foreign private issuer (6-K)"),
    Deal("PRA-2026", "PRA", 2026, "The Doctors Company", "US reciprocal insurer", US, ("The Doctors Company",),
         "cash", 25.00, ("$25.00 per share",), ("$25.00 per share in cash",)),
    # ---- pending take-privates (core.company_status says 'pending'); the buyer comes from the merger proxy
    Deal("BOW-pending", "BOW", 2026, pending=True,
         note="merger proxy and going-private schedule (SC 13E3) filed: an affiliated buyer"),
    Deal("ARX-pending", "ARX", 2026, pending=True,
         note="preliminary merger proxy and going-private schedule (SC 13E3) filed: an affiliated buyer"),
]


def by_key() -> dict[str, Deal]:
    return {d.key: d for d in DEALS}
