"""Mergers and acquisitions: the deals that took carriers of the universe off the public market, the take-privates
pending now, how the listed universe grew and shrank, and what the carriers themselves bought.

Sources (public, no key):
  - the SEC filing index (raw.sec_filing): announcement 8-Ks, merger proxies, tender and going-private schedules,
    closing 8-Ks (item 5.01 change in control), delistings (Form 25) and deregistrations (Form 15), IPO
    prospectuses (424B4) and exchange registrations (8-A12B);
  - SEC full-text search (efts.sec.gov): each candidate in sil/deals.py (acquirer name, price per share, form of
    payment) must appear as an exact phrase in the target's own deal filings; every check is stored with its hits;
  - XBRL company facts (raw.xbrl_fact): shares outstanding (cover page), equity and preferred stock, cash paid for
    acquisitions, divestiture proceeds, goodwill, intangibles, claim reserves acquired;
  - optionally the deal documents themselves (sil/sources/deal_docs.py), once the main pipeline has cached them.

Ingest:  python -m sil ingest deal_checks   (full-text search; cached 30 days)
         python -m sil ingest deal_docs     (reads cached merger documents only; never fetches)
Build:   python -m sil domains ma
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import date, timedelta
from urllib.parse import quote

from .db import ingest_run
from .deals import DEALS, GROUPS, UNKNOWN, Deal
from .http import Fetcher, FetchError
from .sources import deal_docs

log = logging.getLogger(__name__)

DAY = 24 * 3600
MERGER_DOCS = ("PREM14A", "DEFM14A", "PREM14C", "DEFM14C", "SC 13E3", "SC TO-T", "SC 14D9", "S-4")
SEARCH_FORMS = ("8-K", "PREM14A", "DEFM14A", "PREM14C", "DEFM14C", "DEFA14A", "SC 13E3", "SC TO-T", "SC 14D9",
                "425", "SC TO-C", "SC 14D9-C")
DELISTING = ("25", "25-NSE")
DEREGISTRATION = ("15-12B", "15-12G", "15-15D", "15F-12B", "15F-12G", "15F-15D")
PERIODIC = ("10-K", "10-Q", "20-F", "40-F", "6-K", "10-K405")
FIRST_YEAR = 2008  # the listed-universe series starts at year-end 2008

ACTIVITY_FLOWS = {
    "acq_cash": ("PaymentsToAcquireBusinessesNetOfCashAcquired", "PaymentsToAcquireBusinessesGross",
                 "PaymentsToAcquireBusinessesAndInterestInAffiliates"),
    "divest_proceeds": ("ProceedsFromDivestitureOfBusinesses", "ProceedsFromDivestitureOfBusinessesNetOfCashDivested",
                        "ProceedsFromDivestitureOfInterestInConsolidatedSubsidiaries",
                        "ProceedsFromDivestitureOfBusinessesAndInterestsInAffiliates"),
    "goodwill_acquired": ("GoodwillAcquiredDuringPeriod",),
    "goodwill_impairment": ("GoodwillImpairmentLoss",),
    "reserves_acquired": ("LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseBusinessAcquisitions",),
}
ACTIVITY_STOCKS = {
    "goodwill": ("Goodwill",),
    "intangibles": ("IntangibleAssetsNetExcludingGoodwill",),
    "gi_total": ("IntangibleAssetsNetIncludingGoodwill",),
}


def filing_url(cik: int, accession: str | None, filename: str | None = None) -> str | None:
    if not accession:
        return None
    base = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/"
    return base + (filename if filename else f"{accession}-index.htm")


def cash_variants(price: float) -> tuple[str, ...]:
    p = f"${price:,.2f}"
    return (f"{p} per share in cash", f"{p} in cash per share", f"{p} per share, in cash",
            f"{p} per common share in cash", f"{p} in cash, without interest")


# ---------------------------------------------------------------- timeline anchors from the filing index

@dataclass
class Anchors:
    closed: date | None = None
    closed_basis: str | None = None
    closed_accession: str | None = None
    first_proxy: date | None = None
    first_proxy_form: str | None = None
    first_proxy_accession: str | None = None
    deregistered: date | None = None
    fallback_announce: date | None = None          # last 8-K item 1.01 within 120 days before the first proxy
    fallback_announce_accession: str | None = None

    @property
    def search_start(self) -> date:
        ref = self.first_proxy or self.closed or date.today()
        return ref - timedelta(days=300)

    @property
    def search_end(self) -> date:
        return min(date.today(), (self.closed or date.today()) + timedelta(days=60))


def anchors(conn, cik: int, deal: Deal) -> Anchors:
    """Closing, first deal document and deregistration of one deal, from the filing index alone."""
    a = Anchors()
    y = deal.close_year
    rows = conn.execute(
        "select accession, form, filing_date, coalesce(items, '') from raw.sec_filing where cik = %s"
        " and filing_date between %s and %s order by filing_date, accession",
        (cik, date(y - 3, 1, 1), date(y + 1, 12, 31)),
    ).fetchall()
    if not deal.pending:
        lo, hi = date(y, 1, 1) - timedelta(days=60), date(y, 12, 31) + timedelta(days=60)
        for acc, form, d, items in rows:
            if not lo <= d <= hi:
                continue
            closes = form == "8-K" and ("5.01" in items or ("2.01" in items and ("3.01" in items or "3.03" in items)))
            if closes or form in DELISTING:
                a.closed, a.closed_accession = d, acc
                a.closed_basis = f"8-K items {items}" if form == "8-K" else f"Form {form} (delisting)"
                break
    ref_end = a.closed or date.today()
    for acc, form, d, _items in rows:
        if form in MERGER_DOCS and ref_end - timedelta(days=460) <= d <= ref_end:
            a.first_proxy, a.first_proxy_form, a.first_proxy_accession = d, form, acc
            break
    if a.first_proxy:
        cands = [(d, acc) for acc, form, d, items in rows
                 if form == "8-K" and "1.01" in items and a.first_proxy - timedelta(days=120) <= d <= a.first_proxy]
        if cands:
            a.fallback_announce, a.fallback_announce_accession = cands[-1]
    if a.closed:
        for _acc, form, d, _items in rows:
            if form in DEREGISTRATION and d >= a.closed:
                a.deregistered = d
                break
    return a


# ---------------------------------------------------------------- SEC full-text search checks

def efts_search(fetcher: Fetcher, phrases: str | tuple[str, ...], cik: int, forms: tuple[str, ...], start: date,
                end: date, max_hits: int = 400) -> tuple[int, list[tuple[date, str, str, str]]]:
    """Exact-phrase search inside one company's filings; several phrases must all appear in the same document
    (full-text search ANDs quoted phrases). Returns (total, [(file_date, form, accession, file)])."""
    phrases = (phrases,) if isinstance(phrases, str) else phrases
    q = " ".join(f'"{p}"' for p in phrases)
    hits: list[tuple[date, str, str, str]] = []
    total = 0
    offset = 0
    while True:
        url = (f"https://efts.sec.gov/LATEST/search-index?q={quote(q)}&ciks={cik:010d}"
               f"&forms={quote(','.join(forms))}&dateRange=custom&startdt={start.isoformat()}"
               f"&enddt={end.isoformat()}" + (f"&from={offset}" if offset else ""))
        data = fetcher.get_json(url, max_age_s=30 * DAY)
        page = data["hits"]["hits"]
        total = data["hits"]["total"]["value"]
        for h in page:
            s = h["_source"]
            file = h["_id"].split(":", 1)[1] if ":" in h["_id"] else ""
            hits.append((date.fromisoformat(s["file_date"]), (s.get("root_forms") or [s.get("form")])[0],
                         s["adsh"], file))
        offset += len(page)
        if not page or offset >= total or offset >= max_hits:
            break
    hits.sort()
    return total, hits


def checks_for(deal: Deal) -> list[tuple[str, tuple[str, ...]]]:
    """(field, phrases) checks; the phrases of one check must all appear in the same document.

    acquirer: the buyer's name together with the deal price (or, for a stock-and-cash deal, its exchange terms),
    so that a buyer already named in every filing (a controlling shareholder) is not verified by its name alone.
    """
    anchor = deal.price_phrases[:1] or deal.terms_phrases[:1]
    out: list[tuple[str, tuple[str, ...]]] = []
    if deal.acquirer_all:
        out.append(("acquirer", (*deal.acquirer_phrases, *anchor)))
    else:
        out += [("acquirer", (p, *anchor)) for p in deal.acquirer_phrases]
    out += [("price", (p,)) for p in deal.price_phrases]
    if deal.consideration == "cash" and deal.price is not None:
        out += [("cash", (p,)) for p in (*deal.cash_phrases, *cash_variants(deal.price))]
    out += [("terms", (p,)) for p in deal.terms_phrases]
    out += [("stated_value", (p,)) for p in deal.stated_value_phrases]
    out += [(f"earlier_price:{kind}", (p,)) for _v, p, kind in deal.earlier_prices]
    seen: set[tuple[str, tuple[str, ...]]] = set()
    return [c for c in out if not (c in seen or seen.add(c))]


def phrase_label(phrases: tuple[str, ...]) -> str:
    return " + ".join(phrases)


def ingest_checks(conn, fetcher: Fetcher) -> None:
    """Run every exact-phrase check of sil/deals.py against SEC full-text search; store the hits."""
    ciks = dict(conn.execute("select ticker, cik from ref.company"))
    with ingest_run(conn, "ma_deal_checks") as info:
        rows = []
        failed = 0
        for deal in DEALS:
            if deal.pending:
                continue
            cik = ciks[deal.ticker]
            a = anchors(conn, cik, deal)
            forms = (*SEARCH_FORMS, *deal.forms_extra)
            for fld, phrases in checks_for(deal):
                try:
                    total, hits = efts_search(fetcher, phrases, cik, forms, a.search_start, a.search_end)
                except FetchError as exc:
                    failed += 1
                    log.warning("full-text search %s %r: %s", deal.key, phrases, exc)
                    continue
                first = hits[0] if hits else None
                last = hits[-1] if hits else None
                rows.append((deal.key, fld, phrase_label(phrases), ",".join(forms), a.search_start, a.search_end, total,
                             first[0] if first else None, first[1] if first else None,
                             first[2] if first else None, first[3] if first else None,
                             last[0] if last else None, last[2] if last else None, last[3] if last else None))
            log.info("checked %s (%d phrases)", deal.key, len(checks_for(deal)))
        conn.execute("delete from raw.ma_deal_check")
        with conn.cursor() as cur:
            cur.executemany(
                "insert into raw.ma_deal_check(deal_key, field, phrase, forms, start_date, end_date, hits, first_date,"
                " first_form, first_accession, first_file, last_date, last_accession, last_file)"
                " values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", rows)
        conn.commit()
        info["rows"] = len(rows)
        info["detail"] = {"checks": len(rows), "failed": failed}


SOURCES = {"deal_checks": ingest_checks, "deal_docs": deal_docs.ingest}


# ---------------------------------------------------------------- build

def _load_ref(conn, ciks: dict[str, int]) -> None:
    conn.execute("delete from ref.ma_deal")
    with conn.cursor() as cur:
        cur.executemany(
            "insert into ref.ma_deal(key, cik, ticker, acquirer, acquirer_type, grp, consideration, price,"
            " stated_value, pending, note) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [(d.key, ciks[d.ticker], d.ticker, d.acquirer or None, d.acquirer_type or None, d.group,
              d.consideration or None, d.price, d.stated_value, d.pending, d.note or None) for d in DEALS],
        )


def _checks(conn) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in conn.execute(
        "select deal_key, field, phrase, hits, first_date, first_form, first_accession, first_file, last_date,"
        " last_accession, last_file from raw.ma_deal_check order by deal_key, field, phrase"
    ):
        out.setdefault(r[0], []).append({
            "field": r[1], "phrase": r[2], "hits": r[3], "first_date": r[4], "first_form": r[5],
            "first_accession": r[6], "first_file": r[7], "last_date": r[8], "last_accession": r[9],
            "last_file": r[10],
        })
    return out


def _fact_at(conn, cik: int, tags: tuple[str, ...], on_or_before: date, max_age_days: int,
             taxonomy: str = "us-gaap") -> tuple[float, date] | None:
    """Latest-filed value of the most recent instant fact at or before a date (first tag with data wins)."""
    for tag in tags:
        r = conn.execute(
            "select value, period_end from raw.xbrl_fact where cik = %s and taxonomy = %s and tag = %s"
            " and period_start is null and period_end <= %s and period_end >= %s"
            " order by period_end desc, filed desc limit 1",
            (cik, taxonomy, tag, on_or_before, on_or_before - timedelta(days=max_age_days)),
        ).fetchone()
        if r:
            return float(r[0]), r[1]
    return None


def _shares(conn, cik: int, announced: date) -> tuple[float, date, str] | None:
    """Cover-page shares outstanding before the announcement; if the company listed (IPO or relisting) between that
    cover and the announcement, the first cover after it (the listing changed the share count)."""
    before = _fact_at(conn, cik, ("EntityCommonStockSharesOutstanding",), announced, 420, taxonomy="dei")
    listed_between = before is not None and conn.execute(
        "select 1 from raw.sec_filing where cik = %s and form = '424B4' and filing_date > %s and filing_date <= %s",
        (cik, before[1], announced),
    ).fetchone() is not None
    if before and not listed_between:
        return before[0], before[1], "shares on the last cover page before the announcement"
    r = conn.execute(
        "select value, period_end from raw.xbrl_fact where cik = %s and taxonomy = 'dei'"
        " and tag = 'EntityCommonStockSharesOutstanding' and period_end > %s and period_end <= %s"
        " order by period_end, filed desc limit 1",
        (cik, announced, announced + timedelta(days=400)),
    ).fetchone()
    if r:
        why = ("shares on the first cover page after the announcement (the company listed in between, which"
               " changed the share count)") if listed_between else "shares on the first cover page after the announcement"
        return float(r[0]), r[1], why
    if before:
        return before[0], before[1], "shares on the last cover page before the announcement"
    # no cover-page count (e.g. several share classes): the balance-sheet count of the last quarter before
    bs = _fact_at(conn, cik, ("CommonStockSharesOutstanding",), announced, 200)
    if bs:
        return bs[0], bs[1], "common shares outstanding on the last balance sheet before the announcement"
    return None


def _book(conn, cik: int, announced: date) -> dict:
    """Equity, preferred stock, ROE and combined ratio at the last quarter before the announcement."""
    q = conn.execute(
        "select qend, equity, roe_ttm, combined_ratio_ttm, npe_ttm from core.company_quarter"
        " where cik = %s and qend < %s and qend >= %s and equity is not null order by qend desc limit 1",
        (cik, announced, announced - timedelta(days=200)),
    ).fetchone()
    out: dict = {}
    if q:
        out = {"quarter": q[0], "equity": float(q[1]), "roe": q[2], "cr": q[3], "npe": q[4],
               "book_basis": "quarterly balance sheet"}
    else:  # equity under another tag, or an annual reporter (20-F): the last balance sheet in the XBRL facts
        f = _fact_at(conn, cik, ("StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
                     announced, 430)
        if f:
            out = {"quarter": f[1], "equity": f[0], "roe": None, "cr": None, "npe": None,
                   "book_basis": "last balance sheet in the XBRL facts"}
    if not out:
        return out
    qd = out["quarter"]
    outstanding = _fact_at(conn, cik, ("PreferredStockValueOutstanding",), qd, 20)
    pv = _fact_at(conn, cik, ("PreferredStockValue",), qd, 20)
    lp = _fact_at(conn, cik, ("PreferredStockLiquidationPreferenceValue",), qd, 20)
    preferred, basis = 0.0, "no preferred stock tagged"
    if outstanding and outstanding[0] > 0:
        preferred, basis = outstanding[0], "preferred stock outstanding"
    elif pv and pv[0] >= 0.01 * out["equity"]:
        preferred, basis = pv[0], "preferred stock carrying value"
    elif lp and lp[0] > 0:
        preferred, basis = lp[0], "preferred liquidation preference"
    elif (pv and pv[0] == 0) or (outstanding and outstanding[0] == 0):
        basis = "no preferred stock outstanding"
    elif pv:
        basis = "preferred tagged at par only: not subtracted"
    if preferred == 0 and basis != "no preferred stock outstanding":
        # preferred dividends paid in the year to the balance sheet date: preferred was outstanding, value untagged
        paid = conn.execute(
            "select max(value) from raw.xbrl_fact where cik = %s and tag = any(%s) and period_start is not null"
            " and period_end between %s and %s and value > 0",
            (cik, ["DividendsPreferredStock", "DividendsPreferredStockCash", "PreferredStockDividends",
                   "PreferredStockDividendsIncomeStatementImpact", "PreferredStockDividendsAndOtherAdjustments"],
             qd - timedelta(days=200), qd + timedelta(days=30)),
        ).fetchone()[0]
        if paid:
            basis = "preferred stock outstanding (dividends paid) but its value is not tagged"
            out["preferred_unknown"] = True
    out["preferred"] = preferred
    out["preferred_basis"] = basis
    return out


def ipo_date(forms: list[tuple[str, date]], first_periodic: date | None) -> date | None:
    """The listing date of a company that became public in the window: its IPO prospectus (424B4) next to its first
    periodic report; else its exchange registration (8-A12B) after an S-1/F-1; else that registration statement."""
    if first_periodic is None:
        return None
    def near(d: date) -> bool:  # an IPO precedes the first 10-Q by weeks, a foreign filer's first 20-F by months
        return first_periodic - timedelta(days=300) <= d <= first_periodic + timedelta(days=400)

    ipo = next((d for form, d in forms if form == "424B4" and near(d) and d.year >= 2005), None)
    if ipo is None and first_periodic.year >= FIRST_YEAR:
        regs = [d for form, d in forms if form in ("S-1", "F-1") and d <= first_periodic]
        if regs:
            ipo = next((d for form, d in forms if form == "8-A12B" and near(d)), None) or min(regs)
    return ipo


def _listings(conn, closings: dict[int, list[tuple[date, str]]]) -> list[tuple]:
    """Listing intervals of the specialty carriers: listed from an IPO or relisting (or before 2008) until a deal
    closed or the stock was delisted without one."""
    rows = []
    comps = conn.execute("select cik, status from ref.company where cohort = 'specialty' order by ticker").fetchall()
    for cik, status in comps:
        f = conn.execute(
            "select form, filing_date from raw.sec_filing where cik = %s and form = any(%s) order by filing_date",
            (cik, ["424B4", "8-A12B", "S-1", "F-1", "10-K", "10-Q", "20-F", "10-K405", *DELISTING, *DEREGISTRATION]),
        ).fetchall()
        periodic = [d for form, d in f if form in ("10-K", "10-Q", "20-F", "10-K405")]
        dereg = [d for form, d in f if form in DEREGISTRATION]
        ipo = ipo_date(f, periodic[0] if periodic else None)
        starts: list[tuple[date | None, str]] = [
            (ipo, "IPO (prospectus 424B4, else the exchange or securities registration)") if ipo and ipo.year >= FIRST_YEAR
            else (None, "listed before 2008")]
        # a relisting: the first 424B4 after a deal took the company private and it deregistered (Aspen, 2025)
        took_private = [c for c, _k in closings.get(cik, []) if any(x >= c for x in dereg)]
        for c in took_private:
            relist = next((d for form, d in f if form == "424B4" and d > c), None)
            if relist and all(st is None or st < relist for st, _b in starts):
                starts.append((relist, "relisting prospectus (424B4) after an earlier take-private"))
        ends: list[tuple[date, str, str | None]] = [(d, f"deal {k}", k) for d, k in sorted(closings.get(cik, []))]
        if status == "exited":
            delist = [d for form, d in f if form in DELISTING]
            if delist:
                ends.append((delist[-1], "delisted (Form 25) without an acquisition", None))
        for i, (start, basis) in enumerate(starts):
            nxt = starts[i + 1][0] if i + 1 < len(starts) else None
            end = next(((d, b, k) for d, b, k in sorted(ends) if (start is None or d > start)
                        and (nxt is None or d < nxt)), None)
            rows.append((cik, start, basis, end[0] if end else None, end[1] if end else "still listed",
                         end[2] if end else None))
    return rows


def _activity(conn) -> list[tuple]:
    tags = sorted({t for v in (*ACTIVITY_FLOWS.values(), *ACTIVITY_STOCKS.values()) for t in v})
    facts = conn.execute(
        """with latest as (
             select distinct on (f.cik, f.tag, f.period_start, f.period_end) f.cik, f.tag, f.period_start,
                    f.period_end, f.value
             from raw.xbrl_fact f join ref.company c using (cik)
             where c.cohort in ('specialty', 'benchmark') and f.taxonomy = 'us-gaap' and f.unit = 'USD'
               and f.tag = any(%s)
             order by f.cik, f.tag, f.period_start, f.period_end, f.filed desc, f.accession desc)
           select cik, tag, extract(year from (date_trunc('quarter', period_end + 45) - interval '1 day'))::int, value
           from latest
           where (period_start is not null and period_end - period_start + 1 between 350 and 380)
              or (period_start is null and extract(month from period_end + 16) = 1)""",
        (tags,),
    ).fetchall()
    vals: dict[tuple[int, int], dict[str, float]] = {}
    for cik, tag, fy, value in facts:
        vals.setdefault((cik, fy), {}).setdefault(tag, float(value))
    eq, res = {}, {}
    for cik, qend, equity, gross, net in conn.execute(
        "select cik, qend, equity, gross_reserves, net_reserves from core.company_quarter where extract(month from qend) = 12"
    ):
        if equity is not None:
            eq[(cik, qend.year)] = float(equity)
        if gross is not None or net is not None:
            res[(cik, qend.year)] = max(float(gross or 0), float(net or 0))
    n201 = {(r[0], int(r[1])): int(r[2]) for r in conn.execute(
        "select cik, extract(year from filing_date), count(*) from raw.sec_filing"
        " where form = '8-K' and items like '%%2.01%%' group by 1, 2")}
    rows = []
    for (cik, fy), tv in sorted(vals.items()):
        def pick(names: tuple[str, ...], tv=tv) -> float | None:
            return next((tv[n] for n in names if n in tv), None)
        gw = pick(ACTIVITY_STOCKS["goodwill"])
        intang = pick(ACTIVITY_STOCKS["intangibles"])
        if intang is None:
            total = pick(ACTIVITY_STOCKS["gi_total"])
            if total is not None:
                intang = max(0.0, total - (gw or 0.0))
        e = eq.get((cik, fy))
        gi = (gw or 0.0) + (intang or 0.0) if (gw is not None or intang is not None) else None
        acq = pick(ACTIVITY_FLOWS["acq_cash"])
        if acq is not None and e and abs(acq) > 1.5 * e:  # implausible against the company's own equity: a tagging error
            acq = None
        reserves_acq = pick(ACTIVITY_FLOWS["reserves_acquired"])
        own = res.get((cik, fy))
        if reserves_acq is not None and own is not None and reserves_acq > own:  # more than its own reserves: a scaling
            reserves_acq = None                                                  # error (HCC 2012 is tagged $14.7B)
        rows.append((cik, fy, acq, pick(ACTIVITY_FLOWS["divest_proceeds"]), gw, intang, e,
                     gi / e if gi is not None and e and e > 0 else None, pick(ACTIVITY_FLOWS["goodwill_acquired"]),
                     pick(ACTIVITY_FLOWS["goodwill_impairment"]), reserves_acq, n201.get((cik, fy), 0)))
    return rows


def _valuation(conn, cik: int, deal: Deal, announced: date, price_ok: bool, stated_ok: bool) -> dict:
    val: dict = {}
    sh = _shares(conn, cik, announced)
    bk = _book(conn, cik, announced)
    price = deal.price if price_ok else None
    if sh:
        val["shares"], val["shares_as_of"] = sh[0], sh[1]
    if price is not None and sh:
        val["implied_value"] = price * sh[0]
        val["value_basis"] = f"price per share x {sh[2]}"
    elif deal.stated_value is not None and stated_ok:
        val["implied_value"] = deal.stated_value
        val["value_basis"] = "headline value stated in the announcement (stock and cash)"
    if bk:
        common = bk["equity"] - bk["preferred"]
        val.update({"book_quarter": bk["quarter"], "common_equity": common, "preferred": bk["preferred"],
                    "roe": bk["roe"], "cr": bk["cr"], "npe": bk["npe"]})
        if bk.get("book_basis") != "quarterly balance sheet":
            val["value_basis"] = (val.get("value_basis", "") + f"; book value from the balance sheet of {bk['quarter']}"
                                  " (no quarterly data before the announcement)").lstrip("; ")
        if bk["preferred_basis"].startswith("preferred tagged at par"):
            val["value_basis"] = (val.get("value_basis", "") + "; book value includes preferred stock tagged only"
                                  " at par").lstrip("; ")
        if bk.get("preferred_unknown"):
            val["value_basis"] = (val.get("value_basis", "") + "; no price-to-book: preferred stock was outstanding"
                                  " (dividends paid) but its value is not in the XBRL facts").lstrip("; ")
        elif sh and common > 0:
            val["bps"] = common / sh[0]
            per_share = price if price is not None else (val["implied_value"] / sh[0]
                                                         if val.get("implied_value") else None)
            if per_share is not None:
                val["pb"] = per_share / val["bps"]
    return val


def build(conn) -> dict:
    ciks = dict(conn.execute("select ticker, cik from ref.company"))
    _load_ref(conn, ciks)
    checks = _checks(conn)
    docs = deal_docs.facts_by_deal(conn)
    pending_now = {r[0] for r in conn.execute("select cik from core.company_status where derived = 'pending'")}
    deal_rows = []
    closings: dict[int, list[tuple[date, str]]] = {}
    for deal in DEALS:
        cik = ciks[deal.ticker]
        a = anchors(conn, cik, deal)
        ch = checks.get(deal.key, [])

        def found(fld: str, ch=ch) -> list[dict]:
            return [c for c in ch if c["field"] == fld and c["hits"] > 0]

        acquirer_ok = bool(found("acquirer"))
        price_ok = bool(found("price")) and deal.price is not None
        terms_ok = bool(deal.terms_phrases) and len({c["phrase"] for c in found("terms")}) == len(deal.terms_phrases)
        consideration_ok = bool(found("cash")) if deal.consideration == "cash" else terms_ok
        # announcement: the first filing that states the agreed terms (price, payment, buyer with price, or a price
        # agreed before an amendment; a price that was only proposed does not count)
        terms_hits = sorted((c for c in ch if c["hits"] > 0 and (
            c["field"] in ("price", "cash", "terms", "stated_value", "acquirer", "earlier_price:agreed"))),
            key=lambda c: c["first_date"])
        if terms_hits:
            announced, basis, ann_acc = (terms_hits[0]["first_date"],
                                         f"first {terms_hits[0]['first_form']} stating the deal terms",
                                         terms_hits[0]["first_accession"])
        elif a.fallback_announce:
            announced, basis, ann_acc = (a.fallback_announce, "last 8-K item 1.01 before the merger proxy (inferred)",
                                         a.fallback_announce_accession)
        else:
            announced, basis, ann_acc = None, None, None
        if deal.pending and cik not in pending_now:
            log.warning("deal %s is listed as pending but core.company_status no longer says so", deal.key)
        if not deal.pending and a.closed:
            closings.setdefault(cik, []).append((a.closed, deal.key))
        val = (_valuation(conn, cik, deal, announced, price_ok, bool(found("stated_value")))
               if announced and not deal.pending else {})
        doc = docs.get(deal.key, {})
        doc_price, doc_parent = doc.get("price"), doc.get("parent")
        doc_agrees = abs(doc_price - deal.price) < 0.005 if doc_price is not None and deal.price is not None else None
        deal_rows.append((
            deal.key, cik, "pending" if deal.pending else "closed", announced, basis, ann_acc, a.first_proxy,
            a.first_proxy_form, a.first_proxy_accession, a.closed, a.closed_basis, a.closed_accession,
            a.deregistered, (a.closed - announced).days if a.closed and announced else None,
            acquirer_ok, price_ok, consideration_ok, terms_ok, val.get("shares"), val.get("shares_as_of"),
            val.get("book_quarter"), val.get("common_equity"), val.get("preferred"), val.get("bps"), val.get("pb"),
            val.get("implied_value"), val.get("value_basis"), val.get("roe"), val.get("cr"), val.get("npe"),
            doc_price, doc_parent, doc_agrees,
        ))
    conn.execute("delete from core.ma_deal")
    with conn.cursor() as cur:
        cur.executemany(
            "insert into core.ma_deal(key, cik, status, announced, announced_basis, announced_accession, first_proxy,"
            " first_proxy_form, first_proxy_accession, closed, closed_basis, closed_accession, deregistered,"
            " days_to_close, acquirer_verified, price_verified, consideration_verified, terms_verified, shares,"
            " shares_as_of, book_quarter, common_equity, preferred, book_per_share, price_to_book, implied_value,"
            " value_basis, roe_ttm, combined_ratio_ttm, npe_ttm, doc_price, doc_parent, doc_agrees)"
            " values (" + ",".join(["%s"] * 33) + ")",
            deal_rows,
        )
    listings = _listings(conn, closings)
    conn.execute("delete from core.ma_listing")
    with conn.cursor() as cur:
        cur.executemany(
            "insert into core.ma_listing(cik, listed_from, from_basis, listed_until, until_basis, deal_key)"
            " values (%s,%s,%s,%s,%s,%s) on conflict do nothing", listings)
    # 8-K item 5.01 (change in control): those that close a deal, and those of carriers that stayed public
    key_by = {(cik, d): k for cik, lst in closings.items() for d, k in lst}
    events = []
    for cik, d, acc, items in conn.execute(
        "select f.cik, f.filing_date, f.accession, f.items from raw.sec_filing f join ref.company c using (cik)"
        " where c.cohort in ('specialty', 'benchmark') and f.form = '8-K' and f.items like '%%5.01%%'"
        " and f.filing_date >= '2009-01-01' order by f.filing_date"
    ):
        k = next((key_by[(cik, d2)] for d2 in (d, d - timedelta(days=1), d - timedelta(days=2), d + timedelta(days=1))
                  if (cik, d2) in key_by), None)
        later = conn.execute(
            "select 1 from raw.sec_filing where cik = %s and form = any(%s) and filing_date > %s limit 1",
            (cik, list(PERIODIC), d + timedelta(days=100)),
        ).fetchone()
        events.append((cik, d, acc, items, k, k is None and later is not None))
    conn.execute("delete from core.ma_event")
    with conn.cursor() as cur:
        cur.executemany("insert into core.ma_event(cik, filing_date, accession, items, deal_key, stayed_public)"
                        " values (%s,%s,%s,%s,%s,%s)", events)
    activity = _activity(conn)
    conn.execute("delete from core.ma_activity_year")
    with conn.cursor() as cur:
        cur.executemany(
            "insert into core.ma_activity_year(cik, fy, acq_cash, divest_proceeds, goodwill, intangibles, equity,"
            " gi_to_equity, goodwill_acquired, goodwill_impairment, reserves_acquired, n_completions)"
            " values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", activity)
    conn.commit()
    closed = [r for r in deal_rows if r[2] == "closed"]
    summary = {
        "deals": len(deal_rows), "closed": len(closed), "pending": len(deal_rows) - len(closed),
        "acquirer_verified": sum(1 for r in closed if r[14]), "price_verified": sum(1 for r in closed if r[15]),
        "consideration_verified": sum(1 for r in closed if r[16]), "with_closing": sum(1 for r in closed if r[9]),
        "with_pb": sum(1 for r in closed if r[24] is not None), "listings": len(listings), "events": len(events),
        "activity_rows": len(activity), "doc_facts": sum(len(v) for v in docs.values()),
    }
    log.info("ma build: %s", summary)
    return summary


# ---------------------------------------------------------------- export

def _r(v, digits: int = 4):
    if v is None:
        return None
    x = float(v)
    if math.isnan(x) or math.isinf(x):
        return None
    if abs(x) >= 1e5:
        return round(x)
    return float(f"{x:.{digits}g}")


def _d(v) -> str | None:
    return v.isoformat() if v else None


def _best_checks(cik: int, checks: list[dict]) -> list[dict]:
    """One check per field for the page: the phrase with the most matching documents, with a link to the first."""
    best: dict[str, dict] = {}
    for c in checks:
        if c["hits"] > 0 and (c["field"] not in best or c["hits"] > best[c["field"]]["hits"]):
            best[c["field"]] = c
    return [{"field": f, "phrase": c["phrase"], "hits": c["hits"], "first": _d(c["first_date"]),
             "firstForm": c["first_form"], "url": filing_url(cik, c["first_accession"], c["first_file"])}
            for f, c in sorted(best.items())]


def export(conn, write) -> None:
    deals = {d.key: d for d in DEALS}
    names = {r[0]: (r[1], r[2], r[3]) for r in conn.execute("select cik, ticker, short_name, segment from ref.company")}
    checks = _checks(conn)
    out_deals = []
    for r in conn.execute(
        "select key, cik, status, announced, announced_basis, announced_accession, first_proxy, first_proxy_form,"
        " first_proxy_accession, closed, closed_basis, closed_accession, deregistered, days_to_close,"
        " acquirer_verified, price_verified, consideration_verified, terms_verified, shares, shares_as_of,"
        " book_quarter, common_equity, preferred, book_per_share, price_to_book, implied_value, value_basis,"
        " roe_ttm, combined_ratio_ttm, npe_ttm, doc_price, doc_parent, doc_agrees from core.ma_deal order by key"
    ):
        (key, cik, status, ann, ann_basis, ann_acc, proxy, proxy_form, proxy_acc, closed, closed_basis, closed_acc,
         dereg, days, acq_ok, price_ok, cons_ok, terms_ok, shares, shares_as_of, bq, ceq, pref, bps, pb, value,
         value_basis, roe, cr, npe, doc_price, doc_parent, doc_agrees) = r
        d = deals[key]
        ticker, name, segment = names[cik]
        out_deals.append({
            "key": key, "cik": cik, "ticker": ticker, "target": name, "segment": segment, "status": status,
            "acquirer": d.acquirer if acq_ok else (doc_parent if d.pending and doc_parent else None),
            "acquirerType": d.acquirer_type if acq_ok else None,
            "group": d.group if acq_ok and not d.pending else UNKNOWN,
            "consideration": d.consideration if cons_ok else None,
            "price": float(d.price) if price_ok and d.price is not None else None,
            # an earlier price is published only when the filings contain it
            "earlierPrices": [{"price": p, "kind": kind} for p, ph, kind in d.earlier_prices
                              if any(c["phrase"] == ph and c["hits"] > 0 for c in checks.get(key, []))],
            "terms": d.note if d.consideration == "mixed" and terms_ok else None,
            "announced": _d(ann), "announcedBasis": ann_basis, "announcedUrl": filing_url(cik, ann_acc),
            "proxy": _d(proxy), "proxyForm": proxy_form, "proxyUrl": filing_url(cik, proxy_acc),
            "closed": _d(closed), "closedBasis": closed_basis, "closedUrl": filing_url(cik, closed_acc),
            "deregistered": _d(dereg), "days": days,
            "verified": {"acquirer": bool(acq_ok), "price": bool(price_ok), "consideration": bool(cons_ok)},
            "checks": _best_checks(cik, checks.get(key, [])),
            "value": _r(value), "valueBasis": value_basis, "shares": _r(shares), "sharesAsOf": _d(shares_as_of),
            "bookQuarter": _d(bq), "commonEquity": _r(ceq), "preferred": _r(pref), "bookPerShare": _r(bps),
            "pb": _r(pb), "roe": _r(roe), "cr": _r(cr), "npe": _r(npe),
            "doc": ({"price": _r(doc_price), "parent": doc_parent, "agrees": doc_agrees}
                    if doc_price is not None or doc_parent else None),
            "note": d.note or None,
            "pendingForms": None,
        })
    for dd in out_deals:
        if dd["status"] == "pending":
            row = conn.execute("select pending_forms, pending_since from core.company_status where cik = %s",
                               (dd["cik"],)).fetchone()
            if row:
                dd["pendingForms"], dd["pendingSince"] = row[0], _d(row[1])
    # the listed universe at each year-end, with the year's listings and exits
    listings = conn.execute(
        "select cik, listed_from, listed_until, deal_key from core.ma_listing order by cik, listed_from nulls first"
    ).fetchall()
    today = date.today()
    years = list(range(FIRST_YEAR, today.year + 1))
    by_key = {dd["key"]: dd for dd in out_deals}
    count, entries, exits = [], [], []
    for y in years:
        cutoff = date(y, 12, 31) if y < today.year else today
        count.append(sum(1 for _c, f, u, _k in listings if (f is None or f <= cutoff) and (u is None or u > cutoff)))
        entries.append(sorted(c for c, f, _u, _k in listings if f is not None and f.year == y))
        exits.append(sorted(
            ({"cik": c, "deal": k, "group": by_key[k]["group"] if k in by_key else "Stopped reporting"}
             for c, _f, u, k in listings if u is not None and u.year == y), key=lambda e: e["cik"]))
    events = [{"cik": c, "date": _d(d), "items": items, "deal": k, "stayedPublic": sp, "url": filing_url(c, acc)}
              for c, d, acc, items, k, sp in conn.execute(
                  "select cik, filing_date, accession, items, deal_key, stayed_public from core.ma_event"
                  " order by filing_date")]
    ayears = list(range(2009, today.year + 1))
    fields = ("acq", "div", "gw", "intang", "eq", "giEq", "resAcq", "n201")
    series: dict[str, dict[str, list]] = {}
    for row in conn.execute(
        "select cik, fy, acq_cash, divest_proceeds, goodwill, intangibles, equity, gi_to_equity, reserves_acquired,"
        " n_completions from core.ma_activity_year where fy between %s and %s order by cik, fy", (ayears[0], ayears[-1])):
        s = series.setdefault(str(row[0]), {f: [None] * len(ayears) for f in fields})
        i = ayears.index(row[1])
        for f, v in zip(fields, row[2:], strict=True):  # money in USD millions, ratios as fractions
            s[f][i] = v if f == "n201" else _r(v, 3) if f == "giEq" else _r(float(v) / 1e6 if v is not None else None, 4)
    write("ma.json", {
        "version": 1,
        "asOf": today.isoformat(),
        "groups": [*GROUPS, UNKNOWN],
        "deals": out_deals,
        "listed": {"years": years, "count": count, "entries": entries, "exits": exits},
        "events": events,
        "activity": {"years": ayears, "unit": "USD millions (giEq: a fraction of equity; n201: filings)",
                     "series": series},
        "documentsRead": sum(1 for dd in out_deals if dd["doc"]),
    })
