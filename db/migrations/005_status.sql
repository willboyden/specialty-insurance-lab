-- Each company's listing status as its SEC filing record shows it (sil/status.py), next to the curated label.
create table if not exists core.company_status (
  cik                 integer primary key,
  derived             text not null check (derived in ('active', 'pending', 'inactive')),
  curated             text not null,
  agrees              boolean not null,
  common_listed       boolean not null,     -- the company's ticker is among its current SEC-listed tickers
  last_periodic       date,                 -- last 10-K/10-Q (or 20-F/40-F/6-K for foreign private issuers)
  last_change_of_control date,              -- last 8-K with item 5.01
  last_delisting      date,                 -- last Form 25
  last_deregistration date,                 -- last Form 15
  pending_since       date,                 -- first deal document of a pending transaction (last 12 months)
  pending_forms       text,                 -- e.g. 'PREM14A 2026-08-28; SC 13E3 2026-08-31; DEFM14A 2026-10-14'
  checked_on          date not null
);
