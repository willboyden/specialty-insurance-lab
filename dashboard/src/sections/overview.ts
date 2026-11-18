// Overview: the specialty market by segment against the standard-lines benchmark, in four charts and a row of
// tiles. Every headline below is computed from the data at load time; none is hard-coded.
import type { AppData, Num } from "../types";
import type { Store } from "../state";
import { card, el, legend, tiles } from "../ui";
import { SEGMENT_ORDER, SEGMENT_SHORT, median, series, weightedSeries } from "../data";
import { lineChart, type LineSeries } from "../charts/lines";
import { columnChart } from "../charts/columns";
import { count, pct, pts, quarterLabel } from "../format";

interface Group {
  key: string;
  label: string;
  short: string;
  color: string;
  ciks: number[];
}

export function mountOverview(host: HTMLElement, data: AppData, store: Store) {
  const quarters = data.panel.quarters;
  const last = quarters.length - 1;
  const specialtySegs = SEGMENT_ORDER.slice(0, 4);
  const comparable = data.companies.filter((c) => c.comparable);
  const spec = comparable.filter((c) => specialtySegs.includes(c.segment));
  const segCiks = (seg: string) => comparable.filter((c) => c.segment === seg).map((c) => c.cik);
  // four groups in fixed categorical order (niche specialty has too few carriers for a stable aggregate)
  const groups: Group[] = [
    { key: "es", label: SEGMENT_SHORT[SEGMENT_ORDER[0]], short: "E&S", color: "var(--s1)", ciks: segCiks(SEGMENT_ORDER[0]) },
    { key: "div", label: SEGMENT_SHORT[SEGMENT_ORDER[1]], short: "Diversified", color: "var(--s2)", ciks: segCiks(SEGMENT_ORDER[1]) },
    { key: "bda", label: SEGMENT_SHORT[SEGMENT_ORDER[2]], short: "Bermuda", color: "var(--s3)", ciks: segCiks(SEGMENT_ORDER[2]) },
    { key: "std", label: "Standard-lines benchmark", short: "Benchmark", color: "var(--s4)", ciks: segCiks(SEGMENT_ORDER[4]) },
  ];

  const benchW = groups[3].ciks.map((c) => ({ t: data.byCik.get(c)?.ticker ?? String(c), w: (series(data, c, "npe_ttm")[last] as number) ?? 0 }))
    .filter((d) => d.w > 0).sort((a, b) => b.w - a.w);
  const benchTot = benchW.reduce((a, d) => a + d.w, 0) || 1;
  const benchMix = benchW.map((d) => `${d.t} ${Math.round((100 * d.w) / benchTot)}%`).join(", ");
  const benchTop = benchW.slice(0, 2).map((d) => data.byCik.get(groups[3].ciks.find((c) => data.byCik.get(c)?.ticker === d.t)!)?.name ?? d.t);
  const sameCompanyGrowth = (ciks: number[]): Num[] => quarters.map((_, i) => {
    if (i < 4) return null;
    let now = 0;
    let before = 0;
    let n = 0;
    for (const c of ciks) {
      const a = series(data, c, "npe_ttm")[i];
      const b = series(data, c, "npe_ttm")[i - 4];
      if (a != null && b != null && a > 0 && b > 0) { now += a; before += b; n++; }
    }
    return before > 0 && n >= 2 ? now / before - 1 : null;
  });
  const cr = new Map(groups.map((g) => [g.key, weightedSeries(data, g.ciks, "combined_ratio_ttm")]));
  const growth = new Map(groups.map((g) => [g.key, sameCompanyGrowth(g.ciks)]));
  const crSpecAll = weightedSeries(data, spec.map((c) => c.cik), "combined_ratio_ttm");
  const pydSpec = weightedSeries(data, spec.map((c) => c.cik), "pyd_ratio_ttm");
  const lastOf = (s: Num[]) => { for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return { v: s[i] as number, i }; return { v: NaN, i: -1 }; };
  // average of the Q4 (fiscal-year) trailing values from 2015 on
  const avgSince = (s: Num[], fromYear = 2015) => {
    const v = quarters.map((q, i) => ({ q, v: s[i] })).filter((d) => d.q.slice(5, 7) === "12" && Number(d.q.slice(0, 4)) >= fromYear && d.v != null).map((d) => d.v as number);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };

  // ---------------------------------------------------------------- tiles
  const crS = lastOf(crSpecAll);
  const crB = lastOf(cr.get("std")!);
  const pyd = lastOf(pydSpec);
  const roes = spec.filter((c) => c.status === "active").map((c) => series(data, c.cik, "roe_ttm")[last]).filter((v): v is number => v != null);
  const growthNow = spec.filter((c) => c.status === "active").map((c) => series(data, c.cik, "npe_growth_yoy")[last]).filter((v): v is number => v != null);
  const active = spec.filter((c) => c.status === "active").length;
  const tileHost = el("div");
  host.append(tileHost);
  tiles(tileHost, [
    { label: `Specialty combined ratio, TTM ${quarterLabel(quarters[crS.i] ?? quarters[last])}`, value: pct(crS.v),
      delta: `Standard-lines benchmark ${pct(crB.v)} (mostly ${benchTop.join(" and ")})`,
      title: "Premium-weighted across comparable specialty carriers; the benchmark is premium-weighted too" },
    { label: "Median specialty premium growth, TTM", value: pct(median(growthNow)),
      delta: `Premium-weighted: ${pct(lastOf(sameCompanyGrowth(spec.map((c) => c.cik))).v)}`,
      title: "The median carrier grows much faster than the premium-weighted total: the largest groups are shrinking" },
    { label: "Reserve development, TTM", value: pts(pyd.v), delta: pyd.v < 0 ? "Favorable: prior years releasing" : "Adverse: prior years strengthening",
      tone: pyd.v < 0 ? "down-good" : "up-bad", title: "Premium-weighted prior-year development, points of premium" },
    { label: "Median specialty ROE, TTM", value: pct(median(roes)), delta: `${roes.length} active carriers` },
    { label: "Specialty carriers tracked", value: count(spec.length), delta: `${active} active · ${spec.length - active} acquired or exited` },
    { label: "SEC facts in the database", value: count(data.meta.xbrl.facts), delta: `${count(data.companies.reduce((a, c) => a + c.filings, 0))} filings indexed` },
  ]);
  host.append(el("div", { style: "height:16px" }));
  const grid = el("div", { class: "grid" });
  host.append(grid);
  const groupLegend = (c: { legend: HTMLElement }) => legend(c.legend, groups.map((g) => ({ label: g.label, color: g.color })));
  const groupSeries = (m: Map<string, Num[]>): LineSeries[] =>
    groups.map((g) => ({ id: g.key, label: g.short, values: m.get(g.key)!, role: "ref", color: g.color }));

  // ---------------------------------------------------------------- combined ratio by segment
  const avgCr = groups.map((g) => ({ g, v: avgSince(cr.get(g.key)!) })).filter((d) => Number.isFinite(d.v)).sort((a, b) => a.v - b.v);
  // volatility: standard deviation of the fiscal-year values since 2015
  const sdSince = (sx: Num[]) => {
    const v = quarters.map((q, i) => ({ q, v: sx[i] })).filter((d) => d.q.slice(5, 7) === "12" && Number(d.q.slice(0, 4)) >= 2015 && d.v != null).map((d) => d.v as number);
    const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
    return v.length > 2 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : NaN;
  };
  const vol = groups.map((g) => ({ g, v: sdSince(cr.get(g.key)!) })).filter((d) => Number.isFinite(d.v)).sort((a, b) => b.v - a.v);
  const spread = avgCr.length ? avgCr[avgCr.length - 1].v - avgCr[0].v : NaN;
  const crTitle = !avgCr.length ? "Combined ratio by segment"
    : spread < 0.02 && vol.length
      ? `Since 2015 the segments averaged within ${(spread * 100).toFixed(1)} pts of each other; ${vol[0].g.short} swings the most`
      : `Lowest average combined ratio since 2015: ${avgCr[0].g.label} (${pct(avgCr[0].v)})`;
  const c1 = card(grid, {
    title: crTitle,
    span: 6, id: "ov-cr", sub: "Combined ratio, trailing four quarters, premium-weighted by segment",
  });
  groupLegend(c1);
  lineChart({
    card: c1, store, quarters, height: 280, label: "Combined ratio by segment", fmt: (v) => pct(v), getFrom: () => "2010-03-31",
    getRef: () => ({ value: 1, label: "100%" }), getSeries: () => groupSeries(cr),
  });
  c1.caption.textContent = `Average of fiscal-year values since 2015: ${avgCr.map((d) => `${d.g.short} ${pct(d.v)}`).join(" · ")}; `
    + `year-to-year standard deviation: ${vol.map((d) => `${d.g.short} ${(d.v * 100).toFixed(1)} pts`).join(" · ")}. `
    + `Expense ratios are rebuilt from XBRL tags (see methods). The benchmark is premium-weighted, so it is mostly `
    + `${benchTop.join(" and ")}: ${benchMix}.`;
  c1.setTable(() => ({
    columns: ["Quarter", ...groups.map((g) => g.label)],
    rows: quarters.map((q, i) => [quarterLabel(q), ...groups.map((g) => pct(cr.get(g.key)![i]))]).filter((r) => r.slice(1).some((v) => v !== "–")),
  }));

  // ---------------------------------------------------------------- growth by segment
  const gNow = groups.map((g) => ({ g, v: lastOf(growth.get(g.key)!).v })).filter((d) => Number.isFinite(d.v)).sort((a, b) => b.v - a.v);
  const c2 = card(grid, {
    title: gNow.length >= 2 ? `Growth has split: ${gNow[0].g.label} ${pct(gNow[0].v)}, ${gNow[gNow.length - 1].g.label} ${pct(gNow[gNow.length - 1].v)}` : "Premium growth by segment",
    span: 6, id: "ov-growth", sub: "Net premiums earned, same-company growth over four quarters, by segment",
  });
  groupLegend(c2);
  lineChart({
    card: c2, store, quarters, height: 280, label: "Premium growth by segment", fmt: (v) => pct(v), getFrom: () => "2011-03-31",
    zeroLine: true, getSeries: () => groupSeries(growth),
  });
  c2.caption.textContent = "Same-company growth compares only carriers that filed in both periods, so IPOs and acquisitions do not count as growth. "
    + `Latest quarter: ${gNow.map((d) => `${d.g.label} ${pct(d.v)}`).join(" · ")}.`;
  c2.setTable(() => ({
    columns: ["Quarter", ...groups.map((g) => g.label)],
    rows: quarters.map((q, i) => [quarterLabel(q), ...groups.map((g) => pct(growth.get(g.key)![i]))]).filter((r) => r.slice(1).some((v) => v !== "–")),
  }));

  // ---------------------------------------------------------------- reserve development
  const pydIdx = quarters.map((q, i) => ({ q, i })).filter((d) => d.q >= "2011-03-31" && pydSpec[d.i] != null);
  const fav = pydIdx.filter((d) => (pydSpec[d.i] as number) < 0).length;
  const pydAvgEarly = avgSince(pydSpec, 2011);
  const pydRecent = (() => {
    const v = pydIdx.filter((d) => d.q >= quarters[Math.max(0, last - 11)]).map((d) => pydSpec[d.i] as number);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  })();
  const thinned = Number.isFinite(pydRecent) && Number.isFinite(pydAvgEarly) && pydRecent > pydAvgEarly + 0.003;
  const c3 = card(grid, {
    title: thinned
      ? `Reserve releases have thinned: ${pts(pydAvgEarly)} a year since 2011, ${pts(pydRecent)} lately`
      : `Reserve development: favorable in ${fav} of ${pydIdx.length} quarters`,
    span: 6, id: "ov-pyd",
    sub: "Prior-year reserve development of specialty carriers, points of premium (TTM, premium-weighted)",
  });
  legend(c3.legend, [{ label: "Favorable (released)", color: "var(--div-neg)", shape: "box" }, { label: "Adverse (strengthened)", color: "var(--div-pos)", shape: "box" }]);
  columnChart({
    card: c3, label: "Prior-year reserve development of specialty carriers by quarter",
    periods: pydIdx.map((d) => (d.q.slice(5, 7) === "03" && Number(d.q.slice(0, 4)) % 2 === 1 ? d.q.slice(0, 4) : "")), tickEvery: 1, height: 240,
    fmt: (v) => pts(v), divergingColors: { neg: "var(--div-neg)", pos: "var(--div-pos)" },
    getSeries: () => [{ key: "pyd", label: "Reserve development", color: "var(--div-neg)", values: pydIdx.map((d) => pydSpec[d.i]) }],
    title: (k) => quarterLabel(pydIdx[k].q),
  });
  c3.caption.textContent = `Negative = carriers lowered their estimates for earlier years' claims, which flatters the current combined ratio. `
    + `Favorable in ${fav} of ${pydIdx.length} quarters. Fiscal-year average since 2011: ${pts(pydAvgEarly)}; average of the last 12 quarters: ${pts(pydRecent)}.`;
  c3.setTable(() => ({ columns: ["Quarter", "Development"], rows: pydIdx.map((d) => [quarterLabel(d.q), pts(pydSpec[d.i])]) }));

  // ---------------------------------------------------------------- consolidation
  const years = Array.from({ length: 2026 - 2009 + 1 }, (_, k) => 2009 + k);
  const filingIn = (cik: number, y: number) => quarters.some((q, i) => q.startsWith(String(y)) && series(data, cik, "npe")[i] != null);
  const activeByYear = years.map((y) => spec.filter((c) => filingIn(c.cik, y)).length);
  const exitsByYear = years.map((y) => spec.filter((c) => c.status !== "active" && c.statusYear === y));
  const peak = Math.max(...activeByYear);
  const c4 = card(grid, {
    title: `A consolidating market: ${peak} carriers at the peak, ${activeByYear[activeByYear.length - 1]} today`, span: 6, id: "ov-consolidation",
    sub: "Specialty carriers in the universe reporting results each year",
  });
  columnChart({
    card: c4, label: "Number of specialty carriers reporting each year", periods: years.map((y) => (y % 2 ? "" : String(y))), tickEvery: 1,
    height: 240, fmt: (v) => count(v),
    getSeries: () => [{ key: "n", label: "Carriers reporting", color: "var(--s1)", values: activeByYear }],
    title: (k) => String(years[k]),
    note: (k) => exitsByYear[k].length ? `Left that year: ${exitsByYear[k].map((c) => `${c.name} (${c.statusNote ?? c.status})`).join("; ")}` : undefined,
  });
  const exits = spec.filter((c) => c.status !== "active").sort((a, b) => (a.statusYear ?? 0) - (b.statusYear ?? 0));
  const acquired = exits.filter((c) => c.status === "acquired").length;
  const firstPeriodic = (c: (typeof spec)[number]): number | null => {
    const ys = Object.entries(c.filingsByYear ?? {}).filter(([, k]) => (k.annual ?? 0) + (k.quarterly ?? 0) > 0).map(([y]) => Number(y)).sort((a, b) => a - b);
    return ys.length ? ys[0] : null;
  };
  const newcomers = spec.filter((c) => c.status === "active").map((c) => ({ c, y: firstPeriodic(c) }))
    .filter((d) => d.y != null && d.y >= 2012).sort((a, b) => (a.y as number) - (b.y as number));
  c4.caption.textContent = `${exits.length} carriers left the public market from ${exits[0]?.statusYear ?? "–"} on (${acquired} through acquisitions). `
    + `First 10-K or 10-Q after 2011: ${newcomers.map((d) => `${d.c.name} ${d.y}`).join(", ") || "none"}. 2009 is partial: XBRL tagging began that year.`;
  c4.setTable(() => ({
    columns: ["Year", "Carriers reporting", "Left that year"],
    rows: years.map((y, k) => [String(y), String(activeByYear[k]), exitsByYear[k].map((c) => c.name).join(", ") || "–"]),
  }));
}
