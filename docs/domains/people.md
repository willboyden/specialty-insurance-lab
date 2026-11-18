# People and technology

The dashboard section "People and technology" (`dashboard/src/sections/people.ts`) answers: how many people does
each carrier employ, how much premium does each person support, did staff grow as fast as premium, what do carriers
spend on property, equipment and software, and how often do their filings discuss technology.

Code: `sil/people.py` (sources, `core.people_year`, `people.json`), `sil/sources/dol5500.py`,
`sil/sources/headcount.py`, `sil/sources/tech_mentions.py`, `db/migrations/008_people.sql`,
`tests/test_people.py`.

## Sources

| Source | What | Years | Terms |
|---|---|---|---|
| [DOL Form 5500 datasets](https://www.dol.gov/agencies/ebsa/about-ebsa/our-activities/public-disclosure/foia/form-5500-datasets) (EFAST2, `F_5500_<year>_Latest.zip`) | Active participants of each company's 401(k) plans | form years 2009-2025 | public records published by the US Department of Labor |
| SEC XBRL company facts (already loaded) | share-based pay, 401(k) cost, labor expense, capital spending, capitalized software | 2009- | public filings |
| SEC full-text search (efts.sec.gov) | technology themes in every 10-K and 10-Q | 2010- (2001 searched) | public filings |
| FRED: CES5552400001 (BLS), N4360C0A173NBEA and N4460C0A052NBEA (BEA), CIS2025240000000I (BLS ECI) | industry employment, full-time equivalents, wages per FTE, wage growth | 1990-2026 | public US government series |
| AI-indicator companies' companyfacts (cached) | R&D of Microsoft, Alphabet, Meta, Oracle, NVIDIA (Amazon reports no R&D line) | 2007- | public filings |
| 10-K primary documents (www.sec.gov, downloaded centrally by `ingest secdocs`) | reported headcount and technology vocabulary | when downloaded | public filings |

Run: `python -m sil ingest dol5500 efts_tech people_fred ai_rd`, then `python -m sil domains people`. Once the
filing documents are cached: `python -m sil ingest headcount`, then `python -m sil domains people` again: the
"Reported headcount (10-K)" measure switches on by itself when at least five companies have a number.

## Method

**US staff (proxy).** Form 5500 line 6a(2) (`TOT_ACTIVE_PARTCP_CNT`) counts employees actively covered by a plan at
the end of the plan year. For a 401(k) plan (pension feature code `2J`) that is roughly everyone eligible to save in
it. Per company and plan year the section sums the active participants of its 401(k) plans.

- Matching is by employer ID (EIN) only, from the reviewed list `SPONSORS` in `sil/sources/dol5500.py`. The list
  was built by searching every dataset for each company's names and checking each candidate sponsor's name, NAICS
  business code and plan names. Name matching alone caught many namesakes (Alterra Mountain, Destination XL,
  Alleghany Memorial Hospital, Berkley College, Validus Senior Living), so it is not used.
- One row per plan and plan year: a plan filed late for several years appears several times in one dataset, and
  the latest filing wins. Zero counts (the final filing of a frozen plan) are dropped. Plans of the same employer
  are summed: they cover different groups (Chubb's Puerto Rico plan, RLI's bonding subsidiary).
- Sponsors that changed hands carry year bounds (TransRe counts for Alleghany from 2012; Sirius for SiriusPoint from
  2021), and a company is counted only in the years it reported premiums as an independent filer.
- Only the sponsor, plan and count fields are loaded. The public files also contain signer names and phone numbers;
  they are never stored.

**Reported headcount.** `sil/sources/headcount.py` reads each 10-K's Employees / Human Capital paragraph ("As of
December 31, 2024, we had approximately 2,550 employees"), first under those headings (a heading line, not a sentence
that starts "Our employees handle ..."), the explicit wordings ("we had N employees") in every such section before the
looser "approximately N staff" anywhere, then anywhere with stricter wording; it keeps the sentence it read the number
from (shown in the data as `snippet`) and refuses numbers outside 5 to 400,000. Not a headcount: an age or tenure
("the average age of our workforce is 41 years"), a change in staff ("staff reductions of approximately 150
employees"), a department ("89 employees in our underwriting department") or the insureds' staff ("risks with more
than 50 employees"). A group with non-insurance businesses is measured by the insurance staff its 10-K states
("of whom approximately 5,600 were employed within our insurance operations": Markel; Alleghany's "Total reinsurance
and insurance subsidiaries" table row), and its years without that split are left out of per-employee views.

How it was checked: every year-to-year jump beyond 2.5x was read (the ones left are real: PXRE becoming Argo in
2007, St. Paul becoming Travelers in 2004, Third Point Re becoming SiriusPoint in 2021), and random samples of the
extracted sentences were read by hand (16 of 16 right for fiscal 2009 on after the fixes). Specialty 10-Ks of fiscal
2009 on give a number in 431 of 447 cases; Validus states its staff only in a table by location, and Accelerant as "574 ... Exchange Services, Underwriting and Corporate employees ... and an additional 288 Mission employees"; both are missing.

**Per-employee views.** Premium per employee is net premiums earned over staff. With the US-plan measure the
Bermuda and international groups are left out of the per-employee views (most of their staff work outside the US);
for other carriers with overseas operations the figure runs high, as the caption says. Staff growth against
premium growth compares five-year compound rates; carriers without staff counts at both ends are left out. The
efficiency scatter reports a Spearman rank correlation and calls it a relationship only when its t statistic
reaches 2.

**Capital spending.** `PaymentsToAcquireProductiveAssets` when reported, otherwise
`PaymentsToAcquirePropertyPlantAndEquipment` plus `PaymentsToDevelopSoftware`, over net premiums earned, summed over
three years. It counts buildings as well as systems. Markel is left out: its consolidated figure includes the Markel
Ventures manufacturing and service businesses. Insurers do not report research and development.

**Technology in the filings.** The same method as the risk themes: a 10-K or 10-Q counts when SEC full-text search
finds one of the theme's phrases in any of its documents; the share divides by the company's 10-K and 10-Q filings
that year. The general AI theme reuses the core search (`raw.efts_term_hit`, read only); the others live in
`raw.efts_tech_hit`, so the model's disclosure inputs never change because of this section.

## Known gaps

- No US plan matched for Bowhead, Hamilton, Pelagos (Fidelis) and International General (no US plan under their
  names in the full Form 5500 data; plans under 100 people file the short Form 5500-SF, which is not loaded).
- SiriusPoint: no plan filing found for 2022. AFG: until the 2021 sale of the annuity business its 401(k) plan also
  covered annuity staff.
- The proxy misses staff outside the US and new hires not yet eligible; it is labelled as a proxy everywhere.
- Reported 10-K headcount is worldwide and as each company words it (employees, associates, full-time equivalents).
