-- Some groups report non-P&C business (life, group benefits, long-term care) inside the same premium and
-- loss lines, which makes their ratios incomparable. They stay in the database, flagged.
alter table ref.company add column if not exists comparable boolean not null default true;
