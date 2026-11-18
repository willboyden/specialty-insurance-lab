# Catastrophes domain

What the catastrophe section of the dashboard shows, where each number comes from, and what it cannot tell you.
Code: `sil/sources/perils.py` (sources), `sil/sources/cat_losses.py` (reported losses), `sil/catastrophe.py`
(core tables, regression, export), `db/migrations/007_catastrophe.sql`, `tests/test_catastrophe.py`,
`dashboard/src/sections/catastrophes.ts` and `dashboard/src/charts/cat-*.ts`.

## Run it

```sh
uv run python -m sil migrate
uv run python -m sil ingest perils nfip        # public peril data (about a minute; NFIP pages in parallel)
uv run python -m sil domains catastrophe       # core tables + dashboard/public/data/catastrophe.json
```

Company-reported catastrophe losses need the filing documents (`uv run python -m sil ingest secdocs`, which
requires a declared SEC contact in `.env`); rerun `domains catastrophe` afterwards.

## Sources

All US federal data in the public domain, fetched through the project's caching client with a generic client name.

| Source | What | Coverage | Endpoint |
|---|---|---|---|
| NOAA NHC HURDAT2 | Atlantic best track: every 6-hourly fix, landfall and intensity records | 1851–2025 seasons | https://www.nhc.noaa.gov/data/hurdat/ |
| NOAA SPC severe weather database | Tornado, hail and damaging-wind reports with magnitudes | 1950 (tornado) / 1955 (hail, wind) – 2025 | https://www.spc.noaa.gov/wcm/ |
| USGS ComCat | Earthquakes M5+ in US states and territories | 1973 onward | https://earthquake.usgs.gov/fdsnws/event/1/ |
| NIFC | Wildland fires and acres burned per year | 1983–2025 | https://www.nifc.gov/fire-information/statistics/wildfires |
| NOAA CPC | Oceanic Niño Index (3-month running Niño 3.4 anomaly) | 1950 onward | https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt |
| OpenFEMA NFIP Redacted Claims v3 | Flood insurance claims: date of loss, state, named event, amounts paid | losses from 2000 | https://www.fema.gov/api/open/v3/NfipClaims |

Reused from the core layer: NOAA Storm Events (property damage by peril), NOAA billion-dollar events (ends 2024),
OpenFEMA disaster declarations, NOAA global temperature, and FRED CPI-U (the deflator for dollar amounts).

OpenFEMA's terms ask users to cite the endpoint and the retrieval date and to carry this notice, which the section
and the export repeat: "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not
endorsed by FEMA. The Federal Government or FEMA cannot vouch for the data or analyses derived from these data
after the data have been retrieved from the Agency's website(s)."

## Tables

- `raw.hurdat_point`, `raw.spc_report_month` (month x state x kind), `raw.usgs_quake`, `raw.nifc_wildfire_year`,
  `raw.enso_oni`, `raw.nfip_claim_month` (month of loss x state), `raw.nfip_event` (named flood events).
- `core.peril_quarter` (2000 on; the quarter keys match the drivers section, so crosshairs line up),
  `core.peril_year` (1950 on), `core.peril_state` (2000 on), `core.cat_shock_fit`, `core.cat_loss_reported`.

## Methods

**US hurricane landfalls.** HURDAT2 landfall records (`L`) at hurricane status whose position falls in coarse
coastal boxes for the Gulf and Florida, the Atlantic seaboard to Lubec, Maine, and Puerto Rico with the US Virgin
Islands; the boxes keep Mexico, Cuba, the Bahamas, Bermuda and Atlantic Canada out (tested on real landfall points).
A storm counts once per season, at its highest category over its US landfalls, dated at its first one. The
2017, 2020 and 2024 lists match NHC's (Harvey, Irma, Maria, Nate; six in 2020; Beryl to Milton) and 2025 has none.
Hawaii is not covered (HURDAT2's Atlantic file only).

**ACE.** Sum of (maximum wind in knots)² / 10⁴ over 6-hourly synoptic fixes at tropical or subtropical storm
strength (35 kt or more). It matches NOAA's published seasons for 2004, 2017, 2020 and 2024; 2005 reads 250 against
NOAA's 245 (subtropical systems and reanalysis).

**Severe convective storms.** SPC report counts; significant = tornado EF/F2 or stronger, hail 2 inches or larger,
wind 65 knots or more. SPC's loss column changed units twice (categories before 1996, millions of dollars
1996–2006, dollars from 2007): the parser detects the unit per year. Report counts depend on how many people
report, so a rise in reports is partly a rise in observation.

**NFIP.** Every claim with a loss since 2000 (1.69 million), summed by month of loss and state (building + contents
+ increased cost of compliance paid) and by named flood event. Dollar figures in the dashboard are at today's prices
(CPI-U of the month of loss to the latest month). Recent quarters keep growing as claims are settled.

**How much of the industry shock US perils explain.** The loss model infers a common quarterly shock from the
carriers' loss ratios without any catastrophe input. It is regressed (OLS with an intercept) on four standardized
indices, each as log(1 + x): US hurricane landfall index (sum of category squared), significant convective storm
reports, NFIP claims paid, and Storm Events wildfire damage, over 2010–2025 (64 quarters). Reported: R², adjusted
R², and a leave-one-year-out cross-validated R² (each year predicted by a fit without it). The fit is descriptive:
the shock also contains reserve releases and large single losses, and the carriers write worldwide.

**Catastrophe sensitivity.** The loss model's per-carrier loading on the shock (λ: loss-ratio points per 1σ), read
from the latest model run with its 89% interval. Nothing in this domain refits or changes the model.

**Reported catastrophe losses** (`sil/sources/cat_losses.py`). For each cached earnings-release exhibit (8-K item
2.02, EX-99.*), a figure counts only where the catastrophe losses are the subject or the object of a statement
("Catastrophe losses were $40 million", "including current accident year catastrophe losses of $78.5 million",
"we incurred $22.0 million of catastrophe losses"), never an amount that merely sits near the words. Left out: a
segment's figure (a segment or line of business named in the statement or just before it, a unit named right after
it, or an amount whose stated combined-ratio points imply a premium base far from the carrier's net premiums
earned), one named event's share, a range, an after-tax, ex-catastrophe, prior-year-development or outlook figure, a
month's figure, an amount followed by "and $X related to reestimates", and a statement whose own period phrase names
another year. Table rows count when labelled plainly "Catastrophe losses" under a "Three months ended" header (unit
from the nearest "in thousands / in millions" header; rows in points are skipped). The first statement about the
quarter in document order wins (releases state the group figure before the segments'); in a fourth-quarter release
only a statement that names the quarter. "No catastrophe losses in the quarter" counts only in a release that states
no amount for the quarter anywhere. A fourth quarter that only states the year is derived as the year minus the first
three quarters. A figure above 1.5x the quarter's premiums or above its total incurred losses is rejected. The release
is assigned to the latest quarter that ended within 120 days before filing. Only cached documents are read.

How it was checked: random samples of releases, each figure judged by hand against the sentence it came from. The
first proximity rules were right 6 times in a 14-item pilot, then 21 to 23 times in 40; the strict statements above
about 30 times in 39, then 32 to 35 in 39, then 37 in 40; a final sample of 40 stored values 36 to 37 times, the
uncertain ones being plausible table values the release does not explain. The two errors in that last sample ("no
catastrophe losses" statements about another period or a segment) were fixed afterwards. Figures the releases do not state plainly are simply missing: the strict
rules keep 396 carrier-quarters of 28 carriers out of 4,972 releases.

The validation correlates each carrier's reported catastrophe share of premiums with the model's λ x shock.

## Findings (data through 2026-11-18)

- US perils explain 40% of the industry shock's quarterly variation in sample (adjusted 36%) and 18% out of sample.
  Hurricane landfalls (+0.48σ per standard deviation, t = 3.7) and NFIP flood claims (+0.25σ, t = 2.0) carry it;
  convective storms and wildfire add nothing measurable once those are in.
- The largest gaps line up with non-US events: Q1 2011 (Tōhoku, Christchurch) shock +2.74σ, predicted −0.28σ.
  Q3 2017 is only half explained (+5.10σ against +2.25σ): the indices count US landfalls by category, not the size
  of each storm's losses, and see nothing outside the US.
- ENSO and Atlantic season energy correlate −0.35 over 76 seasons (1950–2025): El Niño seasons averaged 86 ACE,
  La Niña seasons 135. The Aug–Oct 2026 ONI is +2.46 °C, above every earlier Aug–Oct reading since 1950 (the
  previous high was +2.04).
- 2025 had no US hurricane landfall, the first such season since 2015.
- Large-hail reports averaged 854 a year in 2016–2025 against 524 in 1996–2005; EF2+ tornadoes 142 against 126.
- NFIP paid $80.2bn (nominal) on 1.69 million claims since 2000; Katrina alone $16.3bn ($28.0bn at today's prices).

## Limits

US indices only; international catastrophes appear only as unexplained shock. Storm Events under-records the largest
hurricanes. SPC report counts mix weather and observation. HURDAT2 covers the Atlantic basin only. The landfall
boxes and the ComCat place filter are approximations (tested on known points and places). Company-reported losses
depend on how each carrier words its releases (a hand check put about 9 in 10 of the stored values right, see above);
the sentence behind every figure is kept for review, and figures a release does not state plainly are left out.
