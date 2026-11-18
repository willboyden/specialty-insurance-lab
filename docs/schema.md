# Database schema

Generated from the live Postgres database by `scripts/schema_doc.py`.

## `core.company_quarter` (table, 2,637 rows)

Standardized quarterly financials and ratios (quarterly and trailing four quarters).

`cik` integer, `qend` date, `acq_cost` double precision, `aoci` double precision, `assets` double precision, `buybacks` double precision, `cy_losses` double precision, `debt` double precision, `debt_afs` double precision, `dividends` double precision, `equity` double precision, `equity_securities` double precision, `gpw` double precision, `gross_reserves` double precision, `inv_gains` double precision, `investments` double precision, `losses` double precision, `net_income` double precision, `net_reserves` double precision, `nii` double precision, `npe` double precision, `npw` double precision, `oci` double precision, `other_uw_exp` double precision, ... (85 columns)

## `core.company_year` (table, 705 rows)

Fiscal-year view of the ratios.

`cik` integer, `ticker` text, `fiscal_year` integer, `qend` date, `npe` double precision, `npw` double precision, `losses` double precision, `cy_losses` double precision, `py_development` double precision, `acq_cost` double precision, `nii` double precision, `net_income` double precision, `equity` double precision, `net_reserves` double precision, `investments` double precision, `loss_ratio` double precision, `cy_loss_ratio` double precision, `pyd_ratio` double precision, `expense_ratio` double precision, `combined_ratio` double precision, `roe` double precision, `npe_growth_yoy` double precision, `bv_growth_yoy` double precision, `reserve_to_npe` double precision, ... (30 columns)

## `core.concept_value` (table, 52,224 rows)

Each concept per company-quarter with the tag it came from, how it was derived and any flag.

`cik` integer, `qend` date, `concept` text, `value` double precision, `tag` text, `derivation` text, `flag` text

## `core.fact_annual` (view, 15,007 rows)

View: fiscal-year values (for annual-only Schedule III tags).

`cik` integer, `tag` text, `fy_end` date, `value` numeric, `filed` date

## `core.fact_instant` (materialized view, 23,744 rows)

Materialized: balance-sheet values at quarter ends.

`cik` integer, `tag` text, `qend` date, `value` numeric, `filed` date

## `core.fact_latest` (materialized view, 89,785 rows)

Materialized: the most recently filed value per company, tag and period.

`cik` integer, `tag` text, `period_start` date, `period_end` date, `value` numeric, `accession` text, `filed` date, `form` text

## `core.fact_quarter` (materialized view, 42,253 rows)

Materialized: discrete quarters (reported 3-month values, else year-to-date differences).

`cik` integer, `tag` text, `qend` date, `value` numeric, `derivation` text, `filed` date

## `core.macro_quarter` (table, 148 rows)

Quarterly risk drivers built from the raw macro, geopolitical and catastrophe tables.

`qend` date, `ust10y` double precision, `ust2y` double precision, `ust5y` double precision, `ust5y_end` double precision, `breakeven10` double precision, `epu` double precision, `brent` double precision, `cpi_yoy` double precision, `med_cpi_yoy` double precision, `auto_repair_cpi_yoy` double precision, `legal_ppi_yoy` double precision, `ppi_pc_yoy` double precision, `ppi_liab_yoy` double precision, `ppi_comauto_yoy` double precision, `ppi_cmp_yoy` double precision, `ppi_wc_yoy` double precision, `ppi_medmal_yoy` double precision, `ppi_home_yoy` double precision, `gdp_yoy` double precision, `real_gdp_yoy` double precision, `unrate` double precision, `recession` double precision, `nfci` double precision, ... (43 columns)

## `meta.ingest_run` (table, 13 rows)

One row per ingest run: source, status, rows loaded, timing.

`run_id` bigint, `source` text, `status` text, `started_at` timestamp with time zone, `finished_at` timestamp with time zone, `rows_loaded` bigint, `detail` jsonb

## `meta.schema_migrations` (table, 3 rows)

Applied migration files.

`version` text, `applied_at` timestamp with time zone

## `model.backtest` (table, 1,524 rows)

Rolling-origin backtest: every forecast with the actual value and the naive benchmarks.

`origin` date, `cik` integer, `h` integer, `qend` date, `actual` double precision, `naive4` double precision, `avg` double precision, `fc_p50` double precision, `fc_p10` double precision, `fc_p90` double precision, `fc_p25` double precision, `fc_p75` double precision, `kn_p50` double precision, `kn_p10` double precision, `kn_p90` double precision

## `model.industry_shock` (table, 938 rows)

The latent industry (catastrophe) shock by quarter, posterior mean and 80% interval.

`run_id` bigint, `qend` date, `f_mean` double precision, `f_p10` double precision, `f_p90` double precision

## `model.loss_param` (table, 5,597 rows)

Posterior summaries per company (long-run loss ratio, persistence, sensitivities, noise).

`run_id` bigint, `cik` integer, `param` text, `mean` double precision, `sd` double precision, `lo` double precision, `hi` double precision, `r_hat` double precision

## `model.run` (table, 14 rows)

One row per model fit: features, data end, convergence diagnostics.

`run_id` bigint, `created_at` timestamp with time zone, `kind` text, `params` jsonb, `metrics` jsonb

## `model.scenario_summary` (table, 2,516 rows)

Reference scenario simulations per company (quantiles, probabilities).

`run_id` bigint, `scenario` text, `severity` double precision, `cik` integer, `summary` jsonb

## `raw.efts_term_hit` (table, 12,617 rows)

SEC full-text search: one row per (company, risk theme, 10-K/10-Q filing) that mentions it.

`cik` integer, `term_key` text, `accession` text, `form` text, `file_date` date, `period_end` date

## `raw.fema_declaration` (table, 70,599 rows)

OpenFEMA disaster declarations by designated area.

`id` text, `disaster_number` integer, `state` text, `declaration_type` text, `declaration_date` date, `incident_type` text, `declaration_title` text, `incident_begin` date, `incident_end` date, `designated_area` text, `fips_state` text, `fips_county` text, `ih_program` boolean, `ia_program` boolean, `pa_program` boolean, `hm_program` boolean

## `raw.fred_observation` (table, 74,660 rows)

FRED observations (daily, weekly, monthly, quarterly as published).

`series_id` text, `obs_date` date, `value` double precision

## `raw.fred_series` (table, 27 rows)

FRED series used, with the title read from FRED and the role in the model.

`series_id` text, `title` text, `units` text, `frequency` text, `role` text, `source_url` text, `fetched_at` timestamp with time zone

## `raw.gpr_observation` (table, 117,424 rows)

Caldara-Iacoviello Geopolitical Risk index, every published variable, monthly.

`month` date, `variable` text, `value` double precision

## `raw.noaa_billion_event` (table, 403 rows)

NOAA billion-dollar weather and climate disasters, 1980-2024 (CPI-adjusted cost).

`name` text, `disaster_type` text, `begin_date` date, `end_date` date, `cpi_adjusted_cost_musd` double precision, `unadjusted_cost_musd` double precision, `deaths` integer

## `raw.noaa_global_temp` (table, 146 rows)

Global land-ocean temperature departure, complete years.

`year` integer, `anomaly_c` double precision

## `raw.noaa_global_temp_month` (table, 1,762 rows)

Global land-ocean temperature departure, monthly.

`month` date, `anomaly_c` double precision

## `raw.sec_company` (table, 62 rows)

SEC submissions metadata per company (SIC, incorporation, tickers, former names).

`cik` integer, `name` text, `sic` text, `sic_description` text, `category` text, `entity_type` text, `state_of_incorporation` text, `fiscal_year_end` text, `tickers` text[], `exchanges` text[], `former_names` jsonb, `fetched_at` timestamp with time zone

## `raw.sec_filing` (table, 95,789 rows)

Every filing in each company's EDGAR index (10-K, 10-Q, 8-K, Forms 3/4/5, proxies ...).

`accession` text, `cik` integer, `form` text, `filing_date` date, `report_date` date, `acceptance_datetime` timestamp with time zone, `act` text, `file_number` text, `items` text, `size_bytes` bigint, `is_xbrl` boolean, `is_inline_xbrl` boolean, `primary_document` text, `primary_doc_description` text

## `raw.storm_event_month` (table, 97,974 rows)

NOAA Storm Events aggregated to month x state x event type (damage, deaths, injuries).

`month` date, `state` text, `event_type` text, `n_events` integer, `property_damage_usd` double precision, `crop_damage_usd` double precision, `deaths_direct` integer, `injuries_direct` integer

## `raw.xbrl_concept` (table, 3,746 rows)

Label and definition of every XBRL concept seen.

`taxonomy` text, `tag` text, `label` text, `description` text

## `raw.xbrl_fact` (table, 1,092,774 rows)

Every XBRL fact in every filing (companyfacts API); restated values keep their original rows.

`cik` integer, `taxonomy` text, `tag` text, `unit` text, `period_start` date, `period_end` date, `value` numeric, `accession` text, `fiscal_year` integer, `fiscal_period` text, `form` text, `filed` date, `frame` text

## `ref.company` (table, 62 rows)

The curated universe: ticker, cohort, segment, status (active / acquired / exited), comparability.

`cik` integer, `ticker` text, `short_name` text, `cohort` text, `segment` text, `status` text, `status_year` integer, `status_note` text, `include_note` text, `comparable` boolean

## `ref.concept_tag` (table, 61 rows)

Insurance concepts and the XBRL tags that can carry them, in priority order.

`concept` text, `tag` text, `priority` integer, `kind` text, `note` text

## `ref.driver` (table, 41 rows)

Labels, units and groups of the quarterly risk drivers.

`driver` text, `label` text, `unit` text, `grp` text
