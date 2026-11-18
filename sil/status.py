"""Listing status from the SEC filing record, so a hand-written label cannot quietly go stale.

  active    the company's ticker is still among its SEC-listed tickers (submissions API, refreshed at every
            ingest) and it filed a periodic report (10-K/10-Q, or 20-F/40-F/6-K) in the last 200 days
  pending   active, with a deal document filed in the last 12 months: a merger proxy (PREM14A/DEFM14A and the
            information-statement twins), a going-private schedule (SC 13E3) or a tender offer (SC TO-T, SC 14D9)
  inactive  anything else (acquired or stopped filing: sil/universe.py names which, and the acquirer)

check() compares this with sil/universe.py: an 'active' label on an inactive company (or the reverse) stops the
export, so a stale label never reaches the site. Example it caught: ProAssurance, still labelled active months
after its June 2026 closing.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

from .universe import COMPANIES

log = logging.getLogger(__name__)

PERIODIC = ("10-K", "10-Q", "10-K405", "10-KT", "20-F", "40-F", "6-K")
DEREGISTRATION = ("15-12B", "15-12G", "15-15D", "15F-12B", "15F-12G", "15F-15D")
DELISTING = ("25", "25-NSE")
DEAL_DOCS = ("PREM14A", "DEFM14A", "PREM14C", "DEFM14C", "SC 13E3", "SC 13E3/A", "SC TO-T", "SC TO-T/A", "SC 14D9",
             "SC 14D9/A")
REPORTING_DAYS = 200
PENDING_DAYS = 365


def classify(listed: bool, last_periodic: date | None, deal_docs: list[tuple[str, date]],
             last_change_of_control: date | None, today: date) -> str:
    """active | pending | inactive from the filing record (see the module docstring)."""
    reporting = last_periodic is not None and last_periodic >= today - timedelta(days=REPORTING_DAYS)
    if not (listed and reporting):
        return "inactive"
    recent = [d for _form, d in deal_docs if d >= today - timedelta(days=PENDING_DAYS)]
    if not recent:
        return "active"
    closed = last_change_of_control is not None and last_change_of_control >= min(recent)
    return "active" if closed else "pending"


def derive(conn, today: date | None = None) -> list[dict]:
    today = today or date.today()
    rows = []
    for c in COMPANIES:
        if c.cohort == "ai_indicator":
            continue
        tickers = conn.execute("select coalesce(tickers, '{}') from raw.sec_company where cik = %s", (c.cik,)).fetchone()
        listed = bool(tickers) and c.ticker in tickers[0]
        f = conn.execute(
            """select
                 max(filing_date) filter (where form = any(%(periodic)s)),
                 max(filing_date) filter (where form = '8-K' and items like '%%5.01%%'),
                 max(filing_date) filter (where form = any(%(delist)s)),
                 max(filing_date) filter (where form = any(%(dereg)s))
               from raw.sec_filing where cik = %(cik)s""",
            {"periodic": list(PERIODIC), "delist": list(DELISTING), "dereg": list(DEREGISTRATION), "cik": c.cik},
        ).fetchone()
        last_periodic, last_coc, last_delist, last_dereg = f
        deal_docs = conn.execute(
            "select form, filing_date from raw.sec_filing where cik = %s and form = any(%s) and filing_date >= %s"
            " order by filing_date",
            (c.cik, list(DEAL_DOCS), today - timedelta(days=PENDING_DAYS)),
        ).fetchall()
        derived = classify(listed, last_periodic, deal_docs, last_coc, today)
        curated = c.status
        agrees = (curated == "active") == (derived in ("active", "pending"))
        rows.append({
            "cik": c.cik, "ticker": c.ticker, "derived": derived, "curated": curated, "agrees": agrees,
            "common_listed": listed, "last_periodic": last_periodic, "last_change_of_control": last_coc,
            "last_delisting": last_delist, "last_deregistration": last_dereg,
            "pending_since": deal_docs[0][1] if derived == "pending" else None,
            "pending_forms": "; ".join(f"{form} {d.isoformat()}" for form, d in deal_docs) if derived == "pending" else None,
        })
    return rows


def build(conn, today: date | None = None) -> list[dict]:
    rows = derive(conn, today)
    conn.execute("delete from core.company_status")
    with conn.cursor() as cur:
        cur.executemany(
            """insert into core.company_status(cik, derived, curated, agrees, common_listed, last_periodic,
                 last_change_of_control, last_delisting, last_deregistration, pending_since, pending_forms, checked_on)
               values (%(cik)s, %(derived)s, %(curated)s, %(agrees)s, %(common_listed)s, %(last_periodic)s,
                 %(last_change_of_control)s, %(last_delisting)s, %(last_deregistration)s, %(pending_since)s,
                 %(pending_forms)s, %(checked_on)s)""",
            [{**r, "checked_on": today or date.today()} for r in rows],
        )
    conn.commit()
    for r in rows:
        if not r["agrees"]:
            log.error("status: %s is labelled %r in sil/universe.py but its filing record says %s (last periodic"
                      " report %s, listed %s, last Form 25 %s, last Form 15 %s)", r["ticker"], r["curated"],
                      r["derived"], r["last_periodic"], r["common_listed"], r["last_delisting"],
                      r["last_deregistration"])
        elif r["derived"] == "pending":
            log.info("status: %s has a pending deal (%s)", r["ticker"], r["pending_forms"])
    return rows


def check(conn) -> None:
    """Refuse to publish when a curated label contradicts the filing record."""
    bad = conn.execute(
        "select c.ticker, s.curated, s.derived from core.company_status s join ref.company c using (cik)"
        " where not s.agrees order by c.ticker"
    ).fetchall()
    if bad:
        detail = ", ".join(f"{t} (labelled {cur}, filings say {der})" for t, cur, der in bad)
        raise SystemExit(f"stale company status in sil/universe.py: {detail}. Fix the labels, then re-run.")


def active_ciks(conn) -> set[int]:
    """Companies that are independent and still reporting (pending deals included): the stress lab's set."""
    return {r[0] for r in conn.execute(
        "select s.cik from core.company_status s join ref.company c using (cik)"
        " where s.derived in ('active', 'pending') and c.status = 'active'"
    )}
