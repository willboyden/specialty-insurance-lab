-- Core fact layer: from raw XBRL facts (every filing) to one value per company, tag and fiscal quarter.
--
-- 1. core.fact_latest   : the most recently filed value for each (company, tag, period), so restated
--                         figures replace the original ones.
-- 2. core.fact_quarter  : discrete quarters. A reported 3-month value wins; otherwise the quarter is
--                         derived from year-to-date values (e.g. Q4 = 12-month value minus 9-month value
--                         with the same start date).
-- 3. core.fact_instant  : balance-sheet values at quarter ends.
-- Quarter ends are aligned to the nearest calendar quarter end (fiscal quarters ending in Feb, May, Aug or Nov
-- map forward to Mar, Jun, Sep, Dec). Balance-sheet values must fall within 15 days of a quarter end.
-- Only tags listed in ref.concept_tag are carried, to keep the layer small.

create table if not exists ref.concept_tag (
  concept   text not null,
  tag       text not null,
  priority  integer not null,
  kind      text not null check (kind in ('duration', 'instant')),
  note      text,
  primary key (concept, tag)
);

drop materialized view if exists core.fact_instant cascade;
drop materialized view if exists core.fact_quarter cascade;
drop materialized view if exists core.fact_latest cascade;

create materialized view core.fact_latest as
select distinct on (f.cik, f.tag, f.period_start, f.period_end)
       f.cik, f.tag, f.period_start, f.period_end, f.value, f.accession, f.filed, f.form
from raw.xbrl_fact f
where f.taxonomy = 'us-gaap'
  and f.unit = 'USD'
  and f.tag in (select tag from ref.concept_tag)
order by f.cik, f.tag, f.period_start, f.period_end, f.filed desc, f.accession desc;

create index on core.fact_latest (cik, tag, period_end);

create materialized view core.fact_quarter as
with d as (
  select l.*,
         (l.period_end - l.period_start + 1) as days,
         round((l.period_end - l.period_start + 1) / 91.31)::int as quarters,
         (date_trunc('quarter', l.period_end + 45) - interval '1 day')::date as qend
  from core.fact_latest l
  where l.period_start is not null
    and (l.period_end - l.period_start + 1) between 80 and 380
),
direct as (
  select cik, tag, qend, value, 'reported 3-month' as derivation, filed, 1 as pri
  from d
  where quarters = 1
),
ytd as (
  select a.cik, a.tag, a.qend, a.value - b.value as value,
         format('%s-month minus %s-month YTD', a.quarters * 3, b.quarters * 3) as derivation,
         greatest(a.filed, b.filed) as filed, 2 as pri
  from d a
  join d b
    on b.cik = a.cik and b.tag = a.tag and b.period_start = a.period_start
   and b.quarters = a.quarters - 1
   and b.qend = (date_trunc('quarter', a.qend) - interval '1 day')::date
  where a.quarters between 2 and 4
)
select distinct on (cik, tag, qend) cik, tag, qend, value, derivation, filed
from (select * from direct union all select * from ytd) x
order by cik, tag, qend, pri;

create index on core.fact_quarter (cik, tag, qend);

create materialized view core.fact_instant as
select distinct on (l.cik, l.tag, qend)
       l.cik, l.tag, (date_trunc('quarter', l.period_end + 15) - interval '1 day')::date as qend,
       l.value, l.filed
from core.fact_latest l
where l.period_start is null
  and abs(l.period_end - (date_trunc('quarter', l.period_end + 15) - interval '1 day')::date) <= 15
order by l.cik, l.tag, qend, l.filed desc;

create index on core.fact_instant (cik, tag, qend);

-- Annual (fiscal-year) duration values, for the annual-only Schedule III expense tags.
create or replace view core.fact_annual as
select cik, tag, (date_trunc('quarter', period_end + 45) - interval '1 day')::date as fy_end, value, filed
from core.fact_latest
where period_start is not null and (period_end - period_start + 1) between 350 and 380;
