"""SEC filing documents (www.sec.gov/Archives): what each selected filing contains, and the documents the
analyses read, fetched once and kept in the on-disk cache.

www.sec.gov serves only clients that declare a name and contact email (SEC's fair-access rule): set
SIL_SEC_USER_AGENT in .env. The fetcher sends it to SEC hosts only and shares one 8-requests-per-second
budget across every process of this project.

Selected filings (specialty and benchmark carriers):
  annual    10-K, 10-K405, 10-KT, 20-F, 40-F   primary document (headcount, technology text) and the XBRL
                                               instance (loss triangles, claim counts, dimensional facts)
  earnings  8-K with item 2.02                 press-release exhibits EX-99.* (quarterly catastrophe losses)
  deal      8-K with item 1.01, 2.01 or 5.01   the 8-K itself and its EX-99.* (deal announcements, closings)
  merger    PREM14A, DEFM14A, PREM14C, DEFM14C, SC 13E3, SC TO-T, SC 14D9, S-4   the primary document
"""

from __future__ import annotations

import html
import logging
import re
from html.parser import HTMLParser

from ..db import copy_rows, ingest_run
from ..http import Fetcher, FetchError

log = logging.getLogger(__name__)

ARCHIVES = "https://www.sec.gov/Archives/edgar/data"
ANNUAL_FORMS = ("10-K", "10-K405", "10-KT", "20-F", "40-F")
MERGER_FORMS = ("PREM14A", "DEFM14A", "PREM14C", "DEFM14C", "SC 13E3", "SC TO-T", "SC 14D9", "S-4")
KIND_ORDER = ("annual", "merger", "deal", "earnings")
MAX_BYTES = {"annual": 60_000_000, "merger": 60_000_000, "deal": 15_000_000, "earnings": 25_000_000}

SELECT_FILINGS = """
select f.accession, f.cik, f.form, f.filing_date, f.items,
  case
    when f.form = any(%(annual)s) then 'annual'
    when f.form = any(%(merger)s) then 'merger'
    when f.form = '8-K' and f.items like '%%2.02%%' then 'earnings'
    when f.form = '8-K' and (f.items like '%%1.01%%' or f.items like '%%2.01%%' or f.items like '%%5.01%%') then 'deal'
  end as kind
from raw.sec_filing f join ref.company c using (cik)
where c.cohort in ('specialty', 'benchmark')
"""


def index_url(cik: int, accession: str) -> str:
    return f"{ARCHIVES}/{cik}/{accession.replace('-', '')}/{accession}-index.htm"


class _IndexParser(HTMLParser):
    """Rows of the 'tableFile' tables on a filing index page: Seq, Description, Document, Type, Size."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows: list[dict] = []
        self._in_table = False
        self._row: list[str] | None = None
        self._href: str | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table" and "tablefile" in (a.get("class") or "").lower():
            self._in_table = True
        elif self._in_table and tag == "tr":
            self._row, self._href = [], None
        elif self._in_table and tag == "td" and self._row is not None:
            self._cell = []
        elif self._in_table and tag == "a" and self._cell is not None and a.get("href"):
            self._href = a["href"]

    def handle_endtag(self, tag):
        if tag == "table":
            self._in_table = False
        elif tag == "td" and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if len(self._row) >= 5 and self._href:
                href = self._href
                href = href.removeprefix("/ix?doc=")
                size = re.sub(r"\D", "", self._row[4])
                self.rows.append({
                    "seq": int(self._row[0]) if self._row[0].isdigit() else None,
                    "description": self._row[1] or None,
                    "filename": href.rsplit("/", 1)[-1],
                    "url": "https://www.sec.gov" + href if href.startswith("/") else href,
                    "doc_type": self._row[3] or None,
                    "size_bytes": int(size) if size else None,
                })
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def parse_index(page: str) -> list[dict]:
    p = _IndexParser()
    p.feed(page)
    return p.rows


def wanted(kind: str, form: str, doc: dict) -> bool:
    """Which documents of a filing the analyses read."""
    t = (doc["doc_type"] or "").upper()
    name = doc["filename"].lower()
    if (doc["size_bytes"] or 0) > MAX_BYTES[kind]:
        return False
    if kind == "annual":
        return t == form.upper() or t == "EX-101.INS" or (t == "XML" and name.endswith("_htm.xml"))
    if kind == "earnings":
        return t.startswith("EX-99")
    if kind == "deal":
        return t == "8-K" or t.startswith("EX-99")
    if kind == "merger":
        return t == form.upper()
    return False


def ingest_index(conn, fetcher: Fetcher, kinds: tuple[str, ...] = KIND_ORDER) -> int:
    """Read the index page of every selected filing not read yet; record its documents."""
    with ingest_run(conn, "sec_document_index") as info:
        done = {r[0] for r in conn.execute("select accession from raw.sec_document_index")}
        filings = [r for r in conn.execute(SELECT_FILINGS, {"annual": list(ANNUAL_FORMS), "merger": list(MERGER_FORMS)})
                   if r[5] in kinds and r[0] not in done]
        filings.sort(key=lambda r: (KIND_ORDER.index(r[5]), r[3]), reverse=False)
        log.info("filing index pages to read: %d", len(filings))
        n_docs = failed = 0
        for i, (acc, cik, form, _fdate, _items, kind) in enumerate(filings, 1):
            try:
                body = fetcher.get(index_url(cik, acc), allow_404=True)
            except FetchError as exc:
                failed += 1
                log.warning("index %s: %s", acc, exc)
                continue
            docs = parse_index(body.decode("utf-8", "replace")) if body else []
            seen: set[str] = set()
            rows = []
            for d in docs:
                if d["filename"] in seen:
                    continue
                seen.add(d["filename"])
                rows.append((acc, cik, kind, d["seq"], d["description"], d["filename"], d["doc_type"],
                             d["size_bytes"], d["url"]))
            conn.execute("delete from raw.sec_document where accession = %s", (acc,))
            copy_rows(conn, "raw.sec_document",
                      ("accession", "cik", "kind", "seq", "description", "filename", "doc_type", "size_bytes", "url"),
                      rows)
            conn.execute(
                "insert into raw.sec_document_index(accession, cik, kind, n_documents) values (%s,%s,%s,%s)"
                " on conflict (accession) do update set n_documents = excluded.n_documents, read_at = now()",
                (acc, cik, kind, len(rows)),
            )
            n_docs += len(rows)
            if i % 200 == 0:
                conn.commit()
                log.info("index pages read: %d / %d (documents listed %d, failed %d)", i, len(filings), n_docs, failed)
        conn.commit()
        info["rows"] = n_docs
        info["detail"] = {"filings": len(filings), "failed": failed}
        return n_docs


def documents_to_fetch(conn, kinds: tuple[str, ...] = KIND_ORDER) -> list[tuple]:
    rows = conn.execute(
        """select d.url, d.kind, f.form, d.doc_type, d.filename, d.size_bytes, f.filing_date
           from raw.sec_document d join raw.sec_filing f using (accession)
           where d.kind = any(%s)""",
        (list(kinds),),
    ).fetchall()
    keep = [r for r in rows if wanted(r[1], r[2], {"doc_type": r[3], "filename": r[4], "size_bytes": r[5]})]
    # XBRL instances first (claims triangles), then everything else by kind, newest first
    keep.sort(key=lambda r: (0 if (r[3] or "").upper() in ("EX-101.INS", "XML") else 1, KIND_ORDER.index(r[1]),
                             -r[6].toordinal()))
    return keep


def fetch_documents(conn, fetcher: Fetcher, kinds: tuple[str, ...] = KIND_ORDER) -> dict:
    with ingest_run(conn, "sec_documents") as info:
        docs = documents_to_fetch(conn, kinds)
        total_bytes = failed = 0
        log.info("documents to have in cache: %d (%.1f GB listed)", len(docs),
                 sum(r[5] or 0 for r in docs) / 1e9)
        for i, (url, *_rest) in enumerate(docs, 1):
            try:
                body = fetcher.get(url, allow_404=True)
                total_bytes += len(body or b"")
            except FetchError as exc:
                failed += 1
                log.warning("document %s: %s", url, exc)
            if i % 250 == 0:
                log.info("documents: %d / %d (%.2f GB, network %d, cache %d, failed %d)", i, len(docs),
                         total_bytes / 1e9, fetcher.network_requests, fetcher.cache_hits, failed)
        info["rows"] = len(docs) - failed
        info["detail"] = {"documents": len(docs), "failed": failed, "bytes": total_bytes}
        return info["detail"]


# ---------------------------------------------------------------- text helpers for the extractors

class _TextParser(HTMLParser):
    """HTML (including inline XBRL) to plain text: drops scripts, styles, the hidden ix:header block and
    display:none sections; keeps block boundaries as newlines and table cells as ' | '."""

    BLOCK = frozenset({"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section"})
    SKIP = frozenset({"script", "style", "ix:header", "head", "title"})

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._skip = 0
        self._hidden: list[bool] = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.SKIP:
            self._skip += 1
            return
        style = (dict(attrs).get("style") or "").replace(" ", "").lower()
        if tag in ("div", "span", "p", "table"):
            hidden = "display:none" in style
            self._hidden.append(hidden)
            if hidden:
                self._skip += 1
        if tag in self.BLOCK:
            self.out.append("\n")
        elif tag in ("td", "th"):
            self.out.append(" | ")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
            return
        if tag in ("div", "span", "p", "table") and self._hidden and self._hidden.pop():
            self._skip = max(0, self._skip - 1)
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def html_to_text(raw: bytes | str) -> str:
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    if "<html" not in text[:5000].lower() and "<document" not in text[:5000].lower() and "<p" not in text[:20000].lower():
        return html.unescape(text)  # plain-text filing (1990s-2000s)
    p = _TextParser()
    try:
        p.feed(text)
    except (ValueError, AssertionError):  # malformed markup: fall back to a crude tag strip
        return html.unescape(re.sub(r"<[^>]+>", " ", text))
    out = "".join(p.out).replace("\xa0", " ")
    out = re.sub(r"[ \t\r\f\v]+", " ", out)
    out = re.sub(r" *\n[ \n]*", "\n", out)
    return out


def document_text(fetcher: Fetcher, url: str) -> str | None:
    """Plain text of a cached document (fetches it if it is not cached yet)."""
    body = fetcher.get(url, allow_404=True)
    return html_to_text(body) if body else None
