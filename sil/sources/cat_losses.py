"""Catastrophe losses that carriers report in their quarterly earnings releases (8-K item 2.02, EX-99.* exhibits).

Reads only documents already in the on-disk cache (the main pipeline downloads them with
`python -m sil ingest secdocs`, which needs a declared SEC contact); it never requests www.sec.gov itself.

Per release:
  1. candidates: statements whose subject or object is the catastrophe losses ("Catastrophe losses were $40
     million", "including catastrophe losses of $78.5 million", "we incurred $22.0 million of catastrophe losses"),
     never an amount that merely sits near the words; not a segment's, one named event's, a range, an after-tax,
     ex-catastrophe, prior-year-development, outlook or monthly figure, nor a sentence that names only other years.
     Combined-ratio points stated with the amount. Table rows labelled plainly "Catastrophe losses" (first number =
     the current period; units from the nearest "in thousands / in millions" header)
  2. scope: quarter, year to date, full year or unknown, from the words nearest the amount
  3. choice: the first sentence about the quarter in document order (releases state the group's figure before the
     segments'), else "no catastrophe losses in the quarter", else a table column headed by the quarter; the
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

_NONE = re.compile(r"\bno\s+(?:significant\s+|material\s+|notable\s+)?" + CAT, re.IGNORECASE)
# table rows: "Catastrophe losses | $ | 123.4 | | $ | 56.7 |"
_ROW = re.compile(r"^\s*(?:\|\s*)*(?:net\s+|pre-?tax\s+|current[- ]accident[- ]year\s+)?catastrophe\s+loss(?:es)?"
                  r"(?:\s*,\s*net(?:\s+of\s+[a-z ]+)?)?\s*(?:\(\d\)\s*)?\|(?P<cells>.*)$", re.IGNORECASE | re.MULTILINE)
_TABLE_UNIT = re.compile(r"(?:in|\$\s*in|dollars\s+in|amounts\s+in)\s+(thousands|millions|billions)", re.IGNORECASE)

# words near an amount that make it something other than the quarter's pre-tax catastrophe losses: an
# ex-catastrophe measure, an after-tax figure, prior-year development, an outlook or load
_NOT_THIS = re.compile(
    r"\b(?:excluding|excludes|exclusive\s+of|ex-?cat\w*|before\s+catastrophe|less\s+catastrophe"
    r"|after[- ]tax|net\s+of\s+(?:income\s+)?tax(?:es)?"
    r"|prior[- ](?:accident[- ])?years?(?:'s)?\s+(?:reserve\s+)?development|reserve\s+development"
    r"|favorable\s+development|adverse\s+development|development\s+on\s+prior"
    r"|estimated?\s+of|range\s+of|expect\w*|guidance|outlook|anticipat\w*|remainder\s+of|budget\w*|load)\b",
    re.IGNORECASE)
# a monthly figure ("Included in September results is $167.6 million of catastrophe losses")
_MONTH = re.compile(r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)"
                    r"\s+(?:results|month)|\bfor\s+the\s+month\b|\bmonthly\b"
                    r"|\b(?:during|in|for)\s+(?:January|February|March|April|May|June|July|August|September|October"
                    r"|November|December)\b(?!\s+\d{1,2},)", re.IGNORECASE)
# "compared to no catastrophe losses in the first quarter of 2014": the comparison period, not this one
_COMPARED = re.compile(r"(?:compared\s+(?:to|with)|versus|vs\.?|than|from|against)\s*$", re.IGNORECASE)

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
    # "catastrophe losses were $46 million in 2011": a year named right after the amount is the period (further on,
    # "compared to $4.2 million in 2014" is a comparison)
    if re.match(r"\s*(?:in|for|during)\s+(?:fiscal\s+)?20\d\d\b", after):
        best = ("year", 40)
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


# ---------------------------------------------------------------- strict statements
# A figure counts only where the catastrophe losses are the subject or the object of the statement; the looser
# "catastrophe losses ... $X" proximity matched segment figures, single events, ranges and changes (a sample of 40
# releases was right 6 to 23 times in 40 before these templates).
_AMT = r"\$\s?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?P<unit>thousands?|millions?|billions?|mm|bn|m|b)\b"
_CAT_Q = (r"(?:(?:estimated|reported|total)\s+)?(?:(?:pre-?tax|net|gross|current[- ]accident[- ]year|natural)\s+)*"
          r"catastrophe\s+loss(?:es)?(?:\s+and\s+(?:loss\s+adjustment\s+expenses|LAE))?")
_START = r"(?:^|(?<=[.:;!?•▪◦·|\n(]))\s*"
_LEAD = (r"(?:(?:for|in|during)\s+the\s+[^.;$]{3,70}?,\s*)?"  # "For the nine months ended September 30, 2024, "
         r"(?:(?:the\s+)?(?:(?:first|second|third|fourth)[- ]quarter(?:\s+20\d\d)?|quarterly|q[1-4](?:\s+20\d\d)?)\s+)?")
_PERIOD_WORDS = (r"(?:\s+(?:for|in|during)\s+the\s+(?:(?:first|second|third|fourth)\s+quarter(?:\s+of\s+20\d\d)?|quarter"
           r"|three\s+months\s+ended\s+[A-Za-z]+\s+\d{1,2},\s+20\d\d))?")
_NET_OF = r"(?:\s*,\s*net\s+of\s+[a-z ]{3,50},)?"
_STATEMENTS = [
    # "Catastrophe losses were $40 million", "Pre-tax catastrophe losses totaled $412 million", "Catastrophe losses
    # for the first quarter totaled $462 million", "Catastrophe losses, net of reinsurance, were $45.2 million"
    re.compile(_START + _LEAD + r"(?:the\s+)?" + _CAT_Q + _PERIOD_WORDS + _NET_OF
               + r"\s*(?:were|was|totaled|totalled|amounted\s+to|of|reached)\s+(?:approximately\s+|about\s+)?" + _AMT,
               re.IGNORECASE | re.MULTILINE),
    # "including current accident year catastrophe losses of $78.5 million", "Including Catastrophe Losses of $284 Million"
    re.compile(r"\binclud(?:ing|ed|es)\s+(?:the\s+)?" + _CAT_Q + r"\s+of\s+(?:approximately\s+|about\s+)?" + _AMT,
               re.IGNORECASE),
    # "The company experienced $22.0 million of catastrophe losses", "there were $24.8 million of catastrophe losses",
    # "including $36.5 million of catastrophe losses", "results include $64.2 million of net pre-tax catastrophe losses"
    re.compile(r"\b(?:experienced|incurred|recorded|reported|had|there\s+were|including|included|includes|include)\s+"
               r"(?:approximately\s+|about\s+)?" + _AMT + r"\s+(?:of|in)\s+" + _CAT_Q, re.IGNORECASE),
]
# combined-ratio points stated with the amount ("$40 million, or 1.5 points of the loss ratio"), or on their own
_POINTS_WITH = re.compile(r"\s*,?\s*or\s+(\d{1,2}(?:\.\d+)?)\s+(?:percentage\s+)?points?\b", re.IGNORECASE)
_POINTS_ALONE = re.compile(_START + _LEAD + r"(?:the\s+)?" + _CAT_Q + _PERIOD_WORDS
                           + r"\s+(?:added|contributed|accounted\s+for|represented|were|was)\s+(\d{1,2}(?:\.\d+)?)\s+"
                           r"(?:percentage\s+)?points?\b", re.IGNORECASE | re.MULTILINE)
# not the group's figure for the quarter: a segment's, one event's, a range, or a sentence about other years
_SEGMENT = re.compile(r"\b(?:segments?|divisions?|this\s+group|business\s+units?)\b", re.IGNORECASE)
# (a) a segment paragraph: a line of business or a subsidiary named just before the statement
_SEGMENT_BEFORE = re.compile(r"\b(?:segments?|divisions?|(?:Commercial|Personal|Specialty|Core|Other)\s+Lines|TransRe"
                             r"|RSUI|CapSpecialty|(?:Reinsurance|Insurance)\s+(?:segment|operations|group)|Reinsurance:"
                             r"|Insurance:)\b")
# (f) a named unit right after the amount: "$153 million of catastrophe losses at TransRe"
_UNIT_AFTER = re.compile(r"^[^.;]{0,60}?\b(?:at|in|for)\s+(?:our\s+)?(?-i:[A-Z][A-Za-z&]+)(?:\s+(?-i:[A-Z][A-Za-z&]+))?"
                         r"(?:\s+(?:segment|operations|unit))?\b(?!\s+\d)", re.IGNORECASE)
# a segment's result line (Everest's and Alleghany's segment paragraphs): "Underwriting gain of $228 million
# including $125 million of catastrophe losses", "Underwriting loss in the second quarter included $165 million ..."
# the quarter a statement's own period phrase names ("..., in the fourth quarter of 2016" in a 2017 release is the
# comparison quarter); after the amount, only up to the first comparison word
_QUARTER_YEAR = re.compile(r"(?:(?:first|second|third|fourth)\s+quarter|quarter|three\s+months\s+ended\s+[A-Za-z]+\s+\d{1,2},)"
                           r"\s+(?:of\s+)?(20\d\d)\b|\b(20\d\d)\s+(?:first|second|third|fourth)\s+quarter", re.IGNORECASE)
_COMPARISON = re.compile(r"\b(?:compared|versus|vs\.?|than|from|against|as\s+compared)\b", re.IGNORECASE)
# "$210 million from 13 events during the quarter and $148 million related to reestimates": a part of the quarter's
_REESTIMATES = re.compile(r"^[^.;]{0,120}?\band\s+\$\s?[\d.,]+\s*(?:million|billion)\s+(?:related\s+to|from|of)\s+"
                          r"(?:re-?estimates|prior)", re.IGNORECASE)
_SEGMENT_RESULT = re.compile(r"\bunderwriting\s+(?:gain|income|loss|profit|result)\b", re.IGNORECASE)
# (b) the comparison period: "In the prior year quarter, natural catastrophe losses were $181.1 million"
_PRIOR = re.compile(r"\b(?:prior[- ]year|last\s+year|a\s+year\s+ago|same\s+(?:period|quarter)\s+(?:of\s+)?last\s+year"
                    r"|comparable\s+period|previous\s+year)\b", re.IGNORECASE)
_RANGE = re.compile(r"\s*(?:to|-|–|and)\s*\$?\s?\d", re.IGNORECASE)
_EVENT = re.compile(r"^[^.;]{0,45}?\b(?:from|for|related\s+to|associated\s+with|attributable\s+to|due\s+to|caused\s+by)\s+"
                    r"(?:the\s+)?(?:(?:Hurricanes?|Storms?|Typhoons?|Tropical|Winter\s+Storm|Cyclones?|Wildfires?)\b"
                    r"|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:wildfires?|hurricanes?|earthquakes?|floods?|storms?)\b)")
_YEARS = re.compile(r"\b(19[89]\d|20[0-4]\d)\b")
_TABLE_LABEL = re.compile(r"^\s*(?:\|\s*)*(?:net\s+|pre-?tax\s+)?catastrophe\s+loss(?:es)?\s*(?:\(\d\)\s*)?\|",
                          re.IGNORECASE)


def _join_wrapped_lines(text: str) -> str:
    """Plain-text filings wrap sentences across lines: join a break that continues a sentence."""
    t = re.sub(r"[ \t\xa0]+", " ", text)
    return re.sub(r"(?<![.:;!?|•▪◦·])\n(?=\s*[a-z$(\d])", " ", t)


def _rejected(t: str, s0: int, s1: int, start: int, num_start: int, amt_end: int, end: int,
              quarter_year: int | None) -> bool:
    """start: the statement's first word; num_start/amt_end: the amount; end: the statement's end."""
    if _NOT_THIS.search(t[max(s0, start - 80):min(s1, end + 60)]) or _MONTH.search(t[s0:end]):
        return True
    if _SEGMENT.search(t[s0:num_start]) or _RANGE.match(t, amt_end) or _EVENT.match(t[end:end + 120]):
        return True
    if _SEGMENT_BEFORE.search(t[max(0, start - 250):start]) or _UNIT_AFTER.match(t[end:end + 120]):
        return True
    if _PRIOR.search(t[s0:num_start]):  # the statement's own lead names the comparison period
        return True
    if _SEGMENT_RESULT.search(t[s0:num_start]):  # "Underwriting gain of $228 million including $125 million ..."
        return True
    if _REESTIMATES.match(t[end:end + 200]):
        return True
    if quarter_year is not None:
        after = t[end:min(s1, end + 80)]
        cut = _COMPARISON.search(after)
        named = [*_QUARTER_YEAR.finditer(t[s0:num_start])][-1:] + [*_QUARTER_YEAR.finditer(after[:cut.start() if cut else None])][:1]
        if named and all(int(m.group(1) or m.group(2)) != quarter_year for m in named):
            return True
    # the years the statement itself names (not a trailing "compared to $4.2 million in 2014")
    years = {int(y) for y in _YEARS.findall(t[s0:min(s1, end + 25)])}
    return quarter_year is not None and bool(years) and quarter_year not in years


def extract(text: str, quarter_year: int | None = None) -> list[Candidate]:
    """Every catastrophe-loss figure a release states in one of the strict statements, in document order.
    quarter_year: the calendar year of the quarter the release reports (a sentence naming only other years is about
    them, e.g. 'net catastrophe losses in 2008' in a 2009 release)."""
    t = _join_wrapped_lines(text)
    out: list[Candidate] = []
    stated = 0  # catastrophe amounts for the quarter (or undated) the release states anywhere, before any rejection
    for rx in _STATEMENTS:
        for m in rx.finditer(t):
            v = _money(m.group("num"), m.group("unit"))
            if v is None:
                continue
            # (a year-to-date or full-year amount does not contradict "no catastrophe losses in the quarter")
            stated += v > 0 and scope_of(t, m.start("num"), m.end()) in ("quarter", "unknown")
            start = m.start() + len(m.group(0)) - len(m.group(0).lstrip())  # the first word, not the space before
            s0, s1 = _sentence(t, start, m.end())
            if _rejected(t, s0, s1, start, m.start("num"), m.end("unit"), m.end(), quarter_year):
                continue
            out.append(Candidate("amount", v, scope_of(t, m.start("num"), m.end()), "sentence",
                                 t[s0:s1].strip()[:400], m.start()))
            pts = _POINTS_WITH.match(t, m.end())
            if pts and float(pts.group(1)) <= 60:
                out.append(Candidate("points", float(pts.group(1)), out[-1].scope, "sentence", out[-1].snippet,
                                     m.start()))
    for m in _POINTS_ALONE.finditer(t):
        start = m.start() + len(m.group(0)) - len(m.group(0).lstrip())
        s0, s1 = _sentence(t, start, m.end())
        if float(m.group(1)) <= 60 and not _rejected(t, s0, s1, start, m.start(1), m.end(1), m.end(), quarter_year):
            out.append(Candidate("points", float(m.group(1)), scope_of(t, m.start(1), m.end()), "sentence",
                                 t[s0:s1].strip()[:400], m.start()))
    # "no catastrophe losses in the quarter": only in a release that states no catastrophe amount anywhere (else it
    # is a segment's line), and held to the same rules as an amount ("... first quarter of 2019 with no catastrophe
    # losses in 2019" in a 2020 release is about 2019)
    for m in _NONE.finditer(t) if not stated else ():
        s0, s1 = _sentence(t, m.start(), m.end())
        if _COMPARED.search(t[max(s0, m.start() - 40):m.start()]):
            continue
        if _rejected(t, s0, s1, m.start(), m.start(), m.end(), m.end(), quarter_year):
            continue
        out.append(Candidate("amount", 0.0, scope_of(t, m.start(), m.end()), "none", t[s0:s1].strip()[:400], m.start()))
    for m in _ROW.finditer(t):
        if not _TABLE_LABEL.match(m.group(0)):  # a plain "Catastrophe losses" row; not "current accident year ..."
            continue
        if re.search(r"\b(?:pts|points?)\b|%", m.group("cells"), re.IGNORECASE):  # a row of ratio points
            continue
        nums = _numbers(m.group("cells"))
        if not nums:
            continue
        unit = table_unit(t, m.start())
        first = nums[0]
        if unit is None:
            unit = 1e3 if first >= 10_000 else 1e6
        line = t[m.start():t.find("\n", m.start()) if t.find("\n", m.start()) > 0 else len(t)]
        out.append(Candidate("amount", first * unit, table_scope(t, m.start()), "table", line.strip()[:400], m.start()))
    # one candidate per (kind, position): the statements can overlap on the same words
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
    # the first sentence about this quarter, in document order: releases state the group's figure in their
    # highlights before the segments' ("Catastrophe losses for the quarter were $0.5 million" in a segment section)
    # a fourth-quarter release states the year's figure too, often without period words ("Pre-tax catastrophe
    # losses were $2.39 billion compared with $1.83 billion last year"): there, only a statement naming the quarter
    prefs = [
        lambda c: c.source == "sentence" and (c.scope == "quarter" or (c.scope == "unknown" and not q4
                                                                       and round(c.value, 2) not in year_values)),
        lambda c: c.source == "none" and c.scope == "quarter",
        lambda c: c.source == "table" and c.scope == "quarter",
        lambda c: c.source == "table" and c.scope == "unknown" and not q4,
    ]
    pick = None
    for pref in prefs:
        hit = [c for c in amounts if pref(c)]
        if hit:
            pick = hit[0]
            break
    if pick is not None:  # the points stated with the chosen amount ("$40 million, or 1.5 points")
        pts = next((c for c in cands if c.kind == "points" and c.pos == pick.pos), None)
    else:
        pts = next((c for c in cands if c.kind == "points" and c.scope in ("quarter", "unknown")), None)
    return {"quarter": pick, "year": year if q4 else None, "points": pts}


def consistent_with_premium(value: float, points: float | None, npe_q: float | None) -> bool:
    """An amount stated with its combined-ratio points implies the premium base it was measured on (value / points):
    a base far below the company's net premiums earned is a segment's ("$12.5 million, or 5.2 points" at a carrier
    earning $1.1 billion a quarter)."""
    if points is None or points <= 0 or npe_q is None or npe_q <= 0 or value <= 0:
        return True
    base = value / (points / 100)
    return 0.5 * npe_q <= base <= 2.0 * npe_q


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
        cands = extract(html_to_text(body), quarter_year=q.year)
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
        pts = ch["points"].value if ch["points"] else None
        if c is not None and key not in found and plausible(c.value, npe_q, losses_q) \
                and consistent_with_premium(c.value, pts, npe_q):
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
