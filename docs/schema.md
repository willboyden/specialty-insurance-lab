# Database schema

Generated from the live Postgres database by `scripts/schema_doc.py`.

## `core.cat_loss_reported` (table, 396 rows)

`cik` integer, `qend` date, `cat_loss_usd` double precision, `cat_points` double precision, `basis` text, `accession` text, `url` text, `snippet` text

## `core.cat_shock_fit` (table, 6 rows)

`term` text, `label` text, `coef` double precision, `se` double precision, `t` double precision, `r` double precision, `n` integer, `r2` double precision, `adj_r2` double precision, `cv_r2` double precision, `window_start` date, `window_end` date

## `core.claims_ay` (table, 17,952 rows)

`cik` integer, `fy_filed` integer, `line` text, `accident_year` integer, `incurred_first` double precision, `incurred_latest` double precision, `paid_latest` double precision, `ibnr` double precision, `reported_claims` double precision

## `core.claims_payout` (table, 16,737 rows)

`cik` integer, `fy_filed` integer, `line` text, `year_n` integer, `pct` double precision

## `core.claims_quarter` (table, 2,269 rows)

`cik` integer, `qend` date, `paid` double precision, `paid_basis` text, `paid_ttm` double precision, `npe_ttm` double precision, `losses_ttm` double precision, `paid_lr_ttm` double precision, `incurred_lr_ttm` double precision, `paid_to_incurred_ttm` double precision

## `core.claims_triangle` (table, 179,881 rows)

`cik` integer, `fy_filed` integer, `accession` text, `line` text, `accident_year` integer, `eval_year` integer, `metric` text, `value` double precision

## `core.claims_year` (table, 689 rows)

`cik` integer, `fiscal_year` integer, `fy_end` date, `npe` double precision, `losses` double precision, `cy_losses` double precision, `py_development` double precision, `paid_cy` double precision, `paid_py` double precision, `paid` double precision, `paid_basis` text, `acquired` double precision, `fx` double precision, `net_reserves` double precision, `net_reserves_open` double precision, `gross_reserves` double precision, `recoverable_unpaid` double precision, `ibnr` double precision, `case_reserves` double precision, `equity` double precision, `paid_lr` double precision, `incurred_lr` double precision, `paid_to_incurred` double precision, `first_year_payout` double precision, ... (35 columns)

## `core.company_quarter` (table, 2,645 rows)

Standardized quarterly financials and ratios (quarterly and trailing four quarters).

`cik` integer, `qend` date, `acq_cost` double precision, `aoci` double precision, `assets` double precision, `buybacks` double precision, `cy_losses` double precision, `debt` double precision, `debt_afs` double precision, `dividends` double precision, `equity` double precision, `equity_securities` double precision, `gpw` double precision, `gross_reserves` double precision, `inv_gains` double precision, `investments` double precision, `losses` double precision, `net_income` double precision, `net_reserves` double precision, `nii` double precision, `npe` double precision, `npw` double precision, `oci` double precision, `other_uw_exp` double precision, ... (85 columns)

## `core.company_status` (table, 57 rows)

`cik` integer, `derived` text, `curated` text, `agrees` boolean, `common_listed` boolean, `last_periodic` date, `last_change_of_control` date, `last_delisting` date, `last_deregistration` date, `pending_since` date, `pending_forms` text, `checked_on` date

## `core.company_year` (table, 707 rows)

Fiscal-year view of the ratios.

`cik` integer, `ticker` text, `fiscal_year` integer, `qend` date, `npe` double precision, `npw` double precision, `losses` double precision, `cy_losses` double precision, `py_development` double precision, `acq_cost` double precision, `nii` double precision, `net_income` double precision, `equity` double precision, `net_reserves` double precision, `investments` double precision, `loss_ratio` double precision, `cy_loss_ratio` double precision, `pyd_ratio` double precision, `expense_ratio` double precision, `combined_ratio` double precision, `roe` double precision, `npe_growth_yoy` double precision, `bv_growth_yoy` double precision, `reserve_to_npe` double precision, ... (30 columns)

## `core.concept_value` (table, 52,280 rows)

Each concept per company-quarter with the tag it came from, how it was derived and any flag.

`cik` integer, `qend` date, `concept` text, `value` double precision, `tag` text, `derivation` text, `flag` text

## `core.fact_annual` (view, 15,007 rows)

View: fiscal-year values (for annual-only Schedule III tags).

`cik` integer, `tag` text, `fy_end` date, `value` numeric, `filed` date

## `core.fact_instant` (materialized view, 23,778 rows)

Materialized: balance-sheet values at quarter ends.

`cik` integer, `tag` text, `qend` date, `value` numeric, `filed` date

## `core.fact_latest` (materialized view, 89,895 rows)

Materialized: the most recently filed value per company, tag and period.

`cik` integer, `tag` text, `period_start` date, `period_end` date, `value` numeric, `accession` text, `filed` date, `form` text

## `core.fact_quarter` (materialized view, 42,289 rows)

Materialized: discrete quarters (reported 3-month values, else year-to-date differences).

`cik` integer, `tag` text, `qend` date, `value` numeric, `derivation` text, `filed` date

## `core.ma_activity_year` (table, 551 rows)

`cik` integer, `fy` integer, `acq_cash` numeric, `divest_proceeds` numeric, `goodwill` numeric, `intangibles` numeric, `equity` numeric, `gi_to_equity` numeric, `goodwill_acquired` numeric, `goodwill_impairment` numeric, `reserves_acquired` numeric, `n_completions` integer

## `core.ma_deal` (table, 25 rows)

`key` text, `cik` integer, `status` text, `announced` date, `announced_basis` text, `announced_accession` text, `first_proxy` date, `first_proxy_form` text, `first_proxy_accession` text, `closed` date, `closed_basis` text, `closed_accession` text, `deregistered` date, `days_to_close` integer, `acquirer_verified` boolean, `price_verified` boolean, `consideration_verified` boolean, `terms_verified` boolean, `shares` numeric, `shares_as_of` date, `book_quarter` date, `common_equity` numeric, `preferred` numeric, `book_per_share` numeric, ... (33 columns)

## `core.ma_event` (table, 25 rows)

`cik` integer, `filing_date` date, `accession` text, `items` text, `deal_key` text, `stayed_public` boolean

## `core.ma_listing` (table, 49 rows)

`cik` integer, `listed_from` date, `from_basis` text, `listed_until` date, `until_basis` text, `deal_key` text

## `core.macro_quarter` (table, 148 rows)

Quarterly risk drivers built from the raw macro, geopolitical and catastrophe tables.

`qend` date, `ust10y` double precision, `ust2y` double precision, `ust5y` double precision, `ust5y_end` double precision, `breakeven10` double precision, `epu` double precision, `brent` double precision, `cpi_yoy` double precision, `med_cpi_yoy` double precision, `auto_repair_cpi_yoy` double precision, `legal_ppi_yoy` double precision, `ppi_pc_yoy` double precision, `ppi_liab_yoy` double precision, `ppi_comauto_yoy` double precision, `ppi_cmp_yoy` double precision, `ppi_wc_yoy` double precision, `ppi_medmal_yoy` double precision, `ppi_home_yoy` double precision, `gdp_yoy` double precision, `real_gdp_yoy` double precision, `unrate` double precision, `recession` double precision, `nfci` double precision, ... (43 columns)

## `core.people_year` (table, 549 rows)

`cik` integer, `fiscal_year` integer, `employees_reported` integer, `us_plan_active` integer, `us_plan_count` integer, `npe` double precision, `uw_expense` double precision, `share_based_comp` double precision, `dc_plan_cost` double precision, `labor_expense` double precision, `capex` double precision, `software_capitalized` double precision, `software_net` double precision, `employees_total` integer

## `core.peril_quarter` (table, 108 rows)

`qend` date, `us_landfalls` integer, `us_major_landfalls` integer, `us_landfall_index` double precision, `ace` double precision, `tornadoes` integer, `sig_tornadoes` integer, `sig_hail` integer, `sig_wind` integer, `quakes_m5` integer, `quakes_m6` integer, `nfip_paid` double precision, `nfip_claims` integer, `storm_damage` double precision, `storm_damage_hurricane` double precision, `storm_damage_convective` double precision, `storm_damage_wildfire` double precision, `storm_damage_flood` double precision, `billion_cost` double precision, `fema_major` integer, `oni` double precision, `f_mean` double precision, `f_p10` double precision, `f_p90` double precision

## `core.peril_state` (table, 53 rows)

`state` text, `nfip_paid` double precision, `storm_damage` double precision, `storm_damage_hurricane` double precision, `storm_damage_convective` double precision, `storm_damage_wildfire` double precision, `storm_damage_flood` double precision, `sig_hail` integer, `sig_tornadoes` integer, `fema_major` integer

## `core.peril_year` (table, 76 rows)

`year` integer, `us_landfalls` integer, `us_landfalls_cat1` integer, `us_landfalls_cat2` integer, `us_landfalls_cat3` integer, `us_landfalls_cat4` integer, `us_landfalls_cat5` integer, `ace` double precision, `named_storms` integer, `hurricanes` integer, `tornadoes` integer, `sig_tornadoes` integer, `hail_reports` integer, `sig_hail` integer, `wind_reports` integer, `sig_wind` integer, `wildfire_fires` integer, `wildfire_acres` double precision, `nfip_paid` double precision, `nfip_claims` integer, `quakes_m5` integer, `quakes_m6` integer, `billion_cost` double precision, `billion_count` integer, ... (27 columns)

## `meta.ingest_run` (table, 51 rows)

One row per ingest run: source, status, rows loaded, timing.

`run_id` bigint, `source` text, `status` text, `started_at` timestamp with time zone, `finished_at` timestamp with time zone, `rows_loaded` bigint, `detail` jsonb

## `meta.schema_migrations` (table, 10 rows)

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

## `raw.ai_rd_annual` (table, 85 rows)

`cik` integer, `fiscal_year` integer, `period_end` date, `rd_usd` double precision

## `raw.claims_instance` (table, 339 rows)

`accession` text, `cik` integer, `fiscal_year` integer, `url` text, `n_facts` integer, `read_at` timestamp with time zone

## `raw.claims_instance_fact` (table, 242,373 rows)

`accession` text, `cik` integer, `element` text, `value` double precision, `unit` text, `decimals` text, `period_start` date, `period_end` date, `dims` jsonb

## `raw.dol5500_plan` (table, 1,118 rows)

`ack_id` text, `form_year` integer, `cik` integer, `match_kind` text, `sponsor_name` text, `sponsor_ein` text, `sponsor_state` text, `business_code` text, `plan_name` text, `plan_number` text, `plan_year_begin` date, `plan_year_end` date, `pension_codes` text, `welfare_codes` text, `active_eoy` integer, `active_boy` integer, `total_boy` integer, `with_balance` integer, `final_filing` boolean, `date_received` date

## `raw.efts_tech_hit` (table, 1,489 rows)

`cik` integer, `term_key` text, `accession` text, `form` text, `file_date` date, `period_end` date

## `raw.efts_term_hit` (table, 12,617 rows)

SEC full-text search: one row per (company, risk theme, 10-K/10-Q filing) that mentions it.

`cik` integer, `term_key` text, `accession` text, `form` text, `file_date` date, `period_end` date

## `raw.enso_oni` (table, 921 rows)

`year` integer, `season` text, `mid_month` integer, `total_c` double precision, `anom_c` double precision

## `raw.fema_declaration` (table, 70,599 rows)

OpenFEMA disaster declarations by designated area.

`id` text, `disaster_number` integer, `state` text, `declaration_type` text, `declaration_date` date, `incident_type` text, `declaration_title` text, `incident_begin` date, `incident_end` date, `designated_area` text, `fips_state` text, `fips_county` text, `ih_program` boolean, `ia_program` boolean, `pa_program` boolean, `hm_program` boolean

## `raw.fred_observation` (table, 75,249 rows)

FRED observations (daily, weekly, monthly, quarterly as published).

`series_id` text, `obs_date` date, `value` double precision

## `raw.fred_series` (table, 31 rows)

FRED series used, with the title read from FRED and the role in the model.

`series_id` text, `title` text, `units` text, `frequency` text, `role` text, `source_url` text, `fetched_at` timestamp with time zone

## `raw.gpr_observation` (table, 117,424 rows)

Caldara-Iacoviello Geopolitical Risk index, every published variable, monthly.

`month` date, `variable` text, `value` double precision

## `raw.headcount_10k` (table, 990 rows)

`accession` text, `cik` integer, `form` text, `filing_date` date, `fiscal_year` integer, `employees` integer, `full_time` integer, `as_of` date, `snippet` text, `method` text, `doc_url` text, `insurance_employees` integer, `insurance_basis` text

## `raw.hurdat_point` (table, 55,524 rows)

`storm_id` text, `storm_name` text, `season` integer, `obs_time` timestamp without time zone, `record_id` text, `status` text, `lat` double precision, `lon` double precision, `wind_kt` integer, `pressure_mb` integer

## `raw.ma_deal_check` (table, 176 rows)

`deal_key` text, `field` text, `phrase` text, `forms` text, `start_date` date, `end_date` date, `hits` integer, `first_date` date, `first_form` text, `first_accession` text, `first_file` text, `last_date` date, `last_accession` text, `last_file` text, `checked_at` timestamp with time zone

## `raw.ma_deal_doc_fact` (table, 346 rows)

`deal_key` text, `accession` text, `filename` text, `field` text, `value_text` text, `value_num` numeric, `snippet` text

## `raw.nfip_claim_month` (table, 12,404 rows)

`month` date, `state` text, `n_claims` integer, `n_paid` integer, `paid_building` double precision, `paid_contents` double precision, `paid_icc` double precision

## `raw.nfip_event` (table, 163 rows)

`flood_event` text, `first_loss` date, `last_loss` date, `n_claims` integer, `paid_total` double precision, `top_state` text

## `raw.nifc_wildfire_year` (table, 43 rows)

`year` integer, `fires` integer, `acres` double precision

## `raw.noaa_billion_event` (table, 403 rows)

NOAA billion-dollar weather and climate disasters, 1980-2024 (CPI-adjusted cost).

`name` text, `disaster_type` text, `begin_date` date, `end_date` date, `cpi_adjusted_cost_musd` double precision, `unadjusted_cost_musd` double precision, `deaths` integer

## `raw.noaa_global_temp` (table, 146 rows)

Global land-ocean temperature departure, complete years.

`year` integer, `anomaly_c` double precision

## `raw.noaa_global_temp_month` (table, 1,762 rows)

Global land-ocean temperature departure, monthly.

`month` date, `anomaly_c` double precision

## `raw.sec_company` (table, 63 rows)

SEC submissions metadata per company (SIC, incorporation, tickers, former names).

`cik` integer, `name` text, `sic` text, `sic_description` text, `category` text, `entity_type` text, `state_of_incorporation` text, `fiscal_year_end` text, `tickers` text[], `exchanges` text[], `former_names` jsonb, `fetched_at` timestamp with time zone

## `raw.sec_document` (table, 61,093 rows)

`accession` text, `cik` integer, `kind` text, `seq` integer, `description` text, `filename` text, `doc_type` text, `size_bytes` bigint, `url` text

## `raw.sec_document_index` (table, 5,901 rows)

`accession` text, `cik` integer, `kind` text, `n_documents` integer, `read_at` timestamp with time zone

## `raw.sec_filing` (table, 95,823 rows)

Every filing in each company's EDGAR index (10-K, 10-Q, 8-K, Forms 3/4/5, proxies ...).

`accession` text, `cik` integer, `form` text, `filing_date` date, `report_date` date, `acceptance_datetime` timestamp with time zone, `act` text, `file_number` text, `items` text, `size_bytes` bigint, `is_xbrl` boolean, `is_inline_xbrl` boolean, `primary_document` text, `primary_doc_description` text

## `raw.spc_report_month` (table, 53,304 rows)

`month` date, `state` text, `kind` text, `n_reports` integer, `n_significant` integer, `injuries` integer, `fatalities` integer, `loss_usd` double precision

## `raw.storm_event_month` (table, 97,974 rows)

NOAA Storm Events aggregated to month x state x event type (damage, deaths, injuries).

`month` date, `state` text, `event_type` text, `n_events` integer, `property_damage_usd` double precision, `crop_damage_usd` double precision, `deaths_direct` integer, `injuries_direct` integer

## `raw.tech_terms_10k` (table, 6,930 rows)

`accession` text, `cik` integer, `fiscal_year` integer, `term_key` text, `n` integer, `words` integer

## `raw.usgs_quake` (table, 3,537 rows)

`event_id` text, `time_utc` timestamp with time zone, `mag` double precision, `place` text, `state` text, `lat` double precision, `lon` double precision, `depth_km` double precision, `alert` text, `sig` integer, `felt` integer

## `raw.xbrl_concept` (table, 3,750 rows)

Label and definition of every XBRL concept seen.

`taxonomy` text, `tag` text, `label` text, `description` text

## `raw.xbrl_fact` (table, 1,093,275 rows)

Every XBRL fact in every filing (companyfacts API); restated values keep their original rows.

`cik` integer, `taxonomy` text, `tag` text, `unit` text, `period_start` date, `period_end` date, `value` numeric, `accession` text, `fiscal_year` integer, `fiscal_period` text, `form` text, `filed` date, `frame` text

## `ref.company` (table, 63 rows)

The curated universe: ticker, cohort, segment, status (active / acquired / exited), comparability.

`cik` integer, `ticker` text, `short_name` text, `cohort` text, `segment` text, `status` text, `status_year` integer, `status_note` text, `include_note` text, `comparable` boolean

## `ref.concept_tag` (table, 61 rows)

Insurance concepts and the XBRL tags that can carry them, in priority order.

`concept` text, `tag` text, `priority` integer, `kind` text, `note` text

## `ref.driver` (table, 41 rows)

Labels, units and groups of the quarterly risk drivers.

`driver` text, `label` text, `unit` text, `grp` text

## `ref.ma_deal` (table, 25 rows)

`key` text, `cik` integer, `ticker` text, `acquirer` text, `acquirer_type` text, `grp` text, `consideration` text, `price` numeric, `stated_value` numeric, `pending` boolean, `note` text
