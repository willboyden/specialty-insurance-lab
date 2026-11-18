-- Schema for the specialty-insurance lab.
-- raw   : what each public source returned, loaded as-is (one table per source)
-- ref   : curated reference data (the company universe, metric definitions, scenarios)
-- core  : standardized quarterly financials and macro drivers (views in db/views)
-- model : fitted parameters, backtests and scenario forecasts
-- mart  : what the dashboard exports

create schema if not exists meta;
create schema if not exists ref;
create schema if not exists raw;
create schema if not exists core;
create schema if not exists model;
create schema if not exists mart;

create table if not exists meta.ingest_run (
  run_id       bigserial primary key,
  source       text not null,
  status       text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  rows_loaded  bigint,
  detail       jsonb
);

-- ---------------------------------------------------------------- reference
create table if not exists ref.company (
  cik             integer primary key,
  ticker          text not null,
  short_name      text not null,
  cohort          text not null check (cohort in ('specialty', 'benchmark', 'ai_indicator')),
  segment         text not null,
  status          text not null check (status in ('active', 'acquired', 'exited')),
  status_year     integer,
  status_note     text,
  include_note    text
);

-- ---------------------------------------------------------------- SEC EDGAR
create table if not exists raw.sec_company (
  cik                    integer primary key,
  name                   text,
  sic                    text,
  sic_description        text,
  category               text,
  entity_type            text,
  state_of_incorporation text,
  fiscal_year_end        text,
  tickers                text[],
  exchanges              text[],
  former_names           jsonb,
  fetched_at             timestamptz not null default now()
);

create table if not exists raw.sec_filing (
  accession            text primary key,
  cik                  integer not null,
  form                 text not null,
  filing_date          date,
  report_date          date,
  acceptance_datetime  timestamptz,
  act                  text,
  file_number          text,
  items                text,
  size_bytes           bigint,
  is_xbrl              boolean,
  is_inline_xbrl       boolean,
  primary_document     text,
  primary_doc_description text
);
create index if not exists sec_filing_cik_form on raw.sec_filing (cik, form, report_date);

create table if not exists raw.xbrl_concept (
  taxonomy    text not null,
  tag         text not null,
  label       text,
  description text,
  primary key (taxonomy, tag)
);

-- Every fact in every filing (companyfacts API): one row per (fact, filing that reported it).
-- Keeping all filings, not only the latest, allows point-in-time (as-first-reported) backtests.
create table if not exists raw.xbrl_fact (
  cik           integer not null,
  taxonomy      text not null,
  tag           text not null,
  unit          text not null,
  period_start  date,
  period_end    date not null,
  value         numeric not null,
  accession     text not null,
  fiscal_year   integer,
  fiscal_period text,
  form          text,
  filed         date not null,
  frame         text
);
create index if not exists xbrl_fact_lookup on raw.xbrl_fact (tag, cik, period_end);
create index if not exists xbrl_fact_cik on raw.xbrl_fact (cik);

-- SEC full-text search: one row per (company, term, filing) that mentions the term.
create table if not exists raw.efts_term_hit (
  cik         integer not null,
  term_key    text not null,
  accession   text not null,
  form        text,
  file_date   date,
  period_end  date,
  primary key (cik, term_key, accession)
);

-- ---------------------------------------------------------------- macro and markets (FRED)
create table if not exists raw.fred_series (
  series_id   text primary key,
  title       text not null,
  units       text not null,
  frequency   text not null,
  role        text not null,
  source_url  text not null,
  fetched_at  timestamptz not null default now()
);

create table if not exists raw.fred_observation (
  series_id  text not null references raw.fred_series (series_id) on delete cascade,
  obs_date   date not null,
  value      double precision not null,
  primary key (series_id, obs_date)
);

-- ---------------------------------------------------------------- geopolitics
-- Caldara and Iacoviello Geopolitical Risk index, long format (one row per month and variable)
create table if not exists raw.gpr_observation (
  month     date not null,
  variable  text not null,
  value     double precision not null,
  primary key (month, variable)
);

-- ---------------------------------------------------------------- climate and catastrophes
create table if not exists raw.fema_declaration (
  id                  text primary key,
  disaster_number     integer not null,
  state               text,
  declaration_type    text,
  declaration_date    date,
  incident_type       text,
  declaration_title   text,
  incident_begin      date,
  incident_end        date,
  designated_area     text,
  fips_state          text,
  fips_county         text,
  ih_program          boolean,
  ia_program          boolean,
  pa_program          boolean,
  hm_program          boolean
);
create index if not exists fema_declaration_date on raw.fema_declaration (declaration_date);

create table if not exists raw.noaa_billion_event (
  name                  text not null,
  disaster_type         text not null,
  begin_date            date not null,
  end_date              date,
  cpi_adjusted_cost_musd double precision,
  unadjusted_cost_musd   double precision,
  deaths                integer,
  primary key (name, begin_date)
);

create table if not exists raw.noaa_global_temp (
  year        integer primary key,
  anomaly_c   double precision not null
);

-- NOAA Storm Events, aggregated on load to month x state x event type (the detail files are large)
create table if not exists raw.storm_event_month (
  month               date not null,
  state               text not null,
  event_type          text not null,
  n_events            integer not null,
  property_damage_usd double precision not null,
  crop_damage_usd     double precision not null,
  deaths_direct       integer not null,
  injuries_direct     integer not null,
  primary key (month, state, event_type)
);

-- ---------------------------------------------------------------- model outputs
create table if not exists model.run (
  run_id      bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,
  params      jsonb,
  metrics     jsonb
);
