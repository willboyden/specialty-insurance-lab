# Claims and reserves

What each carrier pays, how its estimates of past years move, and how long its claims take to settle: built from the
loss-reserve roll-forward every property-casualty filer discloses, plus (once the filing documents are downloaded)
the accident-year claims-development tables in each 10-K.

Code: `sil/claims.py` (build and export), `sil/sources/xbrl_instance.py` (10-K instance reader), tables in
`db/migrations/006_claims.sql`, dashboard section `dashboard/src/sections/claims.ts` with its charts
`dashboard/src/charts/claims-*.ts`. Tests: `tests/test_claims.py`, `dashboard/tests/claims.test.ts`.

```
uv run python -m sil domains claims     # rebuild core.claims_* and write dashboard/public/data/claims.json
```

## Sources

| Source | What | Access |
|---|---|---|
| SEC XBRL company facts (`raw.xbrl_fact`, loaded by `python -m sil ingest sec`) | The roll-forward of the liability for unpaid claims (ASC 944-40-50-3) in every 10-Q and 10-K: paid losses for the current and prior accident years, reserves assumed in acquisitions, FX; reinsurance recoverable on unpaid claims; IBNR and case reserves where tagged | data.sec.gov, public; no document download |
| `core.company_quarter` (`sil/standardize.py`) | Net premiums earned, incurred losses (current and prior accident years), equity, net and gross reserves | derived from the same facts, so every number agrees with the rest of the dashboard |
| 10-K XBRL instances (`raw.sec_document`, cached by `python -m sil ingest secdocs`) | Short-duration claims-development disclosures (ASU 2015-09, fiscal 2016 on): cumulative incurred and paid claims by accident year and line, IBNR, cumulative reported claim counts, average annual payout percentages | www.sec.gov; needs the declared SEC contact; this module only reads documents already in the cache |

All SEC material is public. Nothing in this domain touches the network.

## Method

**Fact layer.** For each claims tag, the most recently filed value of each period (restatements win). Quarters are a
reported three-month value or the difference of two year-to-date values with the same start; balance-sheet values are
aligned to the nearest quarter end within 15 days; fiscal-year values are 350–380-day durations. This mirrors
`db/views/010_core_facts.sql`, reading `raw.xbrl_fact` directly because the claims tags are outside `ref.concept_tag`.

**Tag resolution.** Each concept lists its tags in priority order (`CLAIM_TAGS`); a value must fall inside a bound
relative to net premiums earned (`PAID_BOUNDS`: current-year paid 0–2.5×, prior-year paid 0–4×, total paid
0.02–4×). A negative value whose absolute value fits is sign-flipped (a few filers tag paid losses negative).

**Paid losses** = current-year + prior-year paid when both are tagged (`cy+py`); otherwise the total
(`PaymentsForLossesAndLossAdjustmentExpense`, which equals the sum wherever both exist), with prior-year paid derived
as total minus current-year when only that part is tagged (`total-cy`). `paid_basis` records which.

**Fiscal years.** A row per company per fiscal-year end: the months in which the company reports annual
roll-forward flows (December for companies that never tag one), so years without paid-loss tags still carry
development and reserve ratios. Annual premiums and incurred losses are the panel's trailing four quarters at the
fiscal-year end, else the annual facts (20-F filers). Net reserves fall back to gross minus the recoverable on
unpaid claims when only those are tagged (Everest, 2016 on).

**Definitions** (fiscal year *t*, reserves net of reinsurance unless named gross):

| Metric | Definition | Bounds kept |
|---|---|---|
| Paid loss ratio | paid / net premiums earned | 0–4 |
| Incurred loss ratio | incurred / net premiums earned | 0–4 |
| Paid to incurred | paid / incurred (below 1: reserves grow) | 0–5 |
| First-year payout | current-accident-year paid / current-accident-year incurred | 0–1.2 |
| Run-off speed | prior-accident-year paid / opening reserves | 0–1.5 |
| Survival ratio | closing reserves / paid (years of payments held) | 0–30 |
| Reserves to premium | closing reserves / net premiums earned | 0–30 |
| Reserves to equity | closing reserves / equity | 0–15 |
| Reserve development | prior-accident-year development / opening reserves (negative = favorable) | ±0.6 |
| Development, points of premium | prior-accident-year development / net premiums earned | ±1 |
| Reinsured share of reserves | recoverable on unpaid claims / gross reserves (else 1 − net / gross) | 0–1 |
| IBNR share | IBNR / (IBNR + case reserves), where both are tagged | 0–1 |
| Reserve growth | closing / opening − 1 | −0.9–5 |
| Roll-forward gap | (closing − (opening + incurred − paid + acquired + FX)) / opening; a data check | ±1 |

Segment medians use comparable carriers with at least three values in the year.

**Accident-year development.** `parse_instance` streams a 10-K instance and keeps the us-gaap elements whose name
starts with `Shortduration`; `classify` maps them to incurred, paid, IBNR, reported claims, payout year *n* or the
line's total liability. The accident year comes from a dimension whose axis name contains *accident*, *underwriting*,
*policy* or *report year* (explicit or typed member with a four-digit year; aggregate members such as "prior to 2015"
are skipped); the line is the remaining members' names, CamelCase split. The evaluation year is the context's end
year. Development of an accident year = latest cumulative incurred / first estimate − 1; age-to-age factors are
volume-weighted over the accident years present at both ages; severity = latest incurred / reported claims. The
dashboard shows the latest 10-K's tables per company (up to ten lines, largest first).

## Caveats

- **Tagging, not accounting.** A blank cell means the carrier did not tag the item comparably that year, not that it
  was zero. Travelers stops tagging paid losses after 2012 and The Hartford after 2011; Cincinnati tags only the total in 2025.
- **Fiscal years are the filer's.** Companies with a non-December year end are labelled by the calendar year in which
  it ends.
- **IBNR share** is tagged by only a handful of carriers (mostly reinsurers) and is usually a gross figure.
- **The roll-forward gap** is not an error by itself: commutations, retroactive reinsurance (loss-portfolio
  transfers) and lines outside the tagged table move reserves too.
- **Paid-to-incurred below 100% is not a reserve verdict.** A growing book incurs new business at once and pays it
  over years (the section shows the cross-carrier relationship for the chosen year).
- **Triangles appear only for documents in the cache.** Until `python -m sil ingest secdocs` has run, the accident-
  year views show a plain note; the roll-forward views do not depend on them.
