"""Catastrophe losses that carriers report in their quarterly earnings releases (8-K item 2.02, EX-99.* exhibits).

Reads only documents already in the on-disk cache (the main pipeline downloads them with
`python -m sil ingest secdocs`, which needs a declared SEC contact); it never requests www.sec.gov itself.

Per release:
  1. candidates: sentences that state an amount ("catastrophe losses of $45.2 million", "$1.1 billion of net
     catastrophe losses"), combined-ratio points ("catastrophe losses added 5.3 points"), and table rows whose
     label is a catastrophe-loss line (first number = the current period; units from the nearest
     "in thousands / in millions" header)
  2. scope: quarter, year to date, full year or unknown, from the words nearest the amount
  3. choice: a quarter-scope sentence amount, else an unknown-scope sentence amount, else the table value; the
     full-year figure of a fourth-quarter release is kept to derive Q4 when the release states no quarter figure
  4. plausibility: at most 1.5x the quarter's net premiums earned and at most its total incurred losses
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date, timedelta

from .sec_docs import html_to_text

log = logging.getLogger(__name__)

UNIT = {"thousand": 1e3, "thousands": 1e3, "million": 1e6, "millions": 1e6, "mm": 1e6, "m": 1e6, "billion": 1e9,
        "billions": 1e9, "bn": 1e9, "b": 1e9}
_NUM = r"(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
_UNIT = r"(thousands?|millions?|billions?|mm|bn|m|b)\b"
CAT = r"(?:net\s+|pre-?tax\s+|after-?tax\s+|current[- ]accident[- ]year\s+|natural\s+|reported\s+|gross\s+)*catastrophe\s+loss(?:es)?"

# amount after the phrase: "catastrophe losses, net of reinsurance, of $45.2 million"
_AFTER = re.compile(CAT + r"(?P<mid>[^$.;]{0,120}?)\$\s?" + _NUM + r"\s*" + _UNIT, re.IGNORECASE)
# amount before the phrase: "$1.1 billion of net catastrophe losses", "included $12 million in catastrophe losses"
_BEFORE = re.compile(r"\$\s?" + _NUM + r"\s*" + _UNIT + r"(?P<mid>\s+(?:of|in|from|related\s+to)\s+(?:[a-z-]+\s+){0,3}?)"
                     + CAT, re.IGNORECASE)
# combined-ratio points: "catastrophe losses ... 5.3 points", "5.3 points of catastrophe losses"
_POINTS_AFTER = re.compile(CAT + r"[^.;$]{0,90}?(\d{1,2}(?:\.\d+)?)\s+(?:percentage\s+)?points?\b", re.IGNORECASE)
_POINTS_BEFORE = re.compile(r"(\d{1,2}(?:\.\d+)?)\s+(?:percentage\s+)?points?\s+(?:of|from|related\s+to)\s+" + CAT, re.IGNORECASE)
_NONE = re.compile(r"\bno\s+(?:significant\s+|material\s+|notable\s+)?" + CAT, re.IGNORECASE)
# table rows: "Catastrophe losses | $ | 123.4 | | $ | 56.7 |"
_ROW = re.compile(r"^\s*(?:\|\s*)*(?:net\s+|pre-?tax\s+|current[- ]accident[- ]year\s+)?catastrophe\s+loss(?:es)?"
                  r"(?:\s*,\s*net(?:\s+of\s+[a-z ]+)?)?\s*(?:\(\d\)\s*)?\|(?P<cells>.*)$", re.IGNORECASE | re.MULTILINE)
_TABLE_UNIT = re.compile(r"(?:in|\$\s*in|dollars\s+in|amounts\s+in)\s+(thousands|millions|billions)", re.IGNORECASE)

_YTD = re.compile(r"nine\s+months|six\s+months|first\s+half|year[- ]to[- ]date|first\s+(?:three|nine)\s+quarters"
                  r"|through\s+(?:june|september)\s+30", re.IGNORECASE)
_YEAR = re.compile(r"full[- ]year|for\s+the\s+(?:full\s+)?year|twelve\s+months|calendar\s+year|for\s+(?:fiscal\s+)?20\d\d\b"
                   r"|year\s+ended", re.IGNORECASE)
_QUARTER = re.compile(r"quarter|three\s+months|\bq[1-4]\b", re.IGNORECASE)


@dataclass
class Candidate:
    kind: str      # 'amount' (USD) or 'points' (combined-ratio points)
    value: float
    scope: str     # quarter | ytd | year | unknown
    source: str    # sentence | table | none
    snippet: str
    pos: int


def _money(num: str, unit: str) -> float | None:
    mult = UNIT.get(unit.lower())
    if mult is None:
        return None
    return float(num.replace(",", "")) * mult


def _sentence(text: str, start: int, end: int) -> tuple[int, int]:
    """Bounds of the sentence around [start, end): breaks at '. ' + capital, ';' and newlines."""
    left = max(text.rfind("\n", 0, start), text.rfind(". ", 0, start), text.rfind(";", 0, start))
    right_candidates = [i for i in (text.find("\n", end), text.find(". ", end), text.find(";", end)) if i >= 0]
    right = min(right_candidates) if right_candidates else len(text)
    return left + 1, right


def scope_of(text: str, start: int, end: int) -> str:
    """The period an amount refers to: the qualifying words nearest to it in its sentence."""
    s0, s1 = _sentence(text, start, end)
    before = text[s0:start]
    after = text[end:s1]
    best = ("unknown", 10**9)
    for scope, rx in (("ytd", _YTD), ("year", _YEAR), ("quarter", _QUARTER)):
        for m in rx.finditer(before):
            d = len(before) - m.end()
            if d < best[1]:
                best = (scope, d)
        for m in rx.finditer(after[:80]):
            d = m.start() + 40  # words after the amount count, but less than words before it
            if d < best[1]:
                best = (scope, d)
    return best[0]


_PERIOD = re.compile(r"(three\s+months|quarter|nine\s+months|six\s+months|twelve\s+months|year)\s+ended", re.IGNORECASE)


def table_scope(text: str, pos: int) -> str:
    """The period of a table's first number column: the leftmost period header ('Three months ended ...') on the
    nearest header line above the row."""
    for line in reversed(text[max(0, pos - 2500):pos].split("\n")):
        hits = list(_PERIOD.finditer(line))
        if hits:
            w = hits[0].group(1).lower()
            if w.startswith(("three", "quarter")):
                return "quarter"
            if w.startswith(("nine", "six")):
                return "ytd"
            return "year"
    return "unknown"


def table_unit(text: str, pos: int) -> float | None:
    """The 'in thousands / in millions' header closest above a table row (within 4,000 characters)."""
    window = text[max(0, pos - 4000):pos]
    found = list(_TABLE_UNIT.finditer(window))
    if not found:
        return None
    return UNIT[found[-1].group(1).lower()]


def _numbers(cells: str) -> list[float]:
    out = []
    for c in cells.split("|"):
        c = c.strip().replace("$", "").strip()
        if not c or c in ("—", "–", "-"):
            continue
        neg = c.startswith("(") and c.endswith(")")
        c = c.strip("()").replace(",", "").strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", c):
            out.append(-float(c) if neg else float(c))
        elif c.endswith("%") or re.fullmatch(r"\(?\d+(?:\.\d+)?\)?\s*%", c):
            continue
    return out


def extract(text: str) -> list[Candidate]:
    """Every catastrophe-loss figure stated in a release, in document order."""
    t = re.sub(r"[ \t ]+", " ", text)
    out: list[Candidate] = []
    for rx in (_AFTER, _BEFORE):
        for m in rx.finditer(t):
            num, unit = (m.group(1), m.group(2)) if rx is _BEFORE else (m.group(2), m.group(3))
            mid = m.group("mid") or ""
            if rx is _AFTER and re.search(r"\b(excluding|excludes|exclusive of|ex-?cat|compared|versus|vs\.?)\b", mid, re.IGNORECASE):
                continue
            v = _money(num, unit)
            if v is None:
                continue
            s0, s1 = _sentence(t, m.start(), m.end())
            out.append(Candidate("amount", v, scope_of(t, m.start(), m.end()), "sentence",
                                 t[s0:s1].strip()[:400], m.start()))
    for rx in (_POINTS_AFTER, _POINTS_BEFORE):
        for m in rx.finditer(t):
            v = float(m.group(1))
            if v > 60:
                continue
            s0, s1 = _sentence(t, m.start(), m.end())
            out.append(Candidate("points", v, scope_of(t, m.start(), m.end()), "sentence", t[s0:s1].strip()[:400],
                                 m.start()))
    for m in _NONE.finditer(t):
        s0, s1 = _sentence(t, m.start(), m.end())
        out.append(Candidate("amount", 0.0, scope_of(t, m.start(), m.end()), "none", t[s0:s1].strip()[:400], m.start()))
    for m in _ROW.finditer(t):
        nums = _numbers(m.group("cells"))
        if not nums:
            continue
        unit = table_unit(t, m.start())
        first = nums[0]
        if unit is None:
            unit = 1e3 if first >= 10_000 else 1e6
        line = t[m.start():t.find("\n", m.start()) if t.find("\n", m.start()) > 0 else len(t)]
        out.append(Candidate("amount", first * unit, table_scope(t, m.start()), "table", line.strip()[:400], m.start()))
    # one candidate per (kind, position): the patterns can overlap on the same words
    seen: set[tuple] = set()
    uniq = []
    for c in sorted(out, key=lambda c: c.pos):
        key = (c.kind, round(c.value, 2), c.pos // 60)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(c)
    return uniq


def choose(cands: list[Candidate], quarter_end: date) -> dict:
    """The quarter's figure from one release's candidates, in order of preference: a sentence about the quarter,
    'no catastrophe losses' about the quarter, a table column headed by the quarter, a sentence with no period
    words (not when the same amount is also stated as the year's), a table without a period header (not in
    fourth-quarter releases, whose first column may be the year).

    Returns {'quarter': Candidate|None, 'year': Candidate|None, 'points': Candidate|None}.
    """
    amounts = [c for c in cands if c.kind == "amount"]
    q4 = quarter_end.month == 12
    year = next((c for c in amounts if c.scope == "year" and c.source in ("sentence", "table")), None)
    year_values = {round(c.value, 2) for c in amounts if c.scope == "year"}
    prefs = [
        lambda c: c.source == "sentence" and c.scope == "quarter",
        lambda c: c.source == "none" and c.scope == "quarter",
        lambda c: c.source == "table" and c.scope == "quarter",
        lambda c: c.source == "sentence" and c.scope == "unknown" and round(c.value, 2) not in year_values,
        lambda c: c.source == "table" and c.scope == "unknown" and not q4,
    ]
    pick = None
    for pref in prefs:
        hit = [c for c in amounts if pref(c)]
        if hit:
            pick = hit[0]
            break
    pts = next((c for c in cands if c.kind == "points" and c.scope in ("quarter", "unknown")), None)
    return {"quarter": pick, "year": year if q4 else None, "points": pts}


def quarter_for_filing(filed: date) -> date | None:
    """The calendar quarter an earnings release reports: the latest quarter end before the filing date (within
    120 days; releases come 3-10 weeks after the quarter)."""
    y, m = filed.year, filed.month
    q_month = ((m - 1) // 3) * 3  # the month that ended the previous quarter
    q_end = date(y - 1, 12, 31) if q_month == 0 else (date(y, q_month + 1, 1) - timedelta(days=1))
    if q_end >= filed:
        return None
    return q_end if (filed - q_end).days <= 120 else None


def plausible(value: float, npe_q: float | None, losses_q: float | None) -> bool:
    """A quarter's catastrophe losses cannot be negative, above 1.5x its net premiums earned, or above its total
    incurred losses (2% slack for rounding); with neither known, at most $5bn."""
    if value < 0:
        return False
    if npe_q is not None and npe_q > 0 and value > 1.5 * npe_q:
        return False
    if losses_q is not None and losses_q > 0 and value > 1.02 * losses_q:
        return False
    return npe_q is not None or losses_q is not None or value <= 5e9


def derive_q4(year_total: float | None, q1: float | None, q2: float | None, q3: float | None) -> float | None:
    if year_total is None or None in (q1, q2, q3):
        return None
    v = year_total - (q1 + q2 + q3)
    return v if v >= 0 else None


def cached_body(fetcher, url: str) -> bytes | None:
    """The cached document, or None when it is not in the cache (never a network request)."""
    import json

    body_path, meta_path = fetcher._paths(url)
    if not (body_path.exists() and meta_path.exists()):
        return None
    if json.loads(meta_path.read_text()).get("status") != 200:
        return None
    return body_path.read_bytes()


def run(conn, fetcher) -> dict:
    """Extract every cached earnings release; write core.cat_loss_reported. Returns counts."""
    docs = conn.execute(
        """select d.cik, d.accession, d.url, d.doc_type, f.filing_date
           from raw.sec_document d join raw.sec_filing f using (accession)
           where d.kind = 'earnings' and d.doc_type like 'EX-99%%'
           order by d.cik, f.filing_date, d.doc_type"""
    ).fetchall()
    fin = {(r[0], r[1]): (r[2], r[3]) for r in conn.execute(
        "select cik, qend, npe, losses from core.company_quarter where npe is not null")}
    found: dict[tuple, dict] = {}
    years: dict[tuple, dict] = {}
    stats = {"documents_listed": len(docs), "documents_cached": 0, "with_candidates": 0}
    for cik, acc, url, doc_type, filed in docs:
        body = cached_body(fetcher, url)
        if body is None:
            continue
        stats["documents_cached"] += 1
        q = quarter_for_filing(filed)
        if q is None:
            continue
        cands = extract(html_to_text(body))
        if not cands:
            continue
        stats["with_candidates"] += 1
        ch = choose(cands, q)
        npe_q, losses_q = fin.get((cik, q), (None, None))
        npe_q = float(npe_q) if npe_q is not None else None
        losses_q = float(losses_q) if losses_q is not None else None
        c = ch["quarter"]
        key = (cik, q)
        # the press release (EX-99.1) wins over supplements: keep the first document that yields a figure
        if c is not None and key not in found and plausible(c.value, npe_q, losses_q):
            found[key] = {"usd": c.value, "points": ch["points"].value if ch["points"] else None, "basis": "quarter",
                          "accession": acc, "url": url, "snippet": c.snippet}
        if ch["year"] is not None and key not in years:
            years[key] = {"usd": ch["year"].value, "accession": acc, "url": url, "snippet": ch["year"].snippet}
    for (cik, q), yr in years.items():
        if (cik, q) in found:
            continue
        prev = [found.get((cik, date(q.year, m, d))) for m, d in ((3, 31), (6, 30), (9, 30))]
        v = derive_q4(yr["usd"], *[p["usd"] if p else None for p in prev])
        npe_q, losses_q = fin.get((cik, q), (None, None))
        if v is not None and plausible(v, float(npe_q) if npe_q else None, float(losses_q) if losses_q else None):
            found[(cik, q)] = {"usd": v, "points": None, "basis": "derived", "accession": yr["accession"],
                               "url": yr["url"], "snippet": yr["snippet"]}
    conn.execute("delete from core.cat_loss_reported")
    with conn.cursor() as cur:
        cur.executemany(
            "insert into core.cat_loss_reported(cik, qend, cat_loss_usd, cat_points, basis, accession, url, snippet)"
            " values (%s,%s,%s,%s,%s,%s,%s,%s)",
            [(cik, q, v["usd"], v["points"], v["basis"], v["accession"], v["url"], v["snippet"])
             for (cik, q), v in sorted(found.items())],
        )
    conn.commit()
    stats["company_quarters"] = len(found)
    stats["derived_q4"] = sum(1 for v in found.values() if v["basis"] == "derived")
    log.info("reported catastrophe losses: %s", stats)
    return stats
