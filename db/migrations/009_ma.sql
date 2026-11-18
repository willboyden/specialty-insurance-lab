-- Mergers and acquisitions (sil/ma.py, sil/deals.py).
--   ref.ma_deal          the curated candidates (sil/deals.py), reloaded on every build
--   raw.ma_deal_check    what SEC full-text search returned for each exact-phrase check
--   raw.ma_deal_doc_fact terms read from the deal documents themselves, once they are cached
--   core.ma_deal         each deal's dated timeline, verification flags, value and valuation
--   core.ma_listing      when each carrier was listed (intervals; a relisting opens a second one)
--   core.ma_event        8-K item 5.01 (change in control) filings, matched to deals where they close one
--   core.ma_activity_year acquisitions, divestitures, goodwill and intangibles per company and fiscal year

create table if not exists ref.ma_deal (
  key            text primary key,
  cik            integer not null,
  ticker         text not null,
  acquirer       text,
  acquirer_type  text,
  grp            text not null,
  consideration  text,
  price          numeric,
  stated_value   numeric,
  pending        boolean not null,
  note           text
);

create table if not exists raw.ma_deal_check (
  deal_key         text not null,
  field            text not null,       -- acquirer | price | cash | terms | stated_value | earlier_price
  phrase           text not null,
  forms            text not null,
  start_date       date not null,
  end_date         date not null,
  hits             integer not null,
  first_date       date,
  first_form       text,
  first_accession  text,
  first_file       text,
  last_date        date,
  last_accession   text,
  last_file        text,
  checked_at       timestamptz not null default now(),
  primary key (deal_key, field, phrase)
);

create table if not exists raw.ma_deal_doc_fact (
  deal_key    text not null,
  accession   text not null,
  filename    text not null,
  field       text not null,               -- price | consideration | parent | agreement_date
  value_text  text not null,
  value_num   numeric,
  snippet     text,
  primary key (deal_key, accession, filename, field, value_text)
);

create table if not exists core.ma_deal (
  key                   text primary key,
  cik                   integer not null,
  status                text not null check (status in ('closed', 'pending')),
  announced             date,
  announced_basis       text,
  announced_accession   text,
  first_proxy           date,
  first_proxy_form      text,
  first_proxy_accession text,
  closed                date,
  closed_basis          text,
  closed_accession      text,
  deregistered          date,
  days_to_close         integer,
  acquirer_verified     boolean not null default false,
  price_verified        boolean not null default false,
  consideration_verified boolean not null default false,
  terms_verified        boolean not null default false,
  shares                numeric,
  shares_as_of          date,
  book_quarter          date,
  common_equity         numeric,
  preferred             numeric,
  book_per_share        numeric,
  price_to_book         numeric,
  implied_value         numeric,
  value_basis           text,
  roe_ttm               numeric,
  combined_ratio_ttm    numeric,
  npe_ttm               numeric,
  doc_price             numeric,
  doc_parent            text,
  doc_agrees            boolean
);

create table if not exists core.ma_listing (
  cik            integer not null,
  listed_from    date,                    -- null: listed before the window (2008)
  from_basis     text,
  listed_until   date,                    -- null: still listed
  until_basis    text,
  deal_key       text,
  primary key (cik, from_basis, until_basis)
);

create table if not exists core.ma_event (
  cik           integer not null,
  filing_date   date not null,
  accession     text primary key,
  items         text,
  deal_key      text,
  stayed_public boolean not null
);

create table if not exists core.ma_activity_year (
  cik                  integer not null,
  fy                   integer not null,
  acq_cash             numeric,
  divest_proceeds      numeric,
  goodwill             numeric,
  intangibles          numeric,
  equity               numeric,
  gi_to_equity         numeric,
  goodwill_acquired    numeric,
  goodwill_impairment  numeric,
  reserves_acquired    numeric,
  n_completions        integer not null default 0,
  primary key (cik, fy)
);
