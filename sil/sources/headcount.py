"""Reported headcount from each 10-K, and the technology vocabulary of the whole report.

Annual reports state the workforce in Item 1 ("Employees", since 2020 "Human Capital"): "As of December 31,
2024, we had approximately 2,550 employees". The extractor looks under those headings first, then anywhere in
the report with stricter wording, keeps the sentence it read the number from, and refuses implausible values.

Reads only documents already in the on-disk cache: the filing documents are downloaded once, centrally, by
`python -m sil ingest secdocs` (www.sec.gov needs a declared contact). Until then this source finds nothing to
read and says so.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date

from ..db import copy_rows, ingest_run
from ..http import Fetcher
from .sec_docs import html_to_text

log = logging.getLogger(__name__)

MIN_EMPLOYEES = 5
MAX_EMPLOYEES = 400_000

NUM = r"(\d{1,3}(?:,\d{3})+|\d{1,6})"
QUAL = r"(?:approximately|about|around|over|more than|nearly|roughly|almost|a total of|some|in excess of)\s+"
NOUN = (r"(?:(?:full[- ]time(?:[- ]equivalent)?|part[- ]time|total|global|worldwide|permanent|regular|active)\s+)?"
        r"(?:employees|associates|team members|colleagues|people|persons|staff members|staff|individuals|"
        r"full[- ]time equivalents?)\b")
VERB = (r"(?:had|have|has|employed|employ|employs|employing|were|was|are|is|of|with|totaled|totaling|totalled|"
        r"consisted of|comprised|included|reported)")

PATTERNS: list[tuple[str, re.Pattern]] = [
    ("verb-count-noun", re.compile(rf"\b{VERB}\s+(?:{QUAL})*{NUM}\s+{NOUN}", re.IGNORECASE)),
    ("workforce-of", re.compile(rf"\b(?:workforce|employee base|headcount|employee population)\s+"
                                rf"(?:of|was|totaled|totalled|consisted of|included|comprised|is|stood at)\s+"
                                rf"(?:{QUAL})*{NUM}\b", re.IGNORECASE)),
    ("qualified-count-noun", re.compile(rf"\b(?:{QUAL})+{NUM}\s+{NOUN}", re.IGNORECASE)),
]

HEADING = re.compile(
    r"(?im)^[ \t|]*(?:item\s*1\.?\s*[-–—:]?\s*)?(?:human capital(?: resources| management)?|employees(?: and human"
    r" capital)?|our employees|our people|personnel|workforce|our workforce|team members)\b[ \t]*[.:—–-]?"
)
SENTENCE_END = re.compile(r"(?<=[.;])\s+(?=[A-Z(])|\n")
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
ASOF = re.compile(r"\b(" + "|".join(MONTHS) + r")\s+(\d{1,2}),\s+(\d{4})", re.IGNORECASE)
FULL_PART = re.compile(rf"{NUM}\s+(?:were\s+|are\s+)?full[- ]time(?:\s+employees)?(?:\s*(?:,|and)\s*{NUM}\s+"
                       rf"(?:were\s+|are\s+)?part[- ]time)?", re.IGNORECASE)


@dataclass
class Headcount:
    employees: int | None
    full_time: int | None
    as_of: date | None
    snippet: str | None
    method: str


def _int(s: str) -> int:
    return int(s.replace(",", ""))


def _sentence(text: str, start: int, end: int) -> str:
    """The sentence around [start, end): from the previous sentence break to the next one."""
    left = max(text.rfind(". ", 0, start), text.rfind("\n", 0, start))
    right_candidates = [i for i in (text.find(". ", end), text.find("\n", end)) if i >= 0]
    right = min(right_candidates) + 1 if right_candidates else len(text)
    return " ".join(text[left + 1:right].split())[:400]


def _as_of(sentence: str) -> date | None:
    m = ASOF.search(sentence)
    if not m:
        return None
    try:
        return date(int(m.group(3)), MONTHS.index(m.group(1).lower()) + 1, int(m.group(2)))
    except ValueError:
        return None


def _plausible(n: int, snippet: str) -> bool:
    if not (MIN_EMPLOYEES <= n <= MAX_EMPLOYEES):
        return False
    # a bare four-digit year read as a count ("in 2024 employees ...") is not a headcount
    return not (1900 <= n <= 2100 and f"{n:,}" not in snippet and re.search(rf"\b(in|since|during|of)\s+{n}\b", snippet))


def _search(text: str, method_prefix: str, patterns=PATTERNS) -> Headcount | None:
    for name, rx in patterns:
        for m in rx.finditer(text):
            n = _int(m.group(1))
            snippet = _sentence(text, m.start(), m.end())
            if re.search(r"\b(part[- ]time|temporary|contractors?|agents?)\s*$", text[m.start():m.end()], re.IGNORECASE):
                continue
            if not _plausible(n, snippet):
                continue
            full = None
            fp = FULL_PART.search(snippet)
            if fp and fp.group(1) and _int(fp.group(1)) <= n:
                full = _int(fp.group(1))
            elif re.search(r"full[- ]time", m.group(0), re.IGNORECASE) and not re.search(r"part[- ]time", m.group(0), re.IGNORECASE):
                full = n
            return Headcount(n, full, _as_of(snippet), snippet, f"{method_prefix}:{name}")
    return None


def extract_headcount(text: str) -> Headcount:
    """The reported workforce of a 10-K's text (plain text, see sec_docs.html_to_text)."""
    # 1) the Employees / Human Capital section: the 3,000 characters after each such heading
    for h in HEADING.finditer(text):
        window = text[h.start():h.start() + 3000]
        found = _search(window, "section")
        if found:
            return found
    # 2) anywhere, but only the explicit "we had/employed N employees" wording
    strict = [(n, rx) for n, rx in PATTERNS if n != "qualified-count-noun"]
    for m in re.finditer(r"\b(?:we|the company|the group|our (?:company|subsidiaries))\b", text, re.IGNORECASE):
        window = text[m.start():m.start() + 220]
        found = _search(window, "document", strict)
        if found and re.search(r"employ|workforce|headcount", found.snippet or "", re.IGNORECASE):
            return found
    return Headcount(None, None, None, None, "none")


# ---------------------------------------------------------------- technology vocabulary
TECH_TERMS: dict[str, re.Pattern] = {
    "ai": re.compile(r"\bartificial intelligence\b|\bA\.I\.(?=\s)|\bAI\b"),
    "generative_ai": re.compile(r"\bgenerative (?:AI|artificial intelligence)\b|\blarge language models?\b|\bLLMs?\b", re.IGNORECASE),
    "machine_learning": re.compile(r"\bmachine[- ]learning\b", re.IGNORECASE),
    "analytics": re.compile(r"\b(?:data|predictive|advanced) analytics\b|\bdata scien(?:ce|tists?)\b"
                            r"|\bpredictive model(?:s|ing|ling)?\b", re.IGNORECASE),
    "cloud": re.compile(r"\bcloud(?:[- ]based| computing| platforms?| infrastructure| migration| environments?"
                        r"| services| providers?| technolog(?:y|ies))\b", re.IGNORECASE),
    "automation": re.compile(r"\bautomat(?:ion|ed|es|e|ing)\b", re.IGNORECASE),
    "digital": re.compile(r"\bdigital(?:ly|i[sz]ation|i[sz]ed)?\b", re.IGNORECASE),
}
WORD = re.compile(r"[A-Za-z][A-Za-z'-]+")


def tech_counts(text: str) -> tuple[dict[str, int], int]:
    words = len(WORD.findall(text))
    return {k: len(rx.findall(text)) for k, rx in TECH_TERMS.items()}, words


# ---------------------------------------------------------------- the source
def _cached(fetcher: Fetcher, url: str) -> bool:
    body, meta = fetcher._paths(url)
    return body.exists() and meta.exists()


def fiscal_year(report_date: date | None, filing_date: date) -> int:
    d = report_date or filing_date
    return d.year if d.month >= 6 else d.year - 1


def ingest(conn, fetcher: Fetcher) -> None:
    """Parse every cached 10-K primary document not parsed yet."""
    with ingest_run(conn, "headcount_10k") as info:
        docs = conn.execute(
            """select d.accession, d.cik, f.form, f.filing_date, f.report_date, d.url
               from raw.sec_document d join raw.sec_filing f using (accession)
               join ref.company c on c.cik = d.cik
               where d.kind = 'annual' and upper(d.doc_type) = upper(f.form)
                 and f.form in ('10-K', '10-K405', '10-KT')
                 and c.cohort in ('specialty', 'benchmark')
                 and not exists (select 1 from raw.headcount_10k h where h.accession = d.accession)
               order by f.filing_date"""
        ).fetchall()
        cached = [d for d in docs if _cached(fetcher, d[5])]
        log.info("10-K primary documents listed: %d, in the cache: %d", len(docs), len(cached))
        if not cached:
            log.info("no cached 10-K documents yet: run `python -m sil ingest secdocs` (needs SIL_SEC_USER_AGENT)")
            info["detail"] = {"listed": len(docs), "cached": 0}
            return
        n_found = 0
        for i, (acc, cik, form, fdate, rdate, url) in enumerate(cached, 1):
            text = html_to_text(fetcher.get(url))
            hc = extract_headcount(text)
            fy = fiscal_year(rdate, fdate)
            counts, words = tech_counts(text)
            conn.execute(
                "insert into raw.headcount_10k(accession, cik, form, filing_date, fiscal_year, employees, full_time,"
                " as_of, snippet, method, doc_url) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
                " on conflict (accession) do nothing",
                (acc, cik, form, fdate, fy, hc.employees, hc.full_time, hc.as_of, hc.snippet, hc.method, url),
            )
            conn.execute("delete from raw.tech_terms_10k where accession = %s", (acc,))
            copy_rows(conn, "raw.tech_terms_10k", ("accession", "cik", "fiscal_year", "term_key", "n", "words"),
                      [(acc, cik, fy, k, n, words) for k, n in counts.items()])
            n_found += hc.employees is not None
            if i % 50 == 0:
                conn.commit()
                log.info("10-K parsed: %d / %d (headcount found in %d)", i, len(cached), n_found)
        conn.commit()
        info["rows"] = len(cached)
        info["detail"] = {"listed": len(docs), "parsed": len(cached), "headcount_found": n_found}
        log.info("10-K headcount: %d of %d reports gave a number", n_found, len(cached))
