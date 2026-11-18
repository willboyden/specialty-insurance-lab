# Mergers and acquisitions

The deals that took carriers of the universe off the public market, the take-privates pending now, how the
listed universe shrank and grew, and what the carriers bought themselves.

Code: `sil/deals.py` (the curated candidates), `sil/ma.py` (checks, build, export), `sil/sources/deal_docs.py`
(terms read from the deal documents once they are cached). Tables: `ref.ma_deal`, `raw.ma_deal_check`,
`raw.ma_deal_doc_fact`, `core.ma_deal`, `core.ma_listing`, `core.ma_event`, `core.ma_activity_year`
(`db/migrations/009_ma.sql`). Dashboard file: `ma.json`.

```
uv run python -m sil ingest deal_checks     # SEC full-text search checks (cached 30 days)
uv run python -m sil ingest deal_docs       # optional: terms from cached deal documents (never fetches)
uv run python -m sil domains ma             # build the core tables and write ma.json
```

## Sources

| Source | What it gives | Access |
|---|---|---|
| SEC filing index (`raw.sec_filing`, data.sec.gov submissions) | announcement 8-Ks (item 1.01), merger proxies (PREM14A, DEFM14A, PREM14C, DEFM14C), going-private schedules (SC 13E3), tender documents (SC TO-T, SC 14D9), closing 8-Ks (item 5.01, change in control), delistings (Form 25), deregistrations (Form 15), IPO prospectuses (424B4) and exchange registrations (8-A12B) | public, no key |
| SEC full-text search (efts.sec.gov) | whether an exact phrase occurs in a company's filings, in which documents and when | public, no key |
| SEC XBRL company facts (`raw.xbrl_fact`) | cover-page shares outstanding, equity, preferred stock, cash paid for acquisitions, divestiture proceeds, goodwill, intangibles, claim reserves acquired | public, no key |
| SEC filing documents (www.sec.gov Archives, cached by `python -m sil ingest secdocs`) | the merger proxies and press releases themselves | needs `SIL_SEC_USER_AGENT` |

All of it is public SEC data. Nothing is collected from paid deal databases.

## How a deal is verified

`sil/deals.py` lists each deal's candidates: the buyer's name, the price per share, the form of payment, and for
amended deals the price agreed (or only proposed) first. Memory and press coverage are where candidates come from,
never what is published. A field reaches the page only after SEC full-text search finds it in the **target's own
filings** inside the deal window:

- **Buyer:** the buyer's name and the deal price must appear in the *same document*. Full-text search ANDs quoted
  phrases, so `"Tokio Marine" "$78.00 per share"` matches 6 HCC filings and `"Sompo" "$78.00 per share"` none.
  This matters for buyers that already controlled the target (Altaris and Trean, Great American and National
  Interstate): their names appear in every filing, so the name alone proves nothing. Consortium names need every
  member.
- **Price:** the exact phrase, e.g. `"$848.02 per share"`. A wrong candidate finds nothing: Trean's was first
  entered as $7.00 and failed; the filings say $6.15.
- **Form of payment:** variants such as `"$70.00 per share in cash"` or `"$70.00 in cash, without interest"`; for
  stock-and-cash deals, the exchange terms (Alterra: `0.04315` and `$10.00 in cash`; Allied World: `0.030392`,
  `$10.00 in cash`, `$5.00 per share special dividend`).
- **Earlier prices:** an amended agreement's first price (American Safety $29.25 to $30.25, Tower $3.00 to $2.50,
  AmTrust $13.50 to $14.75) and a proposal that preceded the agreement (National Interstate's $30.00).
- **Pending deals** are checked the same way. Bowhead: `"American Family" "$34.00 per share"` in its 8-K of
  3 August 2026 (press release and merger agreement). Accelerant: `"Thoma Bravo" "$20.25 per share"` in its 8-K of
  13 August 2026; its ticking amount (`"$0.00333"` with `"calendar day"`) is in the merger agreement.

Every check is stored in `raw.ma_deal_check` with its hit count and the first matching document, and the dashboard
links to that document. With the deal documents cached, `sil/sources/deal_docs.py` reads the price, the form of
payment, the buyer (the merger agreement's "Parent") and the agreement date from them, and `core.ma_deal.doc_agrees`
records whether they match the search-verified price. Only documents filed from 30 days before the announcement count
(Tower's 2013 merger with Canopius Bermuda is not its 2014 sale to ACP Re), and a "par value $1.00 per share" is never a
price. Read this way, the price most documents state agrees with the search-verified one for 19 of 23 deals; the four
that differ are explained: three amended deals whose first agreed price the documents also state (AmTrust $13.50,
American Safety $29.25, Tower $3.00) and Alleghany, whose $848.02 "represents $850.00 per share less the financial
advisory fee due to Goldman Sachs" (its merger proxy).

## Dates

- **Announced:** the first deal filing that states the agreed terms (any verified price, payment or buyer-and-price
  phrase, or an agreed earlier price; a mere proposal does not count). For pending deals: the last 8-K with item
  1.01 before the first merger proxy, marked as inferred.
- **Closed:** the first closing 8-K (item 5.01, or 2.01 with 3.01 or 3.03) or delisting (Form 25) in the closing
  year's window. A foreign private issuer files no 8-K, so Aspen's 2026 closing is its delisting.
- **Days to close:** closed minus announced.

## Valuation

- **Implied equity value** = price per share × shares outstanding on the last cover page before the announcement
  (`dei:EntityCommonStockSharesOutstanding`; the balance-sheet count when the cover has several share classes). When
  a company listed between that cover and the announcement (Aspen, May 2025), the first cover after the announcement
  is used, because the listing changed the share count. It is a basic share count, so values sit slightly below
  the fully diluted figures announcements quote. Alterra's stock-and-cash deal uses its stated headline value
  ($3.13 billion, found in its deal filings).
- **Price-to-book** = price ÷ (common equity ÷ shares), where common equity is total equity less preferred stock, at the
  last quarter before the announcement. When preferred stock was outstanding (preferred dividends were paid) but its
  value is not in the XBRL facts, no multiple is published (Aspen 2019).
- **Several share classes:** when neither the cover page nor the balance sheet has a single share count (the classes are
  counted only in dimensional facts), the last quarter's weighted-average basic shares are used, which cover every
  class (Accelerant, 2026).
- **Pending deals** get the same multiple, at the agreed price and the last quarter before the announcement. The page
  draws a pending deal on the price-to-book chart only inside the closed deals' ranges: Accelerant (6.2× book, a
  trailing ROE of −244% after a $1.37 billion net loss in Q3 2025, the quarter it listed) is named in the caption
  instead.
- **Target ROE and combined ratio:** trailing four quarters at that quarter (`core.company_quarter`).

## Listed universe

A specialty carrier is listed from its IPO (424B4 within about ten months before or after its first periodic report;
else its exchange registration or registration statement), or from before 2008, until a deal closes or the stock is
delisted without one. A relisting is the first 424B4 after a deal took the company private (Aspen, 2025). The counts
describe this hand-selected universe, not every US-listed carrier.

## Acquisitions by the carriers

Per company and fiscal year, from the 10-K XBRL facts: cash paid for acquisitions
(`PaymentsToAcquireBusinessesNetOfCashAcquired`, else the gross or affiliate variants, net of the cash the targets
held, so a year can be negative), divestiture proceeds, goodwill, other intangibles, claim reserves acquired, and the
number of 8-Ks with item 2.01 (completed acquisition or disposition). Values implausible against the company's own
balance sheet are dropped as tagging errors: cash paid above 1.5× equity, or reserves acquired above the company's
own reserves (HCC's 2012 fact is tagged $14.7 billion).

## Caveats

- The universe is hand-selected and was discovered from XBRL premium tags (2008 on), so carriers acquired before
  they filed XBRL (smaller filers joined in 2011) are under-represented. Its deals close from 2013 on.
- Buyer groups are a classification of the verified buyer: US insurer (including reciprocals), Japanese insurer, other
  non-US insurer (Europe, Canada, Bermuda, China), private capital (private equity, alternative-capital reinsurers,
  family buy-outs).
- Change-of-control 8-Ks (item 5.01) of carriers that stayed listed are listed with links only: the item also covers
  reorganizations and new controlling holders, and the filing text says which.
- Pending deals can still change or fail: the page shows them as pending (dashed) and keeps them out of every
  closed-deal statistic.
