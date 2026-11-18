// Catastrophes: the perils US agencies record (hurricanes, convective storms, floods, wildfire, earthquakes), how
// much of the loss model's industry shock they explain, where the losses land, which carriers carry the risk,
// and (once the filing documents are cached) the catastrophe losses carriers report. Data: catastrophe.json.
import "./catastrophes.css";
import type { AppData, Num } from "../types";
import type { Store } from "../state";
import type { CatastropheData, CatStateKey } from "../domains/catastrophe";
import { card, el, legend, segmented, tiles, type Tile } from "../ui";
import { ensureStyle, ordinal } from "../charts/b-style";
import { coefChart, shockFitChart } from "../charts/cat-shockfit";
import { annualMini, type AnnualPart } from "../charts/cat-annual";
import { tileMap } from "../charts/cat-tilemap";
import { barList } from "../charts/cat-bars";
import { ensoChart, type EnsoPoint } from "../charts/cat-enso";
import { sensChart, type SensRow } from "../charts/cat-sens";
import { level, reportedChart } from "../charts/cat-reported";
import { fmtSigma } from "../charts/driver-panels";
import { count, money, pts, quarterLabel } from "../format";
import { SEGMENT_SHORT } from "../data";

// quarters that coincide with well-known catastrophes (labels only; nothing here feeds a number)
const EVENTS: Record<string, string> = {
  "2010-03-31": "Chile earthquake",
  "2011-03-31": "Tōhoku, Christchurch",
  "2011-06-30": "US tornado outbreaks",
  "2011-12-31": "Thai floods",
  "2012-12-31": "Sandy",
  "2017-09-30": "Harvey, Irma, Maria",
  "2017-12-31": "California wildfires",
  "2018-12-31": "Camp Fire, Michael",
  "2019-12-31": "Typhoons Faxai, Hagibis",
  "2020-09-30": "Laura, derecho, wildfires",
  "2021-03-31": "Winter Storm Uri",
  "2021-09-30": "Ida, European floods",
  "2022-09-30": "Ian",
  "2023-03-31": "Türkiye earthquake",
  "2024-09-30": "Helene, Beryl, Francine",
  "2024-12-31": "Milton",
  "2025-03-31": "Los Angeles wildfires",
};

const STATE_METRICS: { key: CatStateKey; label: string; short: string; fmt: (v: number) => string }[] = [
  { key: "nfip_paid", label: "NFIP flood claims paid", short: "Flood claims", fmt: (v) => money(v) },
  { key: "storm_damage", label: "Storm property damage (NOAA Storm Events)", short: "Storm damage", fmt: (v) => money(v) },
  { key: "sig_hail", label: "Hail reports, 2 inches or larger", short: "Large hail", fmt: (v) => count(v) },
  { key: "sig_tornadoes", label: "Tornadoes rated EF2 or stronger", short: "EF2+ tornadoes", fmt: (v) => count(v) },
  { key: "fema_major", label: "FEMA major disaster declarations", short: "Disasters", fmt: (v) => count(v) },
];

const num = (v: Num): v is number => v != null && Number.isFinite(v);

function mean(values: Num[], years: number[], y0: number, y1: number): number | null {
  const v = years.map((y, i) => (y >= y0 && y <= y1 ? values[i] : null)).filter(num);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function signedPct(a: number, b: number): string {
  const d = a / b - 1;
  return `${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d * 100))}%`;
}

function oniLabel(v: number): string {
  const s = Math.abs(v);
  const phase = v >= 0.5 ? "El Niño" : v <= -0.5 ? "La Niña" : "neutral";
  if (phase === "neutral") return "ENSO-neutral";
  return `${s >= 2 ? "very strong" : s >= 1.5 ? "strong" : s >= 1 ? "moderate" : "weak"} ${phase}`;
}

/** a correlation or R², two decimals, with a true minus sign */
function r2s(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "–" : v.toFixed(2).replace("-", "−");
}

function signedC(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)} °C`;
}

export const catastropheSection = {
  id: "catastrophes",
  nav: "Catastrophes",
  title: "Catastrophes: perils, insured losses and who carries them",
  intro: (d: AppData): string => {
    const c = d.catastrophe as CatastropheData | null;
    if (!c?.years) return "Catastrophe data has not been exported yet.";
    return "Hurricanes, convective storms, floods, wildfire and earthquakes as the agencies that record them "
      + `report them (NOAA, USGS, NIFC, FEMA; ${c.years[0]}–${c.years[c.years.length - 1]}), set against the `
      + "industry shock the loss model found in the carriers' own loss ratios, and each carrier's exposure to it.";
  },
  mount(host: HTMLElement, data: AppData, store: Store): void {
    const c = data.catastrophe as CatastropheData | null;
    if (!c?.years) {
      host.append(el("p", { class: "empty", text: "Run the catastrophe domain export to fill this section." }));
      return;
    }
    ensureStyle();
    const Y = c.years;
    const lastY = Y[Y.length - 1];
    const yi = (y: number) => Y.indexOf(y);

    // ---------------------------------------------------------------- headline tiles
    const tileHost = el("div", { class: "b-tiles" });
    host.append(tileHost);
    const items: Tile[] = [];
    const land = c.y.landfalls;
    const lastLand = land[yi(lastY)];
    if (num(lastLand)) {
      let prevZero: number | null = null;
      for (let k = yi(lastY) - 1; k >= 0; k--) if (land[k] === 0) { prevZero = Y[k]; break; }
      items.push({
        label: `US hurricane landfalls, ${lastY}`, value: String(lastLand),
        delta: lastLand === 0 && prevZero != null ? `first season without one since ${prevZero}`
          : `${(mean(land, Y, lastY - 10, lastY - 1) ?? 0).toFixed(1)} a year in ${lastY - 10}–${lastY - 1}`,
      });
    }
    const ace = c.y.ace;
    const aceLast = ace[yi(lastY)];
    if (num(aceLast)) {
      const hist = ace.filter(num);
      const p = Math.round((hist.filter((v) => v <= aceLast).length / hist.length) * 100);
      items.push({ label: `Atlantic season energy (ACE), ${lastY}`, value: aceLast.toFixed(0),
        delta: `${ordinal(Math.max(1, Math.min(100, p)))} percentile of ${Y.length} seasons since ${Y[0]}` });
    }
    const acres = c.y.wildfireAcres;
    const lastAcresI = acres.map((v, i) => (num(v) ? i : -1)).filter((i) => i >= 0).pop();
    if (lastAcresI != null) {
      const a = acres[lastAcresI] as number;
      const prior = mean(acres, Y, Y[lastAcresI] - 10, Y[lastAcresI] - 1);
      items.push({ label: `Acres burned, ${Y[lastAcresI]}`, value: `${(a / 1e6).toFixed(1)}M`,
        delta: prior ? `${signedPct(a, prior)} vs the ${Y[lastAcresI] - 10}–${Y[lastAcresI] - 1} average` : undefined });
    }
    const nfipTotal = c.y.nfipPaid.filter(num).reduce((s, v) => s + v, 0);
    const nfipFirst = Y[c.y.nfipPaid.findIndex(num)];
    if (nfipTotal > 0) {
      items.push({ label: `NFIP flood claims paid, ${nfipFirst}–${lastY}`, value: money(nfipTotal),
        delta: `${count(c.y.nfipClaims.filter(num).reduce((s, v) => s + v, 0))} claims, at today's prices` });
    }
    const ol = c.oni.latest;
    if (ol && num(ol.anom)) {
      items.push({ label: `ENSO (Oceanic Niño Index), ${ol.season} ${ol.year}`, value: signedC(ol.anom),
        delta: oniLabel(ol.anom) });
    }
    tiles(tileHost, items);

    const grid = el("div", { class: "grid" });
    host.append(grid);

    // ---------------------------------------------------------------- the industry shock vs US perils
    const fit = c.fit;
    const sc = card(grid, {
      title: fit.cvR2 != null
        ? `US perils explain ${Math.round((fit.r2 ?? 0) * 100)}% of the industry shock in sample, ${Math.max(0, Math.round(fit.cvR2 * 100))}% out of sample`
        : "The industry shock and US perils",
      sub: "The loss model's quarterly industry shock (σ) and the shock predicted from US hurricane landfalls, severe "
        + "convective storms, NFIP flood claims and wildfire damage",
      span: 7, id: "cat-shockfit",
    });
    legend(sc.legend, [
      { label: "Industry shock (model, 80% band)", color: "var(--s1)" },
      { label: "Predicted from US perils", color: "var(--s2)" },
    ]);
    sc.onRedraw(shockFitChart({ card: sc, store, quarters: c.quarters, f: c.q.f, f10: c.q.f10, f90: c.q.f90,
      fitted: c.q.fitted, events: EVENTS, labelTop: 8 }));
    const unexplained = fit.largest.filter((d) => num(d.f) && num(d.fitted))
      .map((d) => ({ ...d, gap: (d.f as number) - (d.fitted as number) })).sort((a, b) => b.gap - a.gap).slice(0, 2);
    if (fit.window) {
      sc.caption.textContent = `Ordinary least squares on ${fit.n} quarters (${quarterLabel(fit.window[0])} to `
        + `${quarterLabel(fit.window[1])}): R² ${r2s(fit.r2)}, adjusted ${r2s(fit.adjR2)}; refit without `
        + `each year in turn and asked to predict it, ${r2s(fit.cvR2)}. `
        + (unexplained.length ? "The largest gaps are events these US indices cannot see: "
          + unexplained.map((d) => `${quarterLabel(d.q)} (${EVENTS[d.q] ?? "no single named event"}): shock `
            + `${fmtSigma(d.f)}, predicted ${fmtSigma(d.fitted)}`).join("; ") + ". " : "")
        + "The carriers write worldwide; the indices are US only.";
    }
    sc.setTable(() => ({
      columns: ["Quarter", "Industry shock", "80% low", "80% high", "Predicted from US perils", "Gap"],
      rows: c.quarters.map((q, i) => ({ q, i })).filter(({ i }) => num(c.q.f[i])).map(({ q, i }) => [
        quarterLabel(q), fmtSigma(c.q.f[i]), fmtSigma(c.q.f10[i]), fmtSigma(c.q.f90[i]), fmtSigma(c.q.fitted[i]),
        num(c.q.fitted[i]) ? fmtSigma((c.q.f[i] as number) - (c.q.fitted[i] as number)) : "–"]).reverse(),
      caption: "Industry shock and the shock predicted from US perils",
    }));

    const terms = fit.terms.filter((t) => t.key !== "(intercept)" && num(t.coef) && num(t.se));
    const strong = terms.filter((t) => Math.abs((t.coef as number) / (t.se as number)) >= 1.96);
    const short = (label: string) => label.split(" (")[0].replace(/^US /, "").toLowerCase();
    const cc = card(grid, {
      title: strong.length
        ? `${strong.map((t) => short(t.label)).join(" and ").replace(/^./, (s) => s.toUpperCase())} move the shock; the rest add nothing measurable`
        : "No single peril index moves the shock on its own",
      sub: "Change in the shock per standard deviation of each index, the other three held fixed, with 95% intervals",
      span: 5, id: "cat-coef",
    });
    const SHORT: Record<string, string> = { hurricane: "Hurricane landfalls", convective: "Convective storms",
      flood: "Flood claims (NFIP)", wildfire: "Wildfire damage" };
    cc.onRedraw(coefChart({ card: cc, rows: terms.map((t) => ({ key: t.key, label: t.label, short: SHORT[t.key] ?? t.key,
      coef: t.coef as number, se: t.se as number, r: t.r })) }));
    cc.caption.textContent = "Indices enter as log(1 + x) so a few huge quarters do not dominate. "
      + (num(fit.billionR) ? `NOAA's billion-dollar disaster cost, which ends in 2024, correlates ${r2s(fit.billionR)} `
        + `with the shock over ${fit.billionN} quarters. ` : "")
      + "Correlation is not causation here: the shock is estimated from the carriers' loss ratios, so it also holds "
      + "reserve releases and large single losses.";
    cc.setTable(() => ({
      columns: ["Index", "Coefficient (σ per SD)", "Std. error", "t", "Correlation alone"],
      rows: terms.map((t) => [t.label, fmtSigma(t.coef), (t.se as number).toFixed(2), r2s(t.t),
        r2s(t.r)]),
      caption: "Regression of the industry shock on US peril indices",
    }));

    // ---------------------------------------------------------------- peril activity by year
    const ac = card(grid, {
      title: "Peril activity by year",
      sub: "What the agencies recorded each year; hover a year to find it in every chart on the page",
      span: 12, id: "cat-annual",
    });
    const minis = el("div", { class: "b-minis" });
    ac.body.append(minis);
    const catColors = ["var(--seq-2)", "var(--seq-3)", "var(--seq-5)", "var(--seq-6)", "var(--seq-8)"];
    const ace91 = mean(ace, Y, 1991, 2020);
    const panels: { title: string; unit: string; parts: AnnualPart[]; kind: "columns" | "line"; fmt: (v: number) => string;
      axisFmt?: (v: number) => string; ref?: { value: number; label: string }; legendParts?: boolean }[] = [
      { title: "US hurricane landfalls, by category", unit: "storms making US landfall as a hurricane (mainland and Puerto Rico)",
        kind: "columns", fmt: (v) => String(Math.round(v)), legendParts: true,
        parts: (["cat1", "cat2", "cat3", "cat4", "cat5"] as const).map((k, j) => ({ key: k, label: `Category ${j + 1}`,
          color: catColors[j], values: c.y[k] })) },
      { title: "Atlantic accumulated cyclone energy",
        unit: `ACE, 10⁴ kt², all Atlantic storms${ace91 ? `; dashed: 1991–2020 average (${ace91.toFixed(0)})` : ""}`,
        kind: "columns", fmt: (v) => v.toFixed(0), ref: ace91 ? { value: ace91, label: "" } : undefined,
        parts: [{ key: "ace", label: "ACE", color: "var(--s1)", values: ace }] },
      { title: "Tornadoes rated EF2 or stronger", unit: "per year (F-scale before 2007)", kind: "line",
        fmt: (v) => count(v), parts: [{ key: "sigTornadoes", label: "EF2+ tornadoes", color: "var(--s1)", values: c.y.sigTornadoes }] },
      { title: "Hail 2 inches or larger", unit: "reports per year", kind: "line", fmt: (v) => count(v),
        parts: [{ key: "sigHail", label: "Large-hail reports", color: "var(--s1)", values: c.y.sigHail }] },
      { title: "Acres burned by wildland fire", unit: "acres per year (NIFC)", kind: "columns",
        fmt: (v) => `${(v / 1e6).toFixed(1)}M`, axisFmt: (v) => (v === 0 ? "0" : `${(v / 1e6).toFixed(0)}M`),
        parts: [{ key: "wildfireAcres", label: "Acres burned", color: "var(--s1)", values: acres }] },
      { title: "NFIP flood claims paid", unit: "by year of loss, at today's prices", kind: "columns",
        fmt: (v) => money(v), axisFmt: (v) => (v === 0 ? "$0" : `$${(v / 1e9).toFixed(0)}B`),
        parts: [{ key: "nfipPaid", label: "Flood claims paid", color: "var(--s1)", values: c.y.nfipPaid }] },
      { title: "US earthquakes, magnitude 5+", unit: "per year, US states and territories (most in Alaska)", kind: "columns",
        fmt: (v) => count(v), parts: [{ key: "quakesM5", label: "M5+ earthquakes", color: "var(--s1)", values: c.y.quakesM5 }] },
    ];
    const redraws: (() => void)[] = [];
    for (const p of panels) {
      const chartHost = el("div", { class: "b-chart" });
      const box = el("div", { class: "b-mini" }, el("h4", { text: p.title }), el("p", { class: "b-unit", text: p.unit }));
      if (p.legendParts) {
        const lg = el("div", { class: "legend" });
        legend(lg, p.parts.map((x) => ({ label: x.label, color: x.color, shape: "box" as const })));
        box.append(lg);
      }
      box.append(chartHost);
      minis.append(box);
      redraws.push(annualMini({ host: chartHost, store, years: Y, parts: p.parts, kind: p.kind, fmt: p.fmt,
        axisFmt: p.axisFmt, label: `${p.title}, by year`, ref: p.ref, height: p.legendParts ? 132 : 150 }));
    }
    ac.onRedraw(() => redraws.forEach((r) => r()));
    const recent = [lastY - 9, lastY] as const;
    const early = [1996, 2005] as const;
    const cmp = (vals: Num[], fmt: (v: number) => string) => {
      const a = mean(vals, Y, ...recent);
      const b = mean(vals, Y, ...early);
      return a != null && b != null ? `${fmt(a)} a year in ${recent[0]}–${recent[1]} against ${fmt(b)} in ${early[0]}–${early[1]} (${signedPct(a, b)})` : "";
    };
    ac.caption.textContent = `Large hail: ${cmp(c.y.sigHail, (v) => count(v))}; part of any rise in reports reflects more `
      + `observers, not only more hail. EF2+ tornadoes: ${cmp(c.y.sigTornadoes, (v) => count(v))}. Acres burned: `
      + `${cmp(acres, (v) => `${(v / 1e6).toFixed(1)}M`)}. US hurricane landfalls: `
      + `${cmp(land, (v) => v.toFixed(1))}. Ten-year averages are short against year-to-year swings this large.`;
    ac.setTable(() => ({
      columns: ["Year", "US landfalls", "Cat 3+", "ACE", "EF2+ tornadoes", "Hail ≥2 in", "Acres burned", "NFIP paid", "M5+ quakes"],
      rows: Y.map((y, i) => [String(y), fmtN(c.y.landfalls[i]),
        fmtN(sum([c.y.cat3[i], c.y.cat4[i], c.y.cat5[i]])), fmtN(c.y.ace[i], 0), fmtN(c.y.sigTornadoes[i]),
        fmtN(c.y.sigHail[i]), num(acres[i]) ? count(acres[i]) : "–", num(c.y.nfipPaid[i]) ? money(c.y.nfipPaid[i]) : "–",
        fmtN(c.y.quakesM5[i])]).reverse(),
      caption: "Peril activity by year",
    }));

    // ---------------------------------------------------------------- where the losses land
    let metric = STATE_METRICS[0];
    const top2 = () => {
      const v = c.states.values[metric.key];
      return c.states.codes.map((_, i) => i).filter((i) => num(v[i])).sort((a, b) => (v[b] as number) - (v[a] as number)).slice(0, 2);
    };
    const mapTitle = () => {
      const t = top2();
      return t.length === 2 ? `${c.states.names[t[0]]} and ${c.states.names[t[1]]} lead: ${metric.short.toLowerCase()} since 2000`
        : `${metric.label} since 2000`;
    };
    const mc = card(grid, { title: mapTitle(), sub: "By state, 2000 to the latest data; dollars at today's prices",
      span: 7, id: "cat-map" });
    const sw = el("div", { class: "cat-switch" });
    mc.body.before(sw);
    const redrawMap = tileMap({ card: mc, label: "US states colored by the selected peril measure", codes: c.states.codes,
      names: c.states.names, getValues: () => c.states.values[metric.key], fmt: (v) => metric.fmt(v),
      metricLabel: () => metric.label,
      extraRows: (i) => STATE_METRICS.filter((m) => m.key !== metric.key).map((m) => ({
        name: m.short, value: num(c.states.values[m.key][i]) ? m.fmt(c.states.values[m.key][i] as number) : "–" })) });
    const ctl = segmented("Measure", STATE_METRICS.map((m) => ({ value: m.key, label: m.short })), metric.key, (v) => {
      metric = STATE_METRICS.find((m) => m.key === v) ?? metric;
      ctl.set(metric.key);
      mc.setTitle(mapTitle());
      redrawMap();
    });
    sw.append(ctl.root);
    mc.caption.textContent = "Tiles keep each state near its neighbors; color bins hold equal numbers of states. "
      + "Storm damage is NOAA Storm Events property damage, which under-records the largest hurricanes; flood claims are "
      + "National Flood Insurance Program payments by state of the insured property.";
    mc.setTable(() => ({
      columns: ["State", ...STATE_METRICS.map((m) => m.short)],
      rows: c.states.codes.map((_, i) => [c.states.names[i], ...STATE_METRICS.map((m) => {
        const v = c.states.values[m.key][i];
        return num(v) ? m.fmt(v) : "–";
      })]),
      caption: "Peril measures by state since 2000",
    }));

    if (c.nfipEvents.length) {
      const ev = c.nfipEvents.filter((e) => num(e.paid)).slice(0, 12);
      const ec = card(grid, {
        title: `${ev[0].name} still tops flood claims: ${money(ev[0].paid)} at today's prices`,
        sub: "Largest named flood events by NFIP claims paid since 2000, adjusted by CPI from the month of loss",
        span: 5, id: "cat-floods",
      });
      ec.onRedraw(barList({ card: ec, label: "Claims paid, today's prices", fmt: (v) => money(v),
        items: ev.map((e) => ({ key: e.name, label: e.name, value: e.paid as number,
          tip: [{ name: "Claims", value: count(e.claims) }, { name: "Most paid in", value: e.state ?? "–" }],
          note: `Losses from ${e.date.slice(0, 7)}` })) }));
      ec.caption.textContent = c.femaNote;
      ec.setTable(() => ({
        columns: ["Event", "First loss", "Claims", "Paid (today's prices)", "State with most paid"],
        rows: ev.map((e) => [e.name, e.date, count(e.claims), money(e.paid), e.state ?? "–"]),
        caption: "Largest NFIP flood events",
      }));
    }

    // ---------------------------------------------------------------- who carries it
    const scRows = (): SensRow[] => {
      const st = store.get();
      return c.companies.filter((x) => x.comparable && num(x.lam[0]) && num(x.lam[1]) && num(x.lam[2])
        && st.segments.includes(x.segment) && (st.historical || x.status === "active"))
        .map((x) => ({ cik: x.cik, ticker: x.ticker, name: x.name, segment: SEGMENT_SHORT[x.segment] ?? x.segment,
          mean: x.lam[0] as number, lo: x.lam[1] as number, hi: x.lam[2] as number }));
    };
    const big = fit.largest[0];
    const sensTitle = () => {
      const r = scRows().sort((a, b) => b.mean - a.mean);
      return r.length ? `${r[0].name} carries the most catastrophe risk: ${pts(r[0].mean)} of loss ratio per 1σ shock`
        : "Catastrophe sensitivity by carrier";
    };
    const kc = card(grid, { title: sensTitle(), sub: "How far each carrier's loss ratio moves with the industry shock: "
      + "posterior mean and 89% interval from the loss model", span: 7, id: "cat-sens" });
    const redrawSens = sensChart({ card: kc, store, getRows: scRows, fmt: (v) => pts(v),
      shock: big && num(big.f) ? { sigma: big.f as number, label: `${quarterLabel(big.q)}-sized` } : null });
    kc.onRedraw(redrawSens);
    const sensCaption = () => {
      const r = scRows().map((x) => x.mean).sort((a, b) => a - b);
      const med = r.length ? r[Math.floor(r.length / 2)] : null;
      kc.caption.textContent = med != null && big && num(big.f)
        ? `The median carrier shown moves ${pts(med)} per 1σ; in a quarter like ${quarterLabel(big.q)} `
          + `(${EVENTS[big.q] ?? "the largest"}, ${fmtSigma(big.f)}) that is about ${pts(med * (big.f as number))} of `
          + "loss ratio. Bermuda reinsurers sit at the top because property catastrophe reinsurance is their core "
          + "business. Click a carrier to focus the page on it; the segment and history filters above apply."
        : "";
    };
    sensCaption();
    store.on(["segments", "historical", "selected"], () => {
      kc.setTitle(sensTitle());
      sensCaption();
      if (!kc.showingTable()) redrawSens();
    });
    kc.setTable(() => ({
      columns: ["Carrier", "Segment", "Points per 1σ (mean)", "89% low", "89% high"],
      rows: scRows().sort((a, b) => b.mean - a.mean).map((x) => [`${x.name} (${x.ticker})`, x.segment, pts(x.mean),
        pts(x.lo), pts(x.hi)]),
      caption: "Catastrophe sensitivity by carrier",
    }));

    // ENSO and the carriers' own reports share the column beside the sensitivity ranking
    const stack = el("div", { class: "span-5 cat-stack" });
    grid.append(stack);
    // ---------------------------------------------------------------- ENSO and the Atlantic season
    const pointsE: EnsoPoint[] = Y.map((y, i) => ({ year: y, oni: c.y.oniAso[i] as number, ace: ace[i] as number,
      landfalls: num(land[i]) ? (land[i] as number) : null })).filter((p) => num(p.oni) && num(p.ace));
    if (pointsE.length > 10) {
      const n = pointsE.length;
      const mx = pointsE.reduce((s, p) => s + p.oni, 0) / n;
      const my = pointsE.reduce((s, p) => s + p.ace, 0) / n;
      const sxy = pointsE.reduce((s, p) => s + (p.oni - mx) * (p.ace - my), 0);
      const sxx = pointsE.reduce((s, p) => s + (p.oni - mx) ** 2, 0);
      const syy = pointsE.reduce((s, p) => s + (p.ace - my) ** 2, 0);
      const r = sxy / Math.sqrt(sxx * syy);
      const slope = sxy / sxx;
      const nino = pointsE.filter((p) => p.oni >= 0.5);
      const nina = pointsE.filter((p) => p.oni <= -0.5);
      const avg = (ps: EnsoPoint[]) => ps.reduce((s, p) => s + p.ace, 0) / Math.max(1, ps.length);
      // the latest Aug-Oct reading, even for a season HURDAT2 does not cover yet
      const la = c.oni.latestAso;
      const nowYear = la && num(la.anom) ? la.year : null;
      const now = la && num(la.anom) ? { oni: la.anom, label: `${la.year}: ${signedC(la.anom)}` } : null;
      const ec2 = card(stack, {
        title: r < -0.2 ? `La Niña seasons run hotter: r = ${r2s(r)} between ENSO and Atlantic energy`
          : `ENSO and Atlantic season energy: r = ${r2s(r)}`,
        sub: `Each Atlantic season since ${pointsE[0].year}: accumulated cyclone energy against the Aug–Oct Oceanic Niño Index`,
        span: 5, id: "cat-enso",
      });
      legend(ec2.legend, [{ label: "Season", color: "var(--s1)", shape: "dot" }, { label: "Least-squares line", color: "var(--s2)" }]);
      ec2.onRedraw(ensoChart({ card: ec2, store, points: pointsE, slope, intercept: my - slope * mx, now }));
      const higher = now ? pointsE.filter((p) => p.oni >= now!.oni).length : 0;
      ec2.caption.textContent = `El Niño seasons (ONI ≥ +0.5) averaged ${avg(nino).toFixed(0)} ACE against `
        + `${avg(nina).toFixed(0)} in La Niña seasons (ONI ≤ −0.5), ${nino.length} and ${nina.length} seasons. `
        + (now && nowYear != null ? `The Aug–Oct ${nowYear} reading, ${signedC(now.oni)} (${oniLabel(now.oni)}), `
          + (higher === 0 ? `is the highest Aug–Oct reading since at least ${pointsE[0].year}. `
            : `is matched or exceeded in ${higher} earlier Aug–Oct readings. `)
          + (nowYear > lastY ? `HURDAT2 does not hold the ${nowYear} season yet. ` : "") : "")
        + "A forecasting signal, not a guarantee: one strong storm can make a quiet season expensive.";
      ec2.setTable(() => ({
        columns: ["Season", "ONI Aug–Oct", "ACE", "US hurricane landfalls"],
        rows: [...pointsE].reverse().map((p) => [String(p.year), signedC(p.oni), p.ace.toFixed(0), p.landfalls == null ? "–" : String(p.landfalls)]),
        caption: "ENSO and Atlantic season energy",
      }));
    }

    // ---------------------------------------------------------------- what carriers report
    const rc = card(stack, { title: "Reported catastrophe losses against the model", span: 5, id: "cat-reported",
      sub: "Each carrier's catastrophe losses as a share of the quarter's premiums, from its earnings releases, "
        + "against the model's catastrophe component (λ × industry shock)" });
    const rep = c.reported;
    const drawReported = () => {
      rc.body.replaceChildren();
      rc.legend.replaceChildren();
      const sel = store.get().selected;
      const s = rep.series[String(sel)];
      const name = data.byCik.get(sel)?.name ?? "this carrier";
      if (!rep.available) {
        rc.body.append(el("div", { class: "cat-pending" },
          el("p", { text: "Company-reported catastrophe losses appear here once the filing documents are downloaded. "
            + "SEC serves earnings releases only to clients that declare a contact, so this step runs separately." }),
          el("p", {}, "Pipeline: ", el("code", { text: "python -m sil ingest secdocs" }), " then ",
            el("code", { text: "python -m sil domains catastrophe" }), "."),
          el("p", { text: "The extractor reads each quarter's catastrophe-loss figure from the release text and tables, keeps "
            + "the sentence it came from, and rejects figures above the quarter's premiums or total incurred losses." })));
        rc.caption.textContent = "";
        return;
      }
      if (!s) {
        const have = Object.keys(rep.series).map((k) => data.byCik.get(Number(k))?.ticker).filter(Boolean).join(", ");
        rc.body.append(el("p", { class: "empty", text: `No catastrophe losses were found in ${name}'s releases. Carriers with data: ${have}.` }));
        return;
      }
      legend(rc.legend, [{ label: `${name}: reported, share of premiums`, color: "var(--s1)" },
        { label: "Model: λ × industry shock", color: "var(--s2)" }]);
      reportedChart({ card: rc, store, quarters: s.q, ratio: s.ratio, usd: s.usd, model: s.model, basis: s.basis });
      const v = rep.validation;
      const mine = v?.perCompany.find((p) => p.cik === sel);
      rc.caption.textContent = `${rep.companyQuarters} carrier-quarters extracted from ${rep.documentsListed} release documents. `
        + (v ? `Across carriers, the model's catastrophe component and the reported share correlate ${r2s(v.pooledR)} `
          + `(${v.n} carrier-quarters)` + (mine ? `; for ${name}, ${r2s(mine.r)} over ${mine.n} quarters. ` : ". ") : "")
        + "The model line is a deviation from an average quarter, so compare the swings, not the level.";
    };
    drawReported();
    rc.onRedraw(drawReported);
    store.on(["selected"], () => { if (!rc.showingTable()) drawReported(); });
    rc.setTable(() => {
      const s = rep.series[String(store.get().selected)];
      return {
        columns: ["Quarter", "Reported ($)", "Share of premiums", "Model λ × shock", "Basis"],
        rows: s ? s.q.map((q, i) => [quarterLabel(q), money(s.usd[i]), level(s.ratio[i]),
          s.model && num(s.model[i]) ? pts(s.model[i]) : "–", s.basis[i]]).reverse() : [],
        caption: "Reported catastrophe losses",
      };
    });

    host.append(el("p", { class: "cat-fema", text: `${c.femaNote} Sources: `
      + c.sources.map((s) => `${s.name} (${s.coverage}${s.retrieved ? `, retrieved ${s.retrieved}` : ""})`).join("; ") + "." }));
  },
};

function fmtN(v: Num, digits = 0): string {
  return v == null || !Number.isFinite(v) ? "–" : v.toFixed(digits);
}

function sum(values: Num[]): Num {
  return values.some((v) => v == null) ? null : values.reduce((s: number, v) => s + (v as number), 0);
}
