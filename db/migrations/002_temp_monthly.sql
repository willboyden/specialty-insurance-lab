-- Monthly global temperature departures (the annual table keeps complete years only).
create table if not exists raw.noaa_global_temp_month (
  month      date primary key,
  anomaly_c  double precision not null
);
