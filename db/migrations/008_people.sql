-- People and technology (sil/people.py): staffing proxies, reported headcount, technology signals.

-- DOL Form 5500 (EFAST2 public datasets): the plans of sponsors matched to a universe company. Only sponsor,
-- plan and participant-count fields are kept (the public files also carry signer names and phone numbers; those
-- are never loaded).
create table if not exists raw.dol5500_plan (
  ack_id            text primary key,
  form_year         integer not null,
  cik               integer not null,
  match_kind        text not null check (match_kind in ('ein', 'name')),
  sponsor_name      text not null,
  sponsor_ein       text not null,
  sponsor_state     text,
  business_code     text,
  plan_name         text,
  plan_number       text,
  plan_year_begin   date,
  plan_year_end     date,
  pension_codes     text,
  welfare_codes     text,
  active_eoy        integer,      -- line 6a(2): active participants at the end of the plan year
  active_boy        integer,
  total_boy         integer,
  with_balance      integer,
  final_filing      boolean,
  date_received     date
);
create index if not exists dol5500_plan_cik on raw.dol5500_plan (cik, form_year);

-- 10-K headcount, extracted from the Employees / Human Capital paragraph of each annual report
create table if not exists raw.headcount_10k (
  accession    text primary key,
  cik          integer not null,
  form         text not null,
  filing_date  date not null,
  fiscal_year  integer not null,
  employees    integer,
  full_time    integer,
  as_of        date,
  snippet      text,
  method       text not null,       -- which pattern matched, or 'none'
  doc_url      text not null
);
create index if not exists headcount_10k_cik on raw.headcount_10k (cik, fiscal_year);

-- technology vocabulary per 10-K: occurrences of each term family and the document's word count
create table if not exists raw.tech_terms_10k (
  accession   text not null,
  cik         integer not null,
  fiscal_year integer not null,
  term_key    text not null,
  n           integer not null,
  words       integer not null,
  primary key (accession, term_key)
);

-- SEC full-text search hits for technology themes (own table; the core risk themes live in raw.efts_term_hit)
create table if not exists raw.efts_tech_hit (
  cik         integer not null,
  term_key    text not null,
  accession   text not null,
  form        text,
  file_date   date,
  period_end  date,
  primary key (cik, term_key, accession)
);

-- R&D of the AI-indicator companies (read from their cached companyfacts; context for the AI build-out)
create table if not exists raw.ai_rd_annual (
  cik          integer not null,
  fiscal_year  integer not null,
  period_end   date not null,
  rd_usd       double precision not null,
  primary key (cik, fiscal_year)
);

-- one row per company and fiscal year: everything the section shows
create table if not exists core.people_year (
  cik                     integer not null,
  fiscal_year             integer not null,
  employees_reported      integer,          -- 10-K headcount (as of fiscal year end, or the date stated)
  us_plan_active          integer,          -- Form 5500: active participants in the 401(k) plans
  us_plan_count           integer,          -- number of 401(k) plans summed
  npe                     double precision,
  uw_expense              double precision, -- acquisition + other underwriting expense
  share_based_comp        double precision,
  dc_plan_cost            double precision,
  labor_expense           double precision,
  capex                   double precision, -- property, equipment and software purchases (cash flow)
  software_capitalized    double precision, -- capitalized software additions / payments to develop software
  software_net            double precision,
  primary key (cik, fiscal_year)
);
