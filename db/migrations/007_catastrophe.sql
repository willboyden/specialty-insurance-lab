-- Catastrophe domain (sil/catastrophe.py, sil/sources/perils.py, sil/sources/cat_losses.py).
-- raw.*  : public peril data as each agency publishes it (large sources aggregated on load)
-- core.* : quarterly and annual peril indices, the state map, the shock regression, company exposure and the
--          catastrophe losses carriers report in their earnings releases

-- NOAA NHC HURDAT2 Atlantic best track: one row per track point (6-hourly plus landfall and peak records)
create table if not exists raw.hurdat_point (
  storm_id     text not null,            -- e.g. AL092017
  storm_name   text not null,
  season       integer not null,
  obs_time     timestamp not null,       -- UTC
  record_id    text,                     -- 'L' = landfall, 'I' = intensity peak, ...
  status       text not null,            -- HU, TS, TD, EX, SS, SD, LO, WV, DB
  lat          double precision not null,
  lon          double precision not null,
  wind_kt      integer,
  pressure_mb  integer,
  primary key (storm_id, obs_time, record_id)
);

-- NOAA SPC severe weather database, aggregated on load to month x state x kind
create table if not exists raw.spc_report_month (
  month         date not null,
  state         text not null,
  kind          text not null check (kind in ('tornado', 'hail', 'wind')),
  n_reports     integer not null,
  n_significant integer not null,         -- tornado EF/F2+, hail >= 2 inches, wind >= 65 knots
  injuries      integer not null,
  fatalities    integer not null,
  loss_usd      double precision,         -- property loss where SPC records it in dollars (1996 on)
  primary key (month, state, kind)
);

-- USGS ComCat earthquakes, magnitude 5 and above, in US states and territories
create table if not exists raw.usgs_quake (
  event_id   text primary key,
  time_utc   timestamptz not null,
  mag        double precision not null,
  place      text,
  state      text,
  lat        double precision,
  lon        double precision,
  depth_km   double precision,
  alert      text,                       -- PAGER alert level (green/yellow/orange/red) where issued
  sig        integer,
  felt       integer
);

-- NIFC: wildland fires and acres per year (National Interagency Coordination Center)
create table if not exists raw.nifc_wildfire_year (
  year   integer primary key,
  fires  integer not null,
  acres  double precision not null
);

-- NOAA CPC Oceanic Nino Index: 3-month running mean SST anomaly in the Nino 3.4 region
create table if not exists raw.enso_oni (
  year       integer not null,
  season     text not null,              -- DJF, JFM, ..., NDJ
  mid_month  integer not null,           -- the season's middle month (DJF -> 1)
  total_c    double precision not null,
  anom_c     double precision not null,
  primary key (year, season)
);

-- OpenFEMA NFIP redacted claims (v3), aggregated on load to month of loss x state
create table if not exists raw.nfip_claim_month (
  month          date not null,
  state          text not null,
  n_claims       integer not null,
  n_paid         integer not null,
  paid_building  double precision not null,
  paid_contents  double precision not null,
  paid_icc       double precision not null,
  primary key (month, state)
);

-- the same claims by named flood event
create table if not exists raw.nfip_event (
  flood_event     text primary key,
  first_loss      date,
  last_loss       date,
  n_claims        integer not null,
  paid_total      double precision not null,
  top_state       text
);

-- ---------------------------------------------------------------- core
create table if not exists core.peril_quarter (
  qend                    date primary key,
  us_landfalls            integer,          -- US hurricane landfalls (category 1+), mainland and Puerto Rico
  us_major_landfalls      integer,          -- category 3+
  us_landfall_index       double precision, -- sum of category squared over US hurricane landfalls
  ace                     double precision, -- Atlantic accumulated cyclone energy, 10^4 kt^2
  tornadoes               integer,
  sig_tornadoes           integer,
  sig_hail                integer,
  sig_wind                integer,
  quakes_m5               integer,
  quakes_m6               integer,
  nfip_paid               double precision, -- USD, building + contents + ICC, by month of loss
  nfip_claims             integer,
  storm_damage            double precision, -- NOAA Storm Events property damage, USD
  storm_damage_hurricane  double precision,
  storm_damage_convective double precision,
  storm_damage_wildfire   double precision,
  storm_damage_flood      double precision,
  billion_cost            double precision, -- NOAA billion-dollar events, CPI-adjusted USD (ends 2024)
  fema_major              integer,
  oni                     double precision,
  f_mean                  double precision, -- the loss model's industry shock (latest run), sigma units
  f_p10                   double precision,
  f_p90                   double precision
);

create table if not exists core.peril_year (
  year               integer primary key,
  us_landfalls       integer,
  us_landfalls_cat1  integer,
  us_landfalls_cat2  integer,
  us_landfalls_cat3  integer,
  us_landfalls_cat4  integer,
  us_landfalls_cat5  integer,
  ace                double precision,
  named_storms       integer,
  hurricanes         integer,
  tornadoes          integer,
  sig_tornadoes      integer,
  hail_reports       integer,
  sig_hail           integer,
  wind_reports       integer,
  sig_wind           integer,
  wildfire_fires     integer,
  wildfire_acres     double precision,
  nfip_paid          double precision,
  nfip_claims        integer,
  quakes_m5          integer,
  quakes_m6          integer,
  billion_cost       double precision,
  billion_count      integer,
  storm_damage       double precision,
  oni_aso            double precision,      -- Aug-Sep-Oct ONI: the hurricane season's ENSO state
  global_temp        double precision
);

create table if not exists core.peril_state (
  state            text primary key,         -- two-letter code
  nfip_paid        double precision,         -- 2000 onward, USD
  storm_damage     double precision,         -- 2000 onward, USD
  storm_damage_hurricane  double precision,
  storm_damage_convective double precision,
  storm_damage_wildfire   double precision,
  storm_damage_flood      double precision,
  sig_hail         integer,                  -- 2000 onward
  sig_tornadoes    integer,                  -- 2000 onward
  fema_major       integer                   -- major disaster declarations (DR), 2000 onward, counted once per disaster
);

-- how much of the model's industry shock observed US perils explain (OLS on standardized indices)
create table if not exists core.cat_shock_fit (
  term     text primary key,                 -- '(intercept)', a regressor key, or '_summary'
  label    text,
  coef     double precision,
  se       double precision,
  t        double precision,
  r        double precision,                 -- simple correlation with the shock
  n        integer,
  r2       double precision,
  adj_r2   double precision,
  cv_r2    double precision,                 -- leave-one-year-out cross-validated R^2
  window_start date,
  window_end   date
);

-- catastrophe losses carriers report in their earnings releases (8-K item 2.02 exhibits)
create table if not exists core.cat_loss_reported (
  cik           integer not null,
  qend          date not null,
  cat_loss_usd  double precision,            -- net catastrophe losses for the quarter
  cat_points    double precision,            -- catastrophe losses as combined-ratio points, when stated
  basis         text not null,               -- quarter | derived (year or year-to-date minus earlier quarters)
  accession     text,
  url           text,
  snippet       text,
  primary key (cik, qend)
);
