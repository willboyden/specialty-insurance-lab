// Local styles for the drivers / disclosures / backtest / methods views, injected once.
// Uses the page tokens from styles.css. Adds:
//  - two more categorical slots (4 yellow, 5 magenta) from the validated reference palette; slots 1-5 pass the
//    adjacent-pair checks in both modes (validate_palette.js --pairs adjacent; light-mode yellow, magenta and aqua
//    are below 3:1 on the surface, so these charts always carry a legend and a table view)
//  - a sequential one-hue (blue) ramp for heatmaps: light -> dark in light mode, anchored the other way in dark mode
//    so "near zero" recedes into the surface in both

const CSS = `
:root {
  --b-s4: #eda100;
  --b-s5: #e87ba4;
  --seq-none: #f0efec;
  --seq-1: #cde2fb; --seq-2: #9ec5f4; --seq-3: #6da7ec; --seq-4: #3987e5;
  --seq-5: #256abf; --seq-6: #1c5cab; --seq-7: #184f95; --seq-8: #0d366b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --b-s4: #c98500;
    --b-s5: #d55181;
    --seq-none: #262624;
    --seq-1: #0d366b; --seq-2: #104281; --seq-3: #184f95; --seq-4: #1c5cab;
    --seq-5: #256abf; --seq-6: #3987e5; --seq-7: #6da7ec; --seq-8: #b7d3f6;
  }
}
:root[data-theme="dark"] {
  --b-s4: #c98500;
  --b-s5: #d55181;
  --seq-none: #262624;
  --seq-1: #0d366b; --seq-2: #104281; --seq-3: #184f95; --seq-4: #1c5cab;
  --seq-5: #256abf; --seq-6: #3987e5; --seq-7: #6da7ec; --seq-8: #b7d3f6;
}

.b-minis { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 16px 20px; }
.b-mini { min-width: 0; }
.b-mini h4 { font-size: 13px; font-weight: 600; margin: 0; color: var(--ink); line-height: 1.3; }
.b-mini .b-unit { font-size: 11.5px; color: var(--ink-3); margin: 0 0 2px; }
.b-mini .b-chart { position: relative; }
.b-keys { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--ink-3); margin: 0 0 10px; }
.b-keys .b-k { display: inline-flex; align-items: center; gap: 6px; }
.b-keys svg { overflow: visible; }

.b-wide { margin-bottom: 18px; }
.b-tiles { margin: 4px 0 18px; }
.b-tiles .tile .t-value { font-size: 22px; }

.b-scale { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-3); margin: 4px 0 6px; flex-wrap: wrap; }
.b-scale .b-ramp { display: inline-flex; border-radius: 3px; overflow: hidden; }
.b-scale .b-ramp span { width: 18px; height: 10px; display: inline-block; }
.b-scale .b-none { width: 12px; height: 10px; display: inline-block; border-radius: 2px; background: var(--seq-none); margin-left: 8px; }

svg.chart .b-cell { shape-rendering: crispEdges; }
svg.chart .b-rowsel { fill: none; stroke: var(--ink); stroke-width: 1.5; }
svg.chart .b-rowhot { fill: var(--surface-2); }
svg.chart .b-seg-label { fill: var(--ink-2); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
svg.chart .b-colhot { fill: var(--surface-2); }
svg.chart .b-annot { fill: var(--ink-2); font-size: 11.5px; }
svg.chart .b-leader { stroke: var(--ink-3); stroke-width: 1; }
svg.chart .b-band { stroke: none; }
svg.chart .b-open { fill: var(--surface); stroke-width: 2; }
svg.chart .b-rowlabel { fill: var(--ink-2); font-size: 11.5px; cursor: pointer; }
svg.chart .b-rowlabel.sel { fill: var(--ink); font-weight: 650; }

.b-pipe { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0; align-items: stretch; margin: 6px 0 4px; }
.b-stage { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; margin-right: 22px; min-width: 0; }
.b-stage:last-child { margin-right: 0; }
.b-stage h4 { margin: 0 0 4px; font-size: 13px; color: var(--ink); }
.b-stage .b-tag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); }
.b-stage ul { margin: 4px 0 0; padding-left: 16px; font-size: 12px; color: var(--ink-2); }
.b-stage li { margin: 2px 0; }
.b-stage::after { content: ""; position: absolute; right: -17px; top: 50%; width: 12px; height: 12px;
  border-top: 2px solid var(--ink-3); border-right: 2px solid var(--ink-3); transform: translateY(-50%) rotate(45deg); }
.b-stage:last-child::after { display: none; }
@media (max-width: 1100px) {
  .b-pipe { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 26px; }
  .b-stage:nth-child(3)::after { display: none; }
}
@media (max-width: 640px) {
  .b-pipe { grid-template-columns: 1fr; row-gap: 22px; }
  .b-stage { margin-right: 0; }
  .b-stage::after { right: auto; left: 50%; top: auto; bottom: -17px; transform: translateX(-50%) rotate(135deg); }
  .b-stage:nth-child(3)::after { display: block; }
}

.b-sources { overflow-x: auto; }
.b-sources table { border-collapse: collapse; width: 100%; font-size: 13px; }
.b-sources th, .b-sources td { padding: 7px 10px; border-bottom: 1px solid var(--grid); text-align: left; vertical-align: top; }
.b-sources td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.b-sources thead th { color: var(--ink-2); font-weight: 600; background: var(--surface-2); }
.b-sources th[scope="row"] { font-weight: 600; }
.b-sources thead th:nth-child(n+2) { text-align: right; }
.b-sources .b-what { font-weight: 400; font-size: 12px; color: var(--ink-3); margin-top: 2px; white-space: normal; }
.b-status { display: inline-flex; align-items: center; gap: 6px; }
.b-lead { color: var(--ink-2); margin: 0 0 10px; max-width: 920px; }
.b-eq { font-family: var(--mono); font-size: 13px; background: var(--surface-2); border-radius: 8px; padding: 10px 12px;
  overflow-x: auto; white-space: pre; color: var(--ink); }
.b-cmd { font-family: var(--mono); font-size: 12.5px; background: var(--surface-2); border-radius: 8px; padding: 10px 12px;
  overflow-x: auto; white-space: pre; color: var(--ink); }
.b-diag { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--ink-2); }
`;

let injected = false;

export function ensureStyle() {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-owner", "b-views");
  s.textContent = CSS;
  document.head.append(s);
}

/** 9-step sequential fill for a share in [0, 1]: exactly zero -> "none", otherwise 8 equal bins. */
export function seqFill(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v <= 0) return "var(--seq-none)";
  const k = Math.min(8, Math.max(1, Math.ceil(v * 8)));
  return `var(--seq-${k})`;
}

export function ordinal(n: number): string {
  const r100 = n % 100;
  if (r100 >= 11 && r100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}
