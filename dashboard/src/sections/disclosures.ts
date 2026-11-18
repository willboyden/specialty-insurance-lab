// Disclosures: how often carriers' 10-K and 10-Q filings discuss each risk theme (SEC full-text search).
import type { AppData, Company } from "../types";
import type { Store } from "../state";
import { card, el, legend } from "../ui";
import { SEGMENT_ORDER, SEGMENT_SHORT, visibleCompanies } from "../data";
import { ensureStyle } from "../charts/b-style";
import { yearLines } from "../charts/b-yearlines";
import { matrix, type MatrixRow } from "../charts/theme-matrix";

// theme -> label and the phrases SEC full-text search looked for (sil/sources/efts.py THEMES)
const THEME: Record<string, { label: string; short: string; phrases: string[] }> = {
  ai: { label: "Artificial intelligence", short: "AI", phrases: ["artificial intelligence", "generative AI", "machine learning", "large language model"] },
  climate: { label: "Climate change", short: "Climate", phrases: ["climate change", "climate-related"] },
  geopolitical: { label: "Geopolitics", short: "Geopolitics", phrases: ["geopolitical"] },
  war_conflict: { label: "Russia-Ukraine and Middle East wars", short: "War", phrases: ["Russia-Ukraine", "Russia and Ukraine", "war in Ukraine", "Israel-Hamas", "Middle East conflict"] },
  political_risk_line: { label: "Political risk", short: "Political risk", phrases: ["political risk"] },
  trade_credit_line: { label: "Trade credit", short: "Trade credit", phrases: ["trade credit"] },
  tariffs_trade: { label: "Tariffs", short: "Tariffs", phrases: ["tariff"] },
  social_inflation: { label: "Social inflation", short: "Social inflation", phrases: ["social inflation", "litigation funding", "nuclear verdict"] },
  d_and_o: { label: "Directors and officers (D&O)", short: "D&O", phrases: ["directors and officers", "D&O"] },
  securities_litigation: { label: "Securities class actions", short: "Securities suits", phrases: ["securities class action"] },
  cyber: { label: "Cyber", short: "Cyber", phrases: ["cyber", "cybersecurity"] },
  pandemic: { label: "Pandemic", short: "Pandemic", phrases: ["pandemic"] },
  wildfire: { label: "Wildfire", short: "Wildfire", phrases: ["wildfire"] },
  hurricane: { label: "Hurricane", short: "Hurricane", phrases: ["hurricane"] },
  convective_storm: { label: "Convective storms", short: "Convective", phrases: ["convective storm"] },
  aviation_line: { label: "Aviation", short: "Aviation", phrases: ["aviation"] },
  marine_line: { label: "Marine", short: "Marine", phrases: ["marine"] },
};

const TREND_THEMES = ["ai", "climate", "geopolitical", "social_inflation", "cyber", "tariffs_trade", "war_conflict", "pandemic"];
const MATRIX_THEMES = ["ai", "climate", "geopolitical", "war_conflict", "political_risk_line", "trade_credit_line",
  "tariffs_trade", "social_inflation", "d_and_o", "cyber", "pandemic", "wildfire"];
const YEAR_THEMES = [...MATRIX_THEMES, "securities_litigation", "hurricane", "convective_storm", "aviation_line", "marine_line"];

const pct0 = (v: number) => `${Math.round(v * 100)}%`;

function phrasesNote(theme: string): string {
  const t = THEME[theme];
  return t ? `Searched for: ${t.phrases.map((p) => `“${p}”`).join(", ")}` : "";
}

export function mountDisclosures(host: HTMLElement, data: AppData, store: Store) {
  ensureStyle();
  const d = data.disclosure;
  const years = d.years;
  const builtYear = Number(data.meta.built.slice(0, 4));
  const partialYear = years.includes(builtYear) ? builtYear : undefined;
  const lastFull = partialYear ? partialYear - 1 : years[years.length - 1];
  const series = (cik: number) => d.series[String(cik)];
  const active = data.companies.filter((c) => c.cohort === "specialty" && c.status === "active" && series(c.cik));

  // pooled share across active specialty carriers: mentions / filings, per year
  const pooled = (theme: string) => years.map((_, i) => {
    let num = 0;
    let den = 0;
    for (const c of active) {
      const s = series(c.cik);
      const n = s.filings?.[i] ?? 0;
      const v = s[theme]?.[i];
      if (n > 0 && v != null) {
        num += (v as number) * (n as number);
        den += n as number;
      }
    }
    return den > 0 ? num / den : null;
  });
  const pooledFilings = years.map((_, i) => active.reduce((s, c) => s + ((series(c.cik).filings?.[i] as number) ?? 0), 0));

  const grid = el("div", { class: "grid" });
  host.append(grid);

  // ---- (a) theme trends
  const tc = card(grid, {
    title: "Themes over time",
    sub: "Share of 10-K and 10-Q filings that mention each theme, per year",
    span: 12, id: "disclosure-trends",
  });
  const minis = el("div", { class: "b-minis" });
  tc.body.append(minis);
  const trendRedraws: (() => void)[] = [];
  const drawTrends = () => {
    const sel = data.byCik.get(store.get().selected);
    legend(tc.legend, [
      { label: `All active specialty carriers (${active.length}, filings pooled)`, color: "var(--s1)" },
      { label: sel ? `${sel.name} (${sel.ticker})` : "Selected company", color: "var(--s2)" },
    ]);
    minis.replaceChildren();
    trendRedraws.length = 0;
    for (const theme of TREND_THEMES) {
      const t = THEME[theme];
      const ch = el("div", { class: "b-chart" });
      minis.append(el("div", { class: "b-mini" }, el("h4", { text: t.label }), el("p", { class: "b-unit", text: "% of filings" }), ch));
      const own = sel && series(sel.cik) ? (series(sel.cik)[theme] ?? years.map(() => null)) : years.map(() => null);
      trendRedraws.push(yearLines({
        host: ch, store, years, partialYear, fmt: pct0, domain: [0, 1],
        label: `${t.label}: share of filings mentioning it, ${years[0]} to ${years[years.length - 1]}`,
        series: [
          { label: "All active specialty carriers", color: "var(--s1)", values: pooled(theme), strong: true },
          { label: sel ? sel.ticker : "Selected", color: "var(--s2)", values: own as (number | null)[] },
        ],
        note: (i) => `${pooledFilings[i]} filings pooled · ${phrasesNote(theme)}`,
      }));
    }
  };
  drawTrends();
  tc.onRedraw(() => trendRedraws.forEach((r) => r()));
  store.on(["selected"], () => drawTrends());
  tc.caption.textContent = "A filing counts when SEC full-text search finds at least one of the theme's phrases in any of "
    + "its documents; the share divides by the company's 10-K and 10-Q filings that year. This measures how much a "
    + `company discusses a theme, not how exposed it is.${partialYear ? ` ${partialYear} is the year to date (open dots).` : ""}`;
  tc.setTable(() => ({
    columns: ["Year", "Filings pooled", ...TREND_THEMES.map((t) => THEME[t].label)],
    rows: years.map((y, i) => [partialYear === y ? `${y} (to date)` : String(y), String(pooledFilings[i]),
      ...TREND_THEMES.map((t) => { const v = pooled(t)[i]; return v == null ? "–" : pct0(v); })]).reverse(),
    caption: "Share of active specialty carriers' filings mentioning each theme",
  }));

  // ---- (b) company x theme matrix, last three complete years with filings
  const mc = card(grid, {
    title: "Who discusses what",
    sub: "Share of each carrier's filings mentioning the theme, over its last three complete years of filings",
    span: 7, id: "disclosure-matrix",
  });
  scaleKey(mc.legend);
  const window3 = (c: Company) => {
    const s = series(c.cik);
    if (!s) return null;
    const idx: number[] = [];
    for (let i = years.length - 1; i >= 0 && idx.length < 3; i--) {
      if (years[i] <= lastFull && ((s.filings?.[i] as number) ?? 0) > 0) idx.push(i);
    }
    if (!idx.length) return null;
    const filings = idx.reduce((a, i) => a + ((s.filings[i] as number) ?? 0), 0);
    const share = (theme: string) => {
      let num = 0;
      for (const i of idx) num += ((s[theme]?.[i] as number) ?? 0) * ((s.filings[i] as number) ?? 0);
      return filings > 0 ? num / filings : null;
    };
    const a = years[idx[idx.length - 1]];
    const b = years[idx[0]];
    return { idx, filings, share, span: a === b ? String(a) : `${a}–${b}` };
  };
  let redrawMatrix: () => void = () => {};
  const drawMatrix = () => {
    const st = store.get();
    const comps = visibleCompanies(data, st.segments, st.historical)
      .filter((c) => window3(c))
      .sort((a, b) => SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment) || a.name.localeCompare(b.name));
    const wins = comps.map((c) => window3(c)!);
    const rows: MatrixRow[] = comps.map((c) => ({
      id: String(c.cik), label: `${c.name} (${c.ticker})`, short: c.ticker, group: SEGMENT_SHORT[c.segment] ?? c.segment,
    }));
    if (!rows.length) {
      mc.body.replaceChildren(el("p", { class: "empty", text: "No carriers in the selected segments." }));
      return;
    }
    redrawMatrix = matrix({
      host: mc.body, store, rows, cols: MATRIX_THEMES.map((t) => ({ id: t, label: THEME[t].short })),
      label: "Share of filings mentioning each theme, by carrier",
      value: (i, j) => wins[i].share(MATRIX_THEMES[j]),
      tip: (i, j) => {
        const c = comps[i];
        if (j < 0) return { title: `${c.name} (${c.ticker})`, rows: [{ name: "Filings", value: `${wins[i].filings} (${wins[i].span})` }], note: "Click to focus this company" };
        const v = wins[i].share(MATRIX_THEMES[j]);
        return {
          title: `${c.name} (${c.ticker})`,
          rows: [
            { color: "var(--s1)", name: THEME[MATRIX_THEMES[j]].label, value: v == null ? "–" : pct0(v), strong: true },
            { name: "Filings", value: `${wins[i].filings} 10-K/10-Q, ${wins[i].span}` },
          ],
          note: phrasesNote(MATRIX_THEMES[j]),
        };
      },
      selectedId: () => String(store.get().selected),
      onRowClick: (i) => store.set({ selected: comps[i].cik }),
      onRowHover: (i) => store.set({ hover: i == null ? null : comps[i].cik }),
      maxCell: 44,
      rotate: -40,
    });
    mc.setTable(() => ({
      columns: ["Company", "Years", "Filings", ...MATRIX_THEMES.map((t) => THEME[t].label)],
      rows: comps.map((c, i) => [`${c.name} (${c.ticker})`, wins[i].span, String(wins[i].filings),
        ...MATRIX_THEMES.map((t) => { const v = wins[i].share(t); return v == null ? "–" : pct0(v); })]),
      caption: "Share of filings mentioning each theme, by carrier",
    }));
  };
  drawMatrix();
  mc.onRedraw(() => redrawMatrix());
  // always redraw: the table twin must follow the filters too; a hidden matrix re-renders at full width when shown
  store.on(["segments", "historical", "selected"], () => drawMatrix());
  mc.caption.textContent = "Rows follow the segment and history filters above; click a row to focus that company. "
    + "Read the shades against the key: its right end is a theme a carrier raises in nearly every filing, and the "
    + "neutral gray means no mention at all.";

  // ---- (c) selected company: theme x year
  const yc = card(grid, { title: "Themes by year", sub: "", span: 5, id: "disclosure-years" });
  scaleKey(yc.legend);
  let redrawYears: () => void = () => {};
  const drawYears = () => {
    const sel = data.byCik.get(store.get().selected);
    const s = sel ? series(sel.cik) : undefined;
    yc.setTitle(sel ? `${sel.name}: themes by year` : "Themes by year",
      "Share of the company's 10-K and 10-Q filings mentioning each theme");
    if (!sel || !s) {
      yc.body.replaceChildren(el("p", { class: "empty", text: "No filings found for this company." }));
      return;
    }
    // columns start at the company's first year with a 10-K or 10-Q in the index
    const first = Math.max(0, years.findIndex((_, i) => ((s.filings?.[i] as number) ?? 0) > 0));
    const yrs = years.slice(first);
    const filings = (j: number) => (s.filings?.[first + j] as number) ?? 0;
    const share = (t: string, j: number) => (s[t]?.[first + j] as number | null) ?? 0;
    redrawYears = matrix({
      host: yc.body, store,
      rows: YEAR_THEMES.map((t) => ({ id: t, label: THEME[t].label, short: THEME[t].short })),
      cols: yrs.map((y) => ({ id: String(y), label: String(y) })),
      label: `${sel.name}: share of filings mentioning each theme, by year`,
      value: (i, j) => (filings(j) > 0 ? share(YEAR_THEMES[i], j) : null),
      tip: (i, j) => {
        const t = THEME[YEAR_THEMES[i]];
        if (j < 0) return { title: t.label, rows: [], note: phrasesNote(YEAR_THEMES[i]) };
        const n = filings(j);
        const v = share(YEAR_THEMES[i], j);
        return {
          title: `${sel.ticker} · ${yrs[j]}${yrs[j] === partialYear ? " (to date)" : ""}`,
          rows: [
            { color: "var(--s1)", name: t.label, value: n > 0 ? pct0(v) : "no filings", strong: true },
            { name: "10-K/10-Q filings", value: String(n) },
          ],
          note: phrasesNote(YEAR_THEMES[i]),
        };
      },
      colFromState: (st) => (st.hoverQuarter ? yrs.indexOf(Number(st.hoverQuarter.slice(0, 4))) : null),
      onColHover: (j) => store.set({ hoverQuarter: j == null ? null : `${yrs[j]}-12-31` }),
      maxCell: 30,
      rotate: -60,
      labelEvery: (w) => (yrs.length <= 12 ? 1 : w < 520 ? 5 : 2),
    });
    yc.setTable(() => ({
      columns: ["Theme", ...yrs.map(String)],
      rows: YEAR_THEMES.map((t) => [THEME[t].label, ...yrs.map((_, j) => (filings(j) > 0 ? pct0(share(t, j)) : "–"))]),
      caption: `${sel.name}: share of filings mentioning each theme, by year`,
    }));
  };
  drawYears();
  yc.onRedraw(() => redrawYears());
  store.on(["selected"], () => drawYears());
  yc.caption.textContent = "Columns start at the company's first 10-K or 10-Q in the full-text index (2001 at the "
    + "earliest); blank columns are years without one. Hover a year to move the crosshair on every time chart on the page.";
}

function scaleKey(host: HTMLElement) {
  const ramp = el("span", { class: "b-ramp", "aria-hidden": "true" });
  for (let k = 1; k <= 8; k++) {
    const s = el("span");
    s.style.background = `var(--seq-${k})`;
    ramp.append(s);
  }
  const none = el("span", { class: "b-none", "aria-hidden": "true" });
  host.append(el("div", { class: "b-scale" }, el("span", { text: "0%" }), ramp, el("span", { text: "100% of filings" }), none,
    el("span", { text: "never mentioned" })));
}
