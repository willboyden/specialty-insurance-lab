"""Write docs/schema.md from the live database: every table and view, its columns and its row count."""

from __future__ import annotations

from sil.config import ROOT
from sil.db import connect

DESCRIPTIONS = {
    "meta.ingest_run": "One row per ingest run: source, status, rows loaded, timing.",
    "meta.schema_migrations": "Applied migration files.",
    "ref.company": "The curated universe: ticker, cohort, segment, status (active / acquired / exited), comparability.",
    "ref.concept_tag": "Insurance concepts and the XBRL tags that can carry them, in priority order.",
    "ref.driver": "Labels, units and groups of the quarterly risk drivers.",
    "raw.sec_company": "SEC submissions metadata per company (SIC, incorporation, tickers, former names).",
    "raw.sec_filing": "Every filing in each company's EDGAR index (10-K, 10-Q, 8-K, Forms 3/4/5, proxies ...).",
    "raw.xbrl_concept": "Label and definition of every XBRL concept seen.",
    "raw.xbrl_fact": "Every XBRL fact in every filing (companyfacts API); restated values keep their original rows.",
    "raw.efts_term_hit": "SEC full-text search: one row per (company, risk theme, 10-K/10-Q filing) that mentions it.",
    "raw.fred_series": "FRED series used, with the title read from FRED and the role in the model.",
    "raw.fred_observation": "FRED observations (daily, weekly, monthly, quarterly as published).",
    "raw.gpr_observation": "Caldara-Iacoviello Geopolitical Risk index, every published variable, monthly.",
    "raw.fema_declaration": "OpenFEMA disaster declarations by designated area.",
    "raw.noaa_billion_event": "NOAA billion-dollar weather and climate disasters, 1980-2024 (CPI-adjusted cost).",
    "raw.noaa_global_temp": "Global land-ocean temperature departure, complete years.",
    "raw.noaa_global_temp_month": "Global land-ocean temperature departure, monthly.",
    "raw.storm_event_month": "NOAA Storm Events aggregated to month x state x event type (damage, deaths, injuries).",
    "core.fact_latest": "Materialized: the most recently filed value per company, tag and period.",
    "core.fact_quarter": "Materialized: discrete quarters (reported 3-month values, else year-to-date differences).",
    "core.fact_instant": "Materialized: balance-sheet values at quarter ends.",
    "core.fact_annual": "View: fiscal-year values (for annual-only Schedule III tags).",
    "core.concept_value": "Each concept per company-quarter with the tag it came from, how it was derived and any flag.",
    "core.company_quarter": "Standardized quarterly financials and ratios (quarterly and trailing four quarters).",
    "core.company_year": "Fiscal-year view of the ratios.",
    "core.macro_quarter": "Quarterly risk drivers built from the raw macro, geopolitical and catastrophe tables.",
    "model.run": "One row per model fit: features, data end, convergence diagnostics.",
    "model.loss_param": "Posterior summaries per company (long-run loss ratio, persistence, sensitivities, noise).",
    "model.industry_shock": "The latent industry (catastrophe) shock by quarter, posterior mean and 80% interval.",
    "model.scenario_summary": "Reference scenario simulations per company (quantiles, probabilities).",
    "model.backtest": "Rolling-origin backtest: every forecast with the actual value and the naive benchmarks.",
}


def main() -> None:
    conn = connect()
    rows = conn.execute(
        "select table_schema, table_name, table_type from information_schema.tables"
        " where table_schema in ('meta','ref','raw','core','model') union all"
        " select schemaname, matviewname, 'MATERIALIZED VIEW' from pg_matviews where schemaname = 'core'"
        " order by 1, 2"
    ).fetchall()
    out = ["# Database schema", "", "Generated from the live Postgres database by `scripts/schema_doc.py`.", ""]
    for schema, name, kind in rows:
        full = f"{schema}.{name}"
        n = conn.execute(f'select count(*) from "{schema}"."{name}"').fetchone()[0]
        cols = conn.execute(
            "select a.attname, format_type(a.atttypid, a.atttypmod) from pg_attribute a"
            " join pg_class c on c.oid = a.attrelid join pg_namespace s on s.oid = c.relnamespace"
            " where s.nspname = %s and c.relname = %s and a.attnum > 0 and not a.attisdropped order by a.attnum",
            (schema, name),
        ).fetchall()
        kind_label = {"BASE TABLE": "table", "VIEW": "view", "MATERIALIZED VIEW": "materialized view"}.get(kind, kind)
        out.append(f"## `{full}` ({kind_label}, {n:,} rows)")
        out.append("")
        if full in DESCRIPTIONS:
            out.append(DESCRIPTIONS[full])
            out.append("")
        shown = cols if len(cols) <= 24 else cols[:24]
        out.append(", ".join(f"`{c}` {t}" for c, t in shown) + (f", ... ({len(cols)} columns)" if len(cols) > 24 else ""))
        out.append("")
    (ROOT / "docs" / "schema.md").write_text("\n".join(out))
    print(f"wrote docs/schema.md: {len(rows)} relations")


if __name__ == "__main__":
    main()
