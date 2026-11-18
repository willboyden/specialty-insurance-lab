"""Deal terms read from the deal documents themselves: merger proxies, going-private schedules and the 8-K press
releases that announce or close a deal.

The main pipeline fetches those documents (python -m sil ingest secdocs, which needs SIL_SEC_USER_AGENT); this
module NEVER fetches: a document that is not in the on-disk cache is skipped. Run it after secdocs:

  python -m sil ingest deal_docs && python -m sil domains ma

Per document it extracts the price per share offered, the form of payment, the buyer (the merger agreement's
"Parent") and the date of the merger agreement, each with the sentence it came from. sil/ma.py cross-checks
them against the curated list (sil/deals.py) and uses the buyer of a pending deal once a proxy names it.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from datetime import date, datetime, timedelta

from ..db import ingest_run
from ..http import Fetcher
from .sec_docs import html_to_text

log = logging.getLogger(__name__)

DEAL_FORMS = ("PREM14A", "DEFM14A", "PREM14C", "DEFM14C", "SC 13E3", "SC 13E3/A", "SC TO-T", "SC 14D9", "8-K",
              "6-K")
_PRICE = re.compile(
    r"\$\s?(\d{1,4}(?:,\d{3})*\.\d{2})\s+(in\s+cash\s+)?per\s+(?:issued\s+and\s+outstanding\s+)?"
    r"(?:common\s+|ordinary\s+)?share(?:s)?(,?\s+in\s+cash)?",
    re.IGNORECASE,
)
_DEAL_CONTEXT = re.compile(
    r"merger consideration|offer price|will receive|would receive|entitled to receive|converted into the right|"
    r"right to receive|to acquire|will be acquired|agreed to acquire|purchase price|per share in cash",
    re.IGNORECASE,
)
_STOCK = re.compile(r"exchange ratio|shares? of (?:the )?[A-Z][\w&.\- ]{1,60}? (?:common stock|ordinary shares)",
                    re.IGNORECASE)
# a company name: capitalized tokens only ("Tokio Marine Holdings, Inc.", "Evergreen Parent, L.P."), so a date or a
# clause ("December 15, 2022, by and among ...") can never pass for one
_NAME = r"((?:[A-Z][A-Za-z0-9&.'\-]*,?)(?: (?:[A-Z][A-Za-z0-9&.'\-]*|&),?){0,7})"
_PARENT = [
    re.compile(_NAME + r",?\s+(?:an?|the)\s+[A-Za-z .,\-]{2,80}?\s*\((?:the\s+)?[\"“”]Parent[\"“”]\)"),
    re.compile(r"(?:by and among|among|between)\s+" + _NAME + r"\s*\((?:the\s+)?[\"“”]Parent[\"“”]\)"),
    re.compile(r"definitive (?:merger )?agreement (?:under which|pursuant to which|with)\s+" + _NAME
               + r",?\s+(?:will acquire|has agreed to acquire|to acquire|would acquire)"),
    re.compile(_NAME + r"\s+(?:has agreed to acquire|will acquire|to acquire)\s+(?:all of the outstanding|the outstanding)"),
]
_AGREEMENT_DATE = re.compile(r"Agreement and Plan of Merger,?\s+dated as of\s+([A-Za-z]+ \d{1,2}, \d{4})",
                             re.IGNORECASE)
_BAD_NAMES = {"the company", "company", "we", "the merger", "merger sub", "parent", "the parties"}
# an entity suffix alone is not a name ("... Holdings LLC" cut down to "LLC")
_SUFFIX_ONLY = re.compile(r"^(?:company,?\s+)?(?:llc|l\.?l\.?c|inc|ltd|limited|l\.?p|lp|corp|corporation|plc|s\.?a|n\.?v|co)$",
                          re.IGNORECASE)


def _snippet(text: str, start: int, end: int, pad: int = 140) -> str:
    return " ".join(text[max(0, start - pad):min(len(text), end + pad)].split())


_ABBREV = re.compile(r"(?:Inc|Ltd|Co|Corp|L\.P|N\.A|U\.S|No|S\.A|plc)\.$")


def _sentence(text: str, start: int, end: int) -> str:
    """The sentence around a match (a period followed by a space ends one, unless it closes 'Inc.', 'Ltd.' ...)."""
    a = start
    while True:
        a = text.rfind(". ", max(0, start - 400), a)
        if a < 0 or not _ABBREV.search(text[max(0, a - 4):a + 1]):
            break
    b = end
    while True:
        b = text.find(". ", b, end + 300)
        if b < 0 or not _ABBREV.search(text[max(0, b - 4):b + 1]):
            break
        b += 2
    return text[(a + 2 if a >= 0 else max(0, start - 400)):(b + 1 if b >= 0 else end + 300)]


def _clean_name(name: str) -> str | None:
    n = " ".join(name.split()).strip(" ,.;:")
    n = re.sub(r"^(?:and|by|with|among|between|the\s+company,|company,)\s+", "", n, flags=re.IGNORECASE)
    if len(n) < 3 or n.lower() in _BAD_NAMES or _SUFFIX_ONLY.match(n) or not re.search(r"[A-Za-z]{2}", n):
        return None
    return n


def extract(text: str) -> dict:
    """Price per share, form of payment, buyer and agreement date from one document's text.

    Returns {"price": float|None, "prices": {price: count}, "consideration": "cash"|"stock"|"mixed"|None,
             "parent": str|None, "agreement_date": date|None, "snippets": {field: sentence}}.
    """
    text = " ".join(text.split())  # one line: phrases wrap anywhere in filings
    out: dict = {"price": None, "prices": {}, "consideration": None, "parent": None, "agreement_date": None,
                 "snippets": {}}
    prices: Counter = Counter()
    cash_hits = 0
    first_at: dict[float, tuple[int, int]] = {}
    for m in _PRICE.finditer(text):
        # "each common share, par value $1.00 per share" is the par value, not a price
        if re.search(r"par\s+value\s*(?:of\s*)?$", text[max(0, m.start() - 20):m.start()], re.IGNORECASE):
            continue
        if not _DEAL_CONTEXT.search(_sentence(text, m.start(), m.end())):
            continue
        value = float(m.group(1).replace(",", ""))
        if not 0.5 <= value <= 5000:
            continue
        prices[value] += 1
        first_at.setdefault(value, (m.start(), m.end()))
        if m.group(2) or m.group(3) or re.search(r"in cash", text[m.end():m.end() + 40], re.IGNORECASE):
            cash_hits += 1
    if prices:
        best = max(prices.items(), key=lambda kv: (kv[1], kv[0]))[0]
        out["price"] = best
        out["prices"] = dict(prices)
        out["snippets"]["price"] = _snippet(text, *first_at[best])
        stock = bool(_STOCK.search(text[max(0, first_at[best][0] - 600):first_at[best][1] + 600]))
        out["consideration"] = "mixed" if (stock and cash_hits) else "stock" if stock else "cash" if cash_hits else None
    for pat in _PARENT:
        m = pat.search(text)
        if m:
            name = _clean_name(m.group(1))
            if name:
                out["parent"] = name
                out["snippets"]["parent"] = _snippet(text, m.start(), m.end())
                break
    m = _AGREEMENT_DATE.search(text)
    if m:
        try:
            out["agreement_date"] = datetime.strptime(m.group(1).title(), "%B %d, %Y").date()
            out["snippets"]["agreement_date"] = _snippet(text, m.start(), m.end())
        except ValueError:
            pass
    return out


def _cached(fetcher: Fetcher, url: str) -> bool:
    body, meta = fetcher._paths(url)  # the fetcher's own cache layout: never trigger a request from here
    return body.exists() and meta.exists()


def ingest(conn, fetcher: Fetcher) -> None:
    """Extract deal terms from every cached deal document of the deals in sil/deals.py."""
    from ..deals import DEALS

    ciks = dict(conn.execute("select ticker, cik from ref.company"))
    with ingest_run(conn, "ma_deal_docs") as info:
        rows, read, skipped = [], 0, 0
        for deal in DEALS:
            cik = ciks[deal.ticker]
            lo = date(deal.close_year - 2, 1, 1) if not deal.pending else date(date.today().year - 1, 1, 1)
            hi = date(deal.close_year, 12, 31) if not deal.pending else date.today()
            docs = conn.execute(
                "select d.accession, d.filename, d.url, f.form from raw.sec_document d"
                " join raw.sec_filing f using (accession)"
                " where d.cik = %s and d.kind in ('merger', 'deal') and f.filing_date between %s and %s"
                " and f.form = any(%s) order by f.filing_date",
                (cik, lo, hi, list(DEAL_FORMS)),
            ).fetchall()
            for acc, filename, url, _form in docs:
                if not _cached(fetcher, url):
                    skipped += 1
                    continue
                body = fetcher.get(url, allow_404=True)
                if not body:
                    continue
                read += 1
                got = extract(html_to_text(body))
                if got["price"] is not None:
                    rows.append((deal.key, acc, filename, "price", f"{got['price']:.2f}", got["price"],
                                 got["snippets"].get("price")))
                if got["consideration"]:
                    rows.append((deal.key, acc, filename, "consideration", got["consideration"], None,
                                 got["snippets"].get("price")))
                if got["parent"]:
                    rows.append((deal.key, acc, filename, "parent", got["parent"], None,
                                 got["snippets"].get("parent")))
                if got["agreement_date"]:
                    rows.append((deal.key, acc, filename, "agreement_date", got["agreement_date"].isoformat(), None,
                                 got["snippets"].get("agreement_date")))
        conn.execute("delete from raw.ma_deal_doc_fact")
        with conn.cursor() as cur:
            cur.executemany(
                "insert into raw.ma_deal_doc_fact(deal_key, accession, filename, field, value_text, value_num, snippet)"
                " values (%s,%s,%s,%s,%s,%s,%s) on conflict do nothing", rows)
        conn.commit()
        info["rows"] = len(rows)
        info["detail"] = {"documents_read": read, "not_cached": skipped}
        log.info("deal documents: %d read, %d not cached yet, %d facts", read, skipped, len(rows))


def facts_by_deal(conn, since: dict[str, date] | None = None) -> dict[str, dict]:
    """Per deal: the price most documents state, the buyer the proxies name, the form of payment.

    since: per deal, the announcement date; documents filed more than 30 days before it belong to an earlier deal
    of the same company (Tower's 2013 merger with Canopius Bermuda before ACP Re's 2014 buy-out)."""
    exists = conn.execute("select to_regclass('raw.ma_deal_doc_fact') is not null").fetchone()[0]
    if not exists:
        return {}
    out: dict[str, dict] = {}
    rows = conn.execute(
        "select x.deal_key, x.field, x.value_text, f.filing_date from raw.ma_deal_doc_fact x"
        " join raw.sec_filing f using (accession)").fetchall()
    counts: Counter = Counter()
    for key, field, value_text, filed in rows:
        start = (since or {}).get(key)
        if start is not None and filed < start - timedelta(days=30):
            continue
        counts[(key, field, value_text)] += 1
    for (key, field, value_text), n in sorted(counts.items(), key=lambda kv: (kv[0][0], kv[0][1], -kv[1])):
        d = out.setdefault(key, {})
        if field in d:
            continue
        d[field] = float(value_text) if field == "price" else value_text
        d[f"{field}_docs"] = n
    return out
