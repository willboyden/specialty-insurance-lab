"""SEC EDGAR: company metadata, the full filing index, and every XBRL fact (companyfacts API).

Endpoints (data.sec.gov, no key; a generic client name is accepted):
  submissions/CIK##########.json      company metadata + recent filings
  submissions/<older file>.json       older filings, when a company has more than ~1000
  api/xbrl/companyfacts/CIK##########.json   every us-gaap / dei fact the company ever reported
"""

from __future__ import annotations

import json
import logging
from datetime import date

from ..db import copy_rows, ingest_run
from ..http import Fetcher
from ..universe import AI_INDICATOR_TAGS, COMPANIES, Company

log = logging.getLogger(__name__)

DAY = 24 * 3600
TAXONOMIES = ("us-gaap", "dei", "srt")


def _d(value: str | None) -> date | None:
    return date.fromisoformat(value[:10]) if value else None


def _filing_rows(cik: int, block: dict):
    n = len(block.get("accessionNumber", []))
    for i in range(n):
        acc = block["accessionNumber"][i]
        yield (
            acc,
            cik,
            block["form"][i],
            _d(block["filingDate"][i]),
            _d(block["reportDate"][i]) if block.get("reportDate") and block["reportDate"][i] else None,
            block["acceptanceDateTime"][i] or None,
            (block.get("act") or [""] * n)[i] or None,
            (block.get("fileNumber") or [""] * n)[i] or None,
            (block.get("items") or [""] * n)[i] or None,
            (block.get("size") or [None] * n)[i],
            bool((block.get("isXBRL") or [0] * n)[i]),
            bool((block.get("isInlineXBRL") or [0] * n)[i]),
            (block.get("primaryDocument") or [""] * n)[i] or None,
            (block.get("primaryDocDescription") or [""] * n)[i] or None,
        )


def ingest_submissions(conn, fetcher: Fetcher, companies: list[Company] = COMPANIES) -> None:
    with ingest_run(conn, "sec_submissions") as info:
        total = 0
        for c in companies:
            sub = fetcher.get_json(f"https://data.sec.gov/submissions/CIK{c.cik:010d}.json", max_age_s=DAY)
            conn.execute("delete from raw.sec_company where cik = %s", (c.cik,))
            conn.execute(
                "insert into raw.sec_company(cik, name, sic, sic_description, category, entity_type,"
                " state_of_incorporation, fiscal_year_end, tickers, exchanges, former_names)"
                " values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                (
                    c.cik, sub.get("name"), sub.get("sic"), sub.get("sicDescription"), sub.get("category"),
                    sub.get("entityType"), sub.get("stateOfIncorporation"), sub.get("fiscalYearEnd"),
                    sub.get("tickers") or [], sub.get("exchanges") or [],
                    json.dumps(sub.get("formerNames") or []),
                ),
            )
            rows = list(_filing_rows(c.cik, sub["filings"]["recent"]))
            for extra in sub["filings"].get("files", []):
                older = fetcher.get_json(f"https://data.sec.gov/submissions/{extra['name']}", max_age_s=7 * DAY)
                rows.extend(_filing_rows(c.cik, older))
            # an accession can be listed under more than one filer (co-registrants): keep the first
            seen: set[str] = set()
            unique = [r for r in rows if not (r[0] in seen or seen.add(r[0]))]
            conn.execute("delete from raw.sec_filing where cik = %s", (c.cik,))
            if unique:
                existing = {
                    r[0] for r in conn.execute(
                        "select accession from raw.sec_filing where accession = any(%s)", ([r[0] for r in unique],)
                    )
                }
                unique = [r for r in unique if r[0] not in existing]
            total += copy_rows(
                conn, "raw.sec_filing",
                ("accession", "cik", "form", "filing_date", "report_date", "acceptance_datetime", "act",
                 "file_number", "items", "size_bytes", "is_xbrl", "is_inline_xbrl", "primary_document",
                 "primary_doc_description"),
                unique,
            )
            conn.commit()
            log.info("submissions %-6s %5d filings", c.ticker, len(unique))
        info["rows"] = total
        info["detail"] = {"companies": len(companies)}


def ingest_companyfacts(conn, fetcher: Fetcher, companies: list[Company] = COMPANIES) -> None:
    with ingest_run(conn, "sec_companyfacts") as info:
        total = 0
        concepts: dict[tuple[str, str], tuple[str | None, str | None]] = {}
        per_company = {}
        for c in companies:
            facts = fetcher.get_json(
                f"https://data.sec.gov/api/xbrl/companyfacts/CIK{c.cik:010d}.json", max_age_s=DAY, allow_404=True
            )
            conn.execute("delete from raw.xbrl_fact where cik = %s", (c.cik,))
            if not facts:
                log.warning("no companyfacts for %s", c.ticker)
                per_company[c.ticker] = 0
                continue
            rows = []
            seen = set()
            for taxonomy in TAXONOMIES:
                for tag, body in (facts.get("facts", {}).get(taxonomy) or {}).items():
                    if c.cohort == "ai_indicator" and tag not in AI_INDICATOR_TAGS:
                        continue
                    concepts.setdefault((taxonomy, tag), (body.get("label"), body.get("description")))
                    for unit, items in body.get("units", {}).items():
                        for f in items:
                            key = (taxonomy, tag, unit, f.get("start"), f["end"], f["accn"])
                            if key in seen:
                                continue
                            seen.add(key)
                            rows.append((
                                c.cik, taxonomy, tag, unit, _d(f.get("start")), _d(f["end"]), f["val"], f["accn"],
                                f.get("fy"), f.get("fp"), f.get("form"), _d(f["filed"]), f.get("frame"),
                            ))
            n = copy_rows(
                conn, "raw.xbrl_fact",
                ("cik", "taxonomy", "tag", "unit", "period_start", "period_end", "value", "accession",
                 "fiscal_year", "fiscal_period", "form", "filed", "frame"),
                rows,
            )
            conn.commit()
            per_company[c.ticker] = n
            total += n
            log.info("companyfacts %-6s %7d facts", c.ticker, n)
        with conn.cursor() as cur:
            cur.executemany(
                "insert into raw.xbrl_concept(taxonomy, tag, label, description) values (%s,%s,%s,%s)"
                " on conflict (taxonomy, tag) do update set label = excluded.label, description = excluded.description",
                [(t, g, lab, desc) for (t, g), (lab, desc) in concepts.items()],
            )
        conn.commit()
        info["rows"] = total
        info["detail"] = {"facts_per_company": per_company, "concepts": len(concepts)}


def load_reference(conn, companies: list[Company] = COMPANIES) -> None:
    conn.execute("delete from ref.company")
    copy_rows(
        conn, "ref.company",
        ("cik", "ticker", "short_name", "cohort", "segment", "status", "status_year", "status_note", "include_note",
         "comparable"),
        [(c.cik, c.ticker, c.short_name, c.cohort, c.segment, c.status, c.status_year, c.status_note,
          c.include_note, c.comparable) for c in companies],
    )
    conn.commit()
