"""People and technology: the 10-K headcount extractor, technology vocabulary, Form 5500 matching and metrics.

All offline: synthetic text and in-memory frames, no database, no network.
"""

from __future__ import annotations

import io
import zipfile
from datetime import date

import pytest

from sil.sources.dol5500 import Matcher, scan
from sil.sources.headcount import extract_headcount, fiscal_year, tech_counts
from sil.sources.sec_docs import html_to_text


# ---------------------------------------------------------------- headcount
@pytest.mark.parametrize(
    ("text", "employees", "full_time", "as_of"),
    [
        ("Human Capital\nAs of December 31, 2024, we had approximately 2,550 employees, 62 of whom work part-time.\n",
         2550, None, date(2024, 12, 31)),
        ("Employees\nAt December 31, 2019, we employed 1,103 people, all located in the United States.\n",
         1103, None, date(2019, 12, 31)),
        ("Employees. As of February 15, 2008, the Company had 312 full-time employees.\n", 312, 312, date(2008, 2, 15)),
        ("Our People\nOur workforce consisted of 4,980 employees at year end.\n", 4980, None, None),
        (("Human Capital Resources\nWe have a total of 670 employees. Of these, 650 are full-time employees and 20 are"
          " part-time.\n"), 670, None, None),
        ("Human Capital\nOur headcount was 1,099 as of December 31, 2023.\n", 1099, None, date(2023, 12, 31)),
    ],
)
def test_headcount_section_wordings(text, employees, full_time, as_of):
    hc = extract_headcount(text)
    assert hc.employees == employees
    if full_time is not None:
        assert hc.full_time == full_time
    assert hc.as_of == as_of
    assert hc.method.startswith("section:")
    assert str(employees)[:2] in hc.snippet.replace(",", "")


def test_headcount_skips_percentages_years_and_part_time_counts():
    text = ("Human Capital\nIn 2024, 45% of our employees took part in training. We hired 120 part-time staff.\n"
            "As of December 31, 2024, we had 830 employees.\n")
    hc = extract_headcount(text)
    assert hc.employees == 830


def test_headcount_ignores_ages_and_prefers_the_total_over_a_subgroup():
    text = ("Claims\nOur employees handle nearly all of our claims. As of December 31, 2021, we employed about 530 internal"
            " property claim representatives and about 190 staff field adjusters.\nHuman Capital\nAs of December 31, 2021,"
            " we had about 49,000 employees. The average age of our workforce is 41 years.\n")
    hc = extract_headcount(text)
    assert hc.employees == 49_000 and hc.method == "section:verb-count-noun"
    assert extract_headcount("Human Capital\nThe average age of our workforce is 41 years.\n").employees is None


@pytest.mark.parametrize("text", [
    "Employees\nIn January 2009, we began a restructuring plan that includes staff reductions of approximately 150 employees.\n",
    "Employees\nAs of December 31, 2009, we had a total of 89 employees in our underwriting department.\n",
    "Underwriting\nWe avoid writing risks with more than 50 employees in any one building.\n",
    "Human Capital\nDuring 2021, we hired more than 13,000 new employees.\n",
    "Business\nThe MGAs with which we partner are typically MGAs with a headcount of 15 to 30 employees.\n",
])
def test_headcount_skips_changes_subgroups_and_insureds_staff(text):
    assert extract_headcount(text).employees is None


def test_headcount_of_a_groups_insurance_operations():
    text = ("Property and Casualty Insurance Operations\nAFG’s property and casualty insurance operations had approximately"
            " 6,500 employees as of December 31, 2020. The annuity operations had approximately 600 employees.\n")
    assert extract_headcount(text).employees == 6_500


MARKEL_2024 = ("Employees\nAt December 31, 2024, we had approximately 22,000 employees, of whom approximately 5,600 were"
               " employed within our insurance operations and approximately 16,400 were employed within our Markel"
               " Ventures operations.\n")
MARKEL_2019 = ("Employees\nAt December 31, 2019, we had approximately 18,600 employees, of whom approximately 14,000 were"
               " employed within our Markel Ventures operations.\n")
ALLEGHANY_2016 = ("Employees\nAs of December 31, 2016, we employed a total of 3,420 persons, as follows: | TransRe | 609 |"
                  " AIHL and subsidiaries | 830 | Total reinsurance and insurance subsidiaries | 1,439 | Alleghany Capital"
                  " | 1,958 |\n")
ALLEGHANY_2012 = ("Employees\nAs of December 31, 2012, we employed a total of 1,506 persons, with 14 persons employed at the"
                  " parent company, 636 persons employed at TransRe, 778 persons employed at our insurance operating"
                  " units.\n")


@pytest.mark.parametrize(("text", "total", "insurance"), [
    (MARKEL_2024, 22_000, 5_600),
    (MARKEL_2019, 18_600, 4_600),
    (ALLEGHANY_2016, 3_420, 1_439),
    (ALLEGHANY_2012, 1_506, 1_414),
    ("Employees\nAs of December 31, 2024, we had 2,550 employees.\n", 2_550, None),
])
def test_insurance_staff_of_groups_with_other_businesses(text, total, insurance):
    hc = extract_headcount(text)
    assert hc.employees == total and hc.insurance == insurance


def test_heading_is_not_the_start_of_a_sentence():
    from sil.sources.headcount import HEADING
    assert not HEADING.search("Our employees handle nearly all of our claims.")
    assert HEADING.search("Human Capital We believe that our people matter.")
    assert HEADING.search("Employees. As of December 31, 2024, we had 2,550 employees.")
    assert HEADING.search("Human Capital\n")


def test_headcount_document_fallback_needs_explicit_wording():
    text = ("Item 7. Management's discussion. We paid claims to 2,000 policyholders.\n"
            "Elsewhere: at year end the Company employed approximately 4,100 people worldwide.\n")
    hc = extract_headcount(text)
    assert hc.employees == 4100
    assert hc.method.startswith("document:")


def test_headcount_none_when_absent():
    hc = extract_headcount("Item 1. Business\nWe write specialty insurance.\nItem 1A. Risk Factors\n")
    assert hc.employees is None and hc.method == "none"


def test_headcount_refuses_implausible_numbers():
    hc = extract_headcount("Employees\nWe had 3 employees and 900,000 agents.\n")
    assert hc.employees is None


def test_headcount_from_inline_xbrl_html():
    html = ("<html><body><div style='display:none'><ix:header>hidden 99,999 employees</ix:header></div>"
            "<p><b>Human Capital</b></p><p>As of December 31, 2022, we employed 2,345 employees.</p></body></html>")
    hc = extract_headcount(html_to_text(html))
    assert hc.employees == 2345


def test_fiscal_year_from_report_date():
    assert fiscal_year(date(2024, 12, 31), date(2025, 2, 20)) == 2024
    assert fiscal_year(date(2025, 3, 31), date(2025, 5, 20)) == 2024
    assert fiscal_year(None, date(2025, 2, 20)) == 2024


# ---------------------------------------------------------------- technology vocabulary
def test_tech_counts_families_and_case():
    text = ("We use artificial intelligence (AI) and machine learning; generative AI and large language models "
            "support claims. Our cloud-based platform and data analytics team drive automation. AIG is not AI.")
    counts, words = tech_counts(text)
    assert counts["ai"] == 4  # "artificial intelligence", "(AI)", "generative AI" and "not AI"; never AIG
    assert counts["generative_ai"] == 2
    assert counts["machine_learning"] == 1
    assert counts["cloud"] == 1
    assert counts["analytics"] == 1
    assert counts["automation"] == 1
    assert words > 20


# ---------------------------------------------------------------- Form 5500 matching
def test_matcher_is_ein_only_and_every_sponsor_is_unique():
    from sil.sources.dol5500 import SPONSORS, year_bounds

    m = Matcher()
    assert m.match("90-0492124") is not None  # Kinsale Management, Inc., hyphenated as filed
    assert m.match("999999999") is None
    eins = [ein for rows in SPONSORS.values() for ein, *_ in rows]
    assert len(eins) == len(set(eins))
    assert all(len(e) == 9 and e.isdigit() for e in eins)
    bounds = year_bounds()
    assert all(lo is None or hi is None or lo <= hi for lo, hi in bounds.values())


def _zip_csv(rows: list[dict]) -> bytes:
    header = list(rows[0])
    out = io.StringIO()
    out.write(",".join(header) + "\n")
    for r in rows:
        out.write(",".join(r[h] for h in header) + "\n")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("f_5500_2023_latest.csv", out.getvalue())
    return buf.getvalue()


def test_scan_keeps_matched_pension_plans_only_and_drops_personal_fields():
    base = {
        "ACK_ID": "A1", "FORM_PLAN_YEAR_BEGIN_DATE": "2023-01-01", "FORM_TAX_PRD": "2023-12-31",
        "PLAN_NAME": "KINSALE 401K PLAN", "SPONS_DFE_PN": "001", "SPONSOR_DFE_NAME": "KINSALE MANAGEMENT INC",
        "SPONS_DFE_DBA_NAME": "", "SPONS_DFE_MAIL_US_STATE": "VA", "SPONS_DFE_EIN": "900492124",
        "BUSINESS_CODE": "524210", "TOT_PARTCP_BOY_CNT": "700", "TOT_ACTIVE_PARTCP_CNT": "650",
        "TOT_ACT_PARTCP_BOY_CNT": "600", "PARTCP_ACCOUNT_BAL_CNT": "690", "TYPE_PENSION_BNFT_CODE": "2E2F2G2J2K",
        "TYPE_WELFARE_BNFT_CODE": "", "FINAL_FILING_IND": "", "DATE_RECEIVED": "2024-07-01",
        "ADMIN_SIGNED_NAME": "A PERSON", "SPONS_DFE_PHONE_NUM": "5555555555",
    }
    welfare = {**base, "ACK_ID": "A2", "TYPE_PENSION_BNFT_CODE": "", "TYPE_WELFARE_BNFT_CODE": "4A"}
    other = {**base, "ACK_ID": "A3", "SPONSOR_DFE_NAME": "UNRELATED WIDGETS INC", "SPONS_DFE_EIN": "222222222"}
    namesake = {**base, "ACK_ID": "A4", "SPONSOR_DFE_NAME": "KINSALE HOLDINGS DBA VALIDANT", "SPONS_DFE_EIN": "202508375"}
    rows = scan(_zip_csv([base, welfare, other, namesake]), 2023, Matcher())
    assert len(rows) == 1
    r = rows[0]
    assert r[0] == "A1" and r[3] == "ein" and r[14] == 650
    assert "A PERSON" not in r and "5555555555" not in r
