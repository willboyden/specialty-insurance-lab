-- Groups that also run non-insurance businesses (Markel Ventures, Alleghany Capital) state their insurance
-- operations' staff beside the group total; per-employee measures use that count (sil/sources/headcount.py).
alter table raw.headcount_10k add column if not exists insurance_employees integer;
alter table raw.headcount_10k add column if not exists insurance_basis text;
-- the 10-K group total, kept beside employees_reported (which is the insurance operations' count when stated)
alter table core.people_year add column if not exists employees_total integer;
