-- Claims and reserves (sil/claims.py).
--
-- core.claims_year      one row per company and fiscal year: the loss-reserve roll-forward (opening and closing net
--                       reserves, incurred and paid losses for the current and prior accident years, acquisitions,
--                       FX) and the ratios read from it
-- core.claims_quarter   one row per company and quarter: paid and incurred losses, trailing four quarters
-- raw.claims_instance   10-K XBRL instances already read for claims-development facts (so a re-run skips them)
-- raw.claims_instance_fact   every short-duration fact read from them (dimensional; provenance for the triangles)
-- core.claims_triangle  cumulative incurred and paid claims by line, accident year and evaluation year
-- core.claims_ay        per line and accident year: IBNR, reported claim counts, latest incurred and paid
-- core.claims_payout    per line: the average share of an accident year's claims paid in year n

create table if not exists core.claims_year (
  cik                 integer not null,
  fiscal_year         integer not null,
  fy_end              date not null,
  npe                 double precision,
  losses              double precision,
  cy_losses           double precision,
  py_development      double precision,
  paid_cy             double precision,
  paid_py             double precision,
  paid                double precision,
  paid_basis          text,             -- cy+py | total | total-cy (prior-year paid derived) | none
  acquired            double precision, -- reserves assumed through acquisitions (negative: sold or transferred)
  fx                  double precision,
  net_reserves        double precision,
  net_reserves_open   double precision,
  gross_reserves      double precision,
  recoverable_unpaid  double precision,
  ibnr                double precision,
  case_reserves       double precision,
  equity              double precision,
  paid_lr             double precision,
  incurred_lr         double precision,
  paid_to_incurred    double precision,
  first_year_payout   double precision,
  runoff_speed        double precision,
  survival            double precision,
  reserve_to_npe      double precision,
  reserve_leverage    double precision,
  dev_pct_open        double precision,
  pyd_ratio           double precision,
  ceded_share         double precision,
  ibnr_share          double precision,
  reserve_growth      double precision,
  acquired_pct_open   double precision,
  rollforward_gap     double precision, -- (closing - (opening + incurred - paid + acquired + fx)) / opening
  primary key (cik, fiscal_year)
);

create table if not exists core.claims_quarter (
  cik                 integer not null,
  qend                date not null,
  paid                double precision,
  paid_basis          text,
  paid_ttm            double precision,
  npe_ttm             double precision,
  losses_ttm          double precision,
  paid_lr_ttm         double precision,
  incurred_lr_ttm     double precision,
  paid_to_incurred_ttm double precision,
  primary key (cik, qend)
);

create table if not exists raw.claims_instance (
  accession   text primary key,
  cik         integer not null,
  fiscal_year integer,
  url         text not null,
  n_facts     integer not null,
  read_at     timestamptz not null default now()
);

create table if not exists raw.claims_instance_fact (
  accession   text not null,
  cik         integer not null,
  element     text not null,
  value       double precision,
  unit        text,
  decimals    text,
  period_start date,
  period_end  date not null,
  dims        jsonb not null
);
create index if not exists claims_instance_fact_acc on raw.claims_instance_fact (accession);

create table if not exists core.claims_triangle (
  cik            integer not null,
  fy_filed       integer not null,
  accession      text not null,
  line           text not null,
  accident_year  integer not null,
  eval_year      integer not null,
  metric         text not null check (metric in ('incurred', 'paid')),
  value          double precision not null,
  primary key (cik, fy_filed, line, accident_year, eval_year, metric)
);

create table if not exists core.claims_ay (
  cik              integer not null,
  fy_filed         integer not null,
  line             text not null,
  accident_year    integer not null,
  incurred_first   double precision,
  incurred_latest  double precision,
  paid_latest      double precision,
  ibnr             double precision,
  reported_claims  double precision,
  primary key (cik, fy_filed, line, accident_year)
);

create table if not exists core.claims_payout (
  cik       integer not null,
  fy_filed  integer not null,
  line      text not null,
  year_n    integer not null,
  pct       double precision not null,
  primary key (cik, fy_filed, line, year_n)
);
