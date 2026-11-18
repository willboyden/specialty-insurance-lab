"""Quarterly risk drivers built from the raw macro, market, geopolitical and catastrophe tables.

Output: core.macro_quarter, one row per calendar quarter end, with these columns (documented in
ref.driver). Dollar amounts from NOAA are converted to the latest CPI level ("real").
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .db import copy_rows
from .standardize import _frame, _write_wide, ai_capex

log = logging.getLogger(__name__)

DRIVERS: dict[str, tuple[str, str, str]] = {
    # name: (label, unit, group)
    "ust10y": ("10-year Treasury yield (quarter average)", "%", "Rates and credit"),
    "ust2y": ("2-year Treasury yield (quarter average)", "%", "Rates and credit"),
    "ust5y": ("5-year Treasury yield (quarter average)", "%", "Rates and credit"),
    "ust5y_end": ("5-year Treasury yield (quarter end)", "%", "Rates and credit"),
    "breakeven10": ("10-year breakeven inflation (quarter average)", "%", "Rates and credit"),
    "ai_capex": ("Total capital expenditure of Microsoft, Alphabet, Amazon and Meta (quarter, SEC filings)", "$bn",
                 "Equities and the AI cycle"),
    "ai_capex_yoy": ("AI-infrastructure capex, year-over-year growth", "%", "Equities and the AI cycle"),
    "ai_capex_to_ocf": ("Their capex as a share of their operating cash flow (trailing four quarters)", "%",
                        "Equities and the AI cycle"),
    "gpr": ("Geopolitical Risk index (Caldara-Iacoviello, quarter average)", "index (1985-2019 = 100)", "Geopolitics"),
    "gpr_threats": ("GPR: threats component", "index", "Geopolitics"),
    "gpr_acts": ("GPR: acts component", "index", "Geopolitics"),
    "epu": ("US Economic Policy Uncertainty index (quarter average)", "index", "Geopolitics"),
    "brent": ("Brent crude oil (quarter average)", "$/bbl", "Geopolitics"),
    "cpi_yoy": ("CPI inflation, year over year", "%", "Inflation and loss costs"),
    "med_cpi_yoy": ("Medical care CPI, year over year", "%", "Inflation and loss costs"),
    "auto_repair_cpi_yoy": ("Motor vehicle maintenance and repair CPI, year over year", "%", "Inflation and loss costs"),
    "legal_ppi_yoy": ("Producer prices of law offices, year over year (litigation-cost proxy)", "%",
                      "Inflation and loss costs"),
    "ppi_pc_yoy": ("Insurance pricing: P&C insurers' producer prices, year over year", "%", "Insurance pricing"),
    "ppi_liab_yoy": ("Pricing: non-auto (general) liability, year over year", "%", "Insurance pricing"),
    "ppi_comauto_yoy": ("Pricing: commercial auto, year over year", "%", "Insurance pricing"),
    "ppi_cmp_yoy": ("Pricing: commercial multiple peril, year over year", "%", "Insurance pricing"),
    "ppi_wc_yoy": ("Pricing: workers' compensation, year over year", "%", "Insurance pricing"),
    "ppi_medmal_yoy": ("Pricing: medical malpractice, year over year", "%", "Insurance pricing"),
    "ppi_home_yoy": ("Pricing: homeowners, year over year", "%", "Insurance pricing"),
    "gdp_yoy": ("Nominal GDP, year over year", "%", "Economy"),
    "real_gdp_yoy": ("Real GDP, year over year", "%", "Economy"),
    "unrate": ("Unemployment rate (quarter average)", "%", "Economy"),
    "recession": ("Share of the quarter in an NBER recession", "share", "Economy"),
    "nfci": ("Chicago Fed National Financial Conditions Index (quarter average; 0 = average, positive = tighter)",
             "index", "Rates and credit"),
    "nonres_constr_yoy": ("Nonresidential construction spending, year over year", "%", "Economy"),
    "storm_damage": ("Property damage in NOAA Storm Events (quarter, real $)", "$bn", "Climate and catastrophes"),
    "storm_damage_hurricane": ("...of which hurricanes, tropical storms and storm surge", "$bn", "Climate and catastrophes"),
    "storm_damage_convective": ("...of which hail, tornado, thunderstorm wind", "$bn", "Climate and catastrophes"),
    "storm_damage_wildfire": ("...of which wildfire", "$bn", "Climate and catastrophes"),
    "storm_damage_flood": ("...of which flood and flash flood", "$bn", "Climate and catastrophes"),
    "storm_events": ("Storm Events with property damage (count)", "count", "Climate and catastrophes"),
    "billion_cost": ("NOAA billion-dollar disasters starting in the quarter (CPI-adjusted, to 2024)", "$bn",
                     "Climate and catastrophes"),
    "billion_count": ("NOAA billion-dollar disasters starting in the quarter (to 2024)", "count",
                      "Climate and catastrophes"),
    "fema_major": ("FEMA major-disaster declarations (DR, distinct disasters)", "count", "Climate and catastrophes"),
    "global_temp": ("Global land-ocean temperature anomaly vs 1901-2000 (trailing 12 months)", "deg C",
                    "Climate and catastrophes"),
    "cat_index": ("Catastrophe activity index: mean z-score of log storm damage and FEMA major disasters", "z",
                  "Climate and catastrophes"),
}

HYPERSCALERS = (789019, 1652044, 1018724, 1326801)  # Microsoft, Alphabet, Amazon, Meta

PPI = {
    "ppi_pc_yoy": "PCU524126524126",
    "ppi_liab_yoy": "PCU5241265241264",
    "ppi_comauto_yoy": "PCU5241265241263",
    "ppi_cmp_yoy": "PCU5241265241265",
    "ppi_wc_yoy": "PCU5241265241266",
    "ppi_medmal_yoy": "PCU524126524126402",
    "ppi_home_yoy": "PCU5241265241262",
}


def _qend(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s).dt.to_period("Q").dt.end_time.dt.normalize()


def _fred(conn) -> pd.DataFrame:
    df = _frame(conn, "select series_id, obs_date, value from raw.fred_observation")
    df["obs_date"] = pd.to_datetime(df["obs_date"])
    return df


def build(conn) -> pd.DataFrame:
    fred = _fred(conn)
    fred["qend"] = _qend(fred["obs_date"])

    def qmean(sid: str) -> pd.Series:
        s = fred[fred.series_id == sid]
        return s.groupby("qend")["value"].mean()

    def qlast(sid: str) -> pd.Series:
        s = fred[fred.series_id == sid].sort_values("obs_date")
        return s.groupby("qend")["value"].last()

    def yoy_monthly(sid: str) -> pd.Series:
        s = fred[fred.series_id == sid].set_index("obs_date")["value"].sort_index()
        s = s[~s.index.duplicated()]
        m = s.resample("MS").mean()
        y = m / m.shift(12) - 1
        q = y.groupby(m.index.to_period("Q").end_time.normalize()).mean()
        return q * 100

    out = pd.DataFrame(index=pd.date_range("1990-03-31", "2026-12-31", freq="QE").normalize())
    out.index.name = "qend"
    out["ust10y"] = qmean("DGS10")
    out["ust2y"] = qmean("DGS2")
    out["ust5y"] = qmean("DGS5")
    out["ust5y_end"] = qlast("DGS5")
    out["breakeven10"] = qmean("T10YIE")
    out["epu"] = qmean("USEPUINDXM")
    out["brent"] = qmean("DCOILBRENTEU")
    out["cpi_yoy"] = yoy_monthly("CPIAUCSL")
    out["med_cpi_yoy"] = yoy_monthly("CPIMEDSL")
    out["auto_repair_cpi_yoy"] = yoy_monthly("CUSR0000SETD")
    out["legal_ppi_yoy"] = yoy_monthly("PCU541110541110")
    for col, sid in PPI.items():
        out[col] = yoy_monthly(sid)
    gdp = qlast("GDP")
    rgdp = qlast("GDPC1")
    out["gdp_yoy"] = (gdp / gdp.shift(4) - 1) * 100
    out["real_gdp_yoy"] = (rgdp / rgdp.shift(4) - 1) * 100
    out["unrate"] = qmean("UNRATE")
    out["recession"] = qmean("USREC")
    out["nfci"] = qmean("NFCI")
    out["nonres_constr_yoy"] = yoy_monthly("TLNRESCONS")

    # geopolitics
    gpr = _frame(conn, "select month, variable, value from raw.gpr_observation where variable in ('GPR','GPRT','GPRA')")
    gpr["qend"] = _qend(gpr["month"])
    g = gpr.pivot_table(index="qend", columns="variable", values="value", aggfunc="mean")
    out["gpr"], out["gpr_threats"], out["gpr_acts"] = g.get("GPR"), g.get("GPRT"), g.get("GPRA")

    # CPI deflator to the latest month
    cpi = fred[fred.series_id == "CPIAUCSL"].set_index("obs_date")["value"].sort_index()
    cpi_q = cpi.groupby(cpi.index.to_period("Q").end_time.normalize()).mean()
    latest_cpi = cpi.iloc[-1]

    # catastrophes: NOAA Storm Events
    st = _frame(conn, "select month, event_type, n_events, property_damage_usd from raw.storm_event_month")
    st["qend"] = _qend(st["month"])
    st["deflator"] = latest_cpi / st["qend"].map(cpi_q)
    st["real"] = st["property_damage_usd"] * st["deflator"] / 1e9
    et = st["event_type"].str.lower()
    groups = {
        "storm_damage_hurricane": et.str.contains("hurricane|tropical|storm surge|typhoon"),
        "storm_damage_convective": et.str.contains("hail|tornado|thunderstorm|funnel"),
        "storm_damage_wildfire": et.str.contains("wildfire"),
        "storm_damage_flood": et.str.contains("flood"),
    }
    out["storm_damage"] = st.groupby("qend")["real"].sum()
    for col, mask in groups.items():
        out[col] = st[mask].groupby("qend")["real"].sum()
    out["storm_events"] = st[st["property_damage_usd"] > 0].groupby("qend")["n_events"].sum()
    last_storm_q = st["qend"].max()

    # NOAA billion-dollar disasters (product ends in 2024)
    bd = _frame(conn, "select begin_date, cpi_adjusted_cost_musd from raw.noaa_billion_event")
    bd["qend"] = _qend(bd["begin_date"])
    out["billion_cost"] = bd.groupby("qend")["cpi_adjusted_cost_musd"].sum() / 1e3
    out["billion_count"] = bd.groupby("qend").size()
    last_bd = bd["qend"].max()

    # FEMA major disasters
    fe = _frame(conn, "select distinct disaster_number, declaration_date from raw.fema_declaration"
                      " where declaration_type = 'DR'")
    fe["qend"] = _qend(fe["declaration_date"])
    out["fema_major"] = fe.groupby("qend")["disaster_number"].nunique()

    # global temperature (annual -> every quarter of the year)
    gt = _frame(conn, "select month, anomaly_c from raw.noaa_global_temp_month")
    gts = gt.set_index(pd.to_datetime(gt["month"]))["anomaly_c"].sort_index().rolling(12).mean()
    out["global_temp"] = gts.groupby(gts.index.to_period("Q").end_time.normalize()).last()

    # AI-infrastructure capex from the six companies' filings (sum when all six report... or present)
    ai = ai_capex(conn)
    ai["qend"] = pd.to_datetime(ai["qend"])
    ai = ai[ai["cik"].isin(HYPERSCALERS)]
    cap = ai.pivot_table(index="qend", columns="cik", values="capex")
    ocf = ai.pivot_table(index="qend", columns="cik", values="ocf")
    full = cap.notna().sum(axis=1) == len(HYPERSCALERS)
    out["ai_capex"] = (cap.sum(axis=1).where(full) / 1e9)
    out["ai_capex_yoy"] = (out["ai_capex"] / out["ai_capex"].shift(4) - 1) * 100
    cap_ttm = cap.sum(axis=1).where(full).rolling(4).sum()
    ocf_ttm = ocf.sum(axis=1).where(full).rolling(4).sum()
    out["ai_capex_to_ocf"] = (cap_ttm / ocf_ttm * 100).reindex(out.index)

    # zero-fill counts/amounts only inside each source's coverage
    for col in ("storm_damage", *groups, "storm_events"):
        out.loc[out.index <= last_storm_q, col] = out.loc[out.index <= last_storm_q, col].fillna(0)
        out.loc[out.index < pd.Timestamp("2000-03-31"), col] = np.nan
    for col in ("billion_cost", "billion_count"):
        inside = (out.index >= pd.Timestamp("1980-03-31")) & (out.index <= last_bd)
        out.loc[inside, col] = out.loc[inside, col].fillna(0)
    out.loc[out.index >= pd.Timestamp("1990-03-31"), "fema_major"] = out["fema_major"].fillna(0)

    # catastrophe activity index (z-scores over 2000 onward)
    base = out.index >= pd.Timestamp("2000-03-31")
    lsd = np.log1p(out.loc[base, "storm_damage"])
    fm = np.log1p(out.loc[base, "fema_major"])
    out.loc[base, "cat_index"] = ((lsd - lsd.mean()) / lsd.std() + (fm - fm.mean()) / fm.std()) / 2

    # the current quarter is still running: flag it
    today = pd.Timestamp.today().normalize()
    out["partial"] = out.index > (today.to_period("Q") - 1).end_time.normalize()

    out = out.reset_index()
    # drop the future quarters that have nothing yet
    has = out.drop(columns="qend").notna().sum(axis=1)
    out = out[has > 3]
    _write_wide(conn, "core.macro_quarter", out)
    conn.execute("drop table if exists ref.driver")
    conn.execute("create table ref.driver (driver text primary key, label text, unit text, grp text)")
    copy_rows(conn, "ref.driver", ("driver", "label", "unit", "grp"), [(k, *v) for k, v in DRIVERS.items()])
    conn.commit()
    log.info("macro_quarter: %d quarters, %s .. %s", len(out), out.qend.min().date(), out.qend.max().date())
    return out
