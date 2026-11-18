"""A small, dependency-free XBRL instance reader for the claims-development disclosures in 10-K filings.

companyfacts (data.sec.gov) carries only facts without dimensions. The loss triangles that ASU 2015-09 requires
of every short-duration insurer from fiscal 2016 (incurred and paid claims by accident year and line, IBNR,
reported claim counts, payout percentages) are dimensional, so they are read from each 10-K's XBRL instance:
the EX-101.INS document (filings before inline XBRL) or the instance SEC extracts from an inline filing
(<name>_htm.xml). Both are plain XBRL 2.1 instances, which is all this module needs to understand.

parse_instance() streams the document (xml.etree iterparse) and keeps only the us-gaap facts whose local name the
caller asks for; contexts are resolved to (period, dimensions) and units to their measure.
classify() maps an element to one of the triangle measures this project uses.
"""

from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date

XBRLI = "http://www.xbrl.org/2003/instance"
XBRLDI = "http://xbrl.org/2006/xbrldi"
XSI_NIL = "{http://www.w3.org/2001/XMLSchema-instance}nil"
YEAR_AXIS = re.compile(r"(accident|underwriting|policy|report|occurrence|incurral)\s*-?\s*years?", re.IGNORECASE)
YEAR_IN_MEMBER = re.compile(r"(?<!\d)(19[89]\d|20[0-4]\d)(?!\d)")


@dataclass
class Context:
    start: date | None
    end: date  # the instant, or the end of the duration
    dims: dict[str, str] = field(default_factory=dict)  # axis local name -> member local name (or typed value)


@dataclass
class Fact:
    element: str  # local name, e.g. ShortdurationInsuranceContractsCumulativeNumberOfReportedClaims
    value: float | None
    unit: str | None
    decimals: str | None
    context: Context


def _local(qname: str) -> str:
    """'{ns}Local' or 'prefix:Local' -> 'Local'."""
    if qname.startswith("{"):
        return qname.split("}", 1)[1]
    return qname.rsplit(":", 1)[-1]


def _ns(tag: str) -> str:
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def _date(text: str | None) -> date | None:
    if not text:
        return None
    text = text.strip()[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def is_us_gaap(namespace: str) -> bool:
    return "fasb.org/us-gaap" in namespace


def parse_instance(data: bytes, keep: Callable[[str], bool]) -> list[Fact]:
    """Facts of the us-gaap elements for which keep(local_name) is true, with resolved contexts and units."""
    contexts: dict[str, Context] = {}
    units: dict[str, str] = {}
    pending: list[tuple[str, str | None, str | None, str | None, str | None]] = []
    for _event, elem in ET.iterparse(io.BytesIO(data), events=("end",)):
        tag = elem.tag
        if tag == f"{{{XBRLI}}}context":
            cid = elem.get("id")
            start = end = None
            instant = elem.find(f"{{{XBRLI}}}period/{{{XBRLI}}}instant")
            if instant is not None:
                end = _date(instant.text)
            else:
                start = _date(elem.findtext(f"{{{XBRLI}}}period/{{{XBRLI}}}startDate"))
                end = _date(elem.findtext(f"{{{XBRLI}}}period/{{{XBRLI}}}endDate"))
            dims: dict[str, str] = {}
            for holder in (f"{{{XBRLI}}}entity/{{{XBRLI}}}segment", f"{{{XBRLI}}}scenario"):
                seg = elem.find(holder)
                if seg is None:
                    continue
                for m in seg.iter(f"{{{XBRLDI}}}explicitMember"):
                    dims[_local(m.get("dimension", ""))] = _local((m.text or "").strip())
                for m in seg.iter(f"{{{XBRLDI}}}typedMember"):
                    value = " ".join("".join(m.itertext()).split())
                    dims[_local(m.get("dimension", ""))] = value
            if cid and end:
                contexts[cid] = Context(start, end, dims)
            elem.clear()
        elif tag == f"{{{XBRLI}}}unit":
            uid = elem.get("id")
            measures = [_local((m.text or "").strip()) for m in elem.iter(f"{{{XBRLI}}}measure")]
            if uid:
                units[uid] = "/".join(measures) if measures else None
            elem.clear()
        elif is_us_gaap(_ns(tag)):
            name = _local(tag)
            if keep(name):
                text = None if elem.get(XSI_NIL) in ("true", "1") else (elem.text or "").strip()
                pending.append((name, elem.get("contextRef"), elem.get("unitRef"), elem.get("decimals"), text))
            elem.clear()
    facts: list[Fact] = []
    seen: set[tuple] = set()
    for name, cref, uref, decimals, text in pending:
        ctx = contexts.get(cref or "")
        if ctx is None:
            continue
        value = None
        if text:
            try:
                value = float(text.replace(",", ""))
            except ValueError:
                value = None
        key = (name, ctx.start, ctx.end, tuple(sorted(ctx.dims.items())), uref, value)
        if key in seen:  # the same fact can appear in several presentation sections
            continue
        seen.add(key)
        facts.append(Fact(name, value, units.get(uref or "") if uref else None, decimals, ctx))
    return facts


# ---------------------------------------------------------------- the short-duration disclosures

def is_claims_element(name: str) -> bool:
    """Elements this project keeps from an instance: the short-duration claims disclosures."""
    return name.lower().startswith("shortduration")


# us-gaap spells the year out (...DurationYearOne to ...DurationYearTen); digits are accepted too
_PAYOUT_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
                 "ten": 10}
_PAYOUT = re.compile(r"HistoricalClaimsDurationYear(\d+|" + "|".join(_PAYOUT_WORDS) + r")$", re.IGNORECASE)


def classify(name: str) -> tuple[str, int | None] | None:
    """Map a short-duration element to (measure, payout year) or None when it is not one this project uses.

    measures: incurred (cumulative incurred claims and allocated claim adjustment expense, net, by accident year),
    paid (cumulative paid claims and ALAE, net), ibnr (IBNR plus expected development on reported claims),
    claims (cumulative number of reported claims), payout (average annual percentage payout, year n),
    liability (unpaid claims and ALAE, net: the triangle's total by line).
    """
    n = name.lower()
    m = _PAYOUT.search(name)
    if m:
        year = m.group(1)
        return "payout", int(year) if year.isdigit() else _PAYOUT_WORDS[year.lower()]
    if "numberofreportedclaims" in n or "reportedclaimscount" in n:
        return "claims", None
    if "incurredbutnotreported" in n:
        return "ibnr", None
    # liabilities first: "unpaidclaims" contains "paidclaims"
    if "liabilityforunpaidclaims" in n or "liabilitiesforunpaidclaims" in n:
        if "allocatedclaimadjustmentexpensenet" in n and "reconciling" not in n and "unallocated" not in n \
                and "priorto" not in n:
            return "liability", None
        return None
    if "cumulativepaidclaims" in n or (re.search(r"(?<!un)paidclaims", n) and "allocatedclaimadjustmentexpense" in n):
        return "paid", None
    if "incurredclaims" in n and "allocatedclaimadjustmentexpense" in n:
        return "incurred", None
    return None


def accident_year(dims: dict[str, str]) -> tuple[int | None, str | None]:
    """(accident year, axis) from a context's dimensions, if one of them is an accident-year-like axis."""
    for axis, member in dims.items():
        if YEAR_AXIS.search(re.sub(r"([a-z])([A-Z])", r"\1 \2", axis)):
            if re.search(r"prior|before|earlier|older|andpre", member.lower()):
                return None, axis  # 'accident years prior to 2015', '2015 and prior': not a single year
            m = YEAR_IN_MEMBER.search(member)
            if m:
                return int(m.group(1)), axis
            return None, axis
    return None, None


# member names a filer wrote without CamelCase breaks (Kinsale, Hartford), spelled out for display
GLUED_WORDS = {
    "casualtyclaimsmade": "Casualty claims-made",
    "casualtyoccurrence": "Casualty occurrence",
    "grouplifetermdisabilityandaccident": "Group life, term disability and accident",
}


def split_words(name: str) -> str:
    s = re.sub(r"Member$", "", name)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    words = " ".join(s.replace("_", " ").split())
    return " ".join(GLUED_WORDS.get(w.lower(), w) for w in words.split(" "))


GENERIC_WORDS = re.compile(r"\b(segment|segments|line of business|lines of business|operating)\b", re.IGNORECASE)


def line_name(dims: dict[str, str], ay_axis: str | None) -> str:
    """A readable line-of-business label from the non-accident-year members (CamelCase split, 'Member' dropped)."""
    parts = []
    for axis, member in sorted(dims.items()):
        if axis == ay_axis:
            continue
        words = split_words(member)
        cleaned = " ".join(GENERIC_WORDS.sub("", words).split())
        parts.append(cleaned or words)
    return " · ".join(parts) if parts else "All lines"
