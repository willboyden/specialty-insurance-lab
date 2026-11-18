// Claims and reserves: the loss-reserve roll-forward every carrier tags in its 10-Qs and 10-Ks, read as a set of
// linked views. The selected company, hovered carrier and time crosshair are shared with the rest of the page; a
// click on a year in the development bars or the heatmap sets the fiscal year the other views here read.
import "./claims.css";
import type { AppData, Company, Num } from "../types";
import type { Store } from "../state";
import type { ClaimsData, ClaimsLine, ClaimsMetricKey } from "../domains/claims";
import { card, el, legend, segmented, selectControl, tiles, type Tile } from "../ui";
import { SEGMENT_ORDER, SEGMENT_SHORT, displayName, median, visibleCompanies } from "../data";
import { lineChart } from "../charts/lines";
import { claimsRank } from "../charts/claims-rank";
import { devBars } from "../charts/claims-devbars";
import { waterfall, type WaterStep } from "../charts/claims-waterfall";
import { claimsScatter } from "../charts/claims-scatter";
import { yearHeat } from "../charts/claims-heat";
import { ageToAge, ayColumns, developmentVsFirst, latestOf, payoutChart, triangleHeat } from "../charts/claims-triangle";
import { count, money, num, pct, pts, quarterLabel, signedPct, times } from "../format";

interface ClaimMetric {
  key: ClaimsMetricKey;
  label: string;
  fmt: (v: number) => string;
  better: "lower" | "higher" | "neutral";
  help: string;
  scale: { center?: number; span?: number; goodLow?: boolean };
}

const yrs = (v: number) => `${num(v, 1)} yrs`;

export const CLAIM_METRICS: ClaimMetric[] = [
  {
    key: "dev_pct_open", label: "Reserve development", fmt: (v) => signedPct(v, 1), better: "lower",
    help: "The change during the year in the estimate of prior accident years' claims, as a share of the reserves held at its "
      + "start. Negative is favorable: reserves were released.",
    scale: { center: 0, span: 0.1, goodLow: true },
  },
  {
    key: "survival", label: "Survival ratio", fmt: yrs, better: "neutral",
    help: "Net loss reserves divided by one year of paid claims: how many years of payments the reserves hold, the length "
      + "of the tail. Long-tail casualty books run high, property and personal auto low.",
    scale: {},
  },
  {
    key: "reserve_leverage", label: "Reserves to equity", fmt: (v) => times(v, 2), better: "neutral",
    help: "Net loss reserves per dollar of shareholders' equity: a 10% reserve shortfall would cost this many times 10% of equity.",
    scale: {},
  },
  {
    key: "paid_to_incurred", label: "Paid to incurred", fmt: (v) => pct(v, 0), better: "neutral",
    help: "Claims paid during the year over losses incurred. Below 100% reserves grow (a growing or lengthening book); above "
      + "100% the book is running off.",
    scale: {},
  },
  {
    key: "first_year_payout", label: "First-year payout", fmt: (v) => pct(v, 0), better: "neutral",
    help: "The share of the current accident year's incurred losses already paid by the end of the year: how quickly new "
      + "claims are settled.",
    scale: {},
  },
  {
    key: "runoff_speed", label: "Run-off speed", fmt: (v) => pct(v, 0), better: "neutral",
    help: "Payments on prior accident years as a share of the reserves held at the start of the year.",
    scale: {},
  },
  {
    key: "paid_lr", label: "Paid loss ratio", fmt: (v) => pct(v), better: "lower",
    help: "Claims and claim expenses paid per dollar of net premium earned.",
    scale: {},
  },
  {
    key: "incurred_lr", label: "Incurred loss ratio", fmt: (v) => pct(v), better: "lower",
    help: "Losses and loss-adjustment expenses incurred per dollar of net premium earned (the loss ratio, fiscal year).",
    scale: {},
  },
  {
    key: "reserve_to_npe", label: "Reserves to premium", fmt: (v) => times(v, 2), better: "neutral",
    help: "Net loss reserves over a year of net premium earned.",
    scale: {},
  },
  {
    key: "ceded_share", label: "Reinsured share of reserves", fmt: (v) => pct(v, 0), better: "neutral",
    help: "Reinsurance recoverable on unpaid claims over gross reserves (or 1 − net/gross): how much of the claims "
      + "liability reinsurers carry.",
    scale: {},
  },
  {
    key: "pyd_ratio", label: "Development, points of premium", fmt: (v) => pts(v), better: "lower",
    help: "Prior-year development as points of the year's net premium earned (negative = favorable).",
    scale: { center: 0, span: 0.1, goodLow: true },
  },
  {
    key: "reserve_growth", label: "Reserve growth", fmt: (v) => signedPct(v, 0), better: "neutral",
    help: "Closing over opening net loss reserves.",
    scale: {},
  },
];
const METRIC_BY_KEY = new Map(CLAIM_METRICS.map((m) => [m.key, m]));

export const claimsSection = {
  id: "claims",
  nav: "Claims",
  title: "Claims and reserves",
  intro: (d: AppData): string => {
    const c = d.claims?.coverage;
    if (!c || !c.companies) return "Loss reserves: what each carrier pays, how its estimates of past years move, and how long its claims take to settle.";
    return "Loss reserves are a carrier's largest liability and its largest estimate. From the reserve roll-forward every "
      + `P&C filer tags in its 10-Qs and 10-Ks (${count(c.companyYears)} company-years, ${c.companies} carriers, fiscal `
      + `${c.firstYear}–${c.lastYear}): what each pays, how its estimates of past years move, and how long its claims take to settle.`;
  },
  mount: mountClaims,
};

function mountClaims(host: HTMLElement, data: AppData, store: Store): void {
  const cd = data.claims;
  if (!cd || !Object.keys(cd.companies).length) {
    host.append(el("p", { class: "empty", text: "The claims data set is not part of this build." }));
    return;
  }
  const years = cd.years;
  const nY = years.length;
  const yIdx = (y: number) => years.indexOf(y);
  const val = (cik: number, key: string, i: number): Num => {
    const arr = cd.companies[String(cik)]?.y[key as ClaimsMetricKey];
    return arr && i >= 0 ? (arr[i] ?? null) : null;
  };
  const row = (cik: number, key: string): Num[] => years.map((_, i) => val(cik, key, i));
  const segMedian = (seg: string, key: ClaimsMetricKey): Num[] => cd.segmentMedians[seg]?.[key] ?? years.map(() => null);
  const company = (): Company => data.byCik.get(store.get().selected) ?? data.companies[0];
  const hasData = (c: Company) => Boolean(cd.companies[String(c.cik)]);

  // the default fiscal year: the latest with paid losses for at least 60% as many carriers as the best year
  const cov = years.map((_, i) => Object.values(cd.companies).filter((c) => c.y.paid?.[i] != null).length);
  const best = Math.max(...cov);
  let year = years[nY - 1];
  for (let i = nY - 1; i >= 0; i--) if (cov[i] >= best * 0.6) { year = years[i]; break; }
  let metricKey: ClaimsMetricKey = "dev_pct_open";
  const metric = () => METRIC_BY_KEY.get(metricKey)!;
  const peers = (): Company[] => visibleCompanies(data, store.get().segments, store.get().historical).filter(hasData);

  // ---------------------------------------------------------------- the section's own filter row
  const metricCtl = selectControl("Metric (ranking and heatmap)", CLAIM_METRICS.map((m) => ({ value: m.key, label: m.label })),
    metricKey, (v) => { metricKey = v as ClaimsMetricKey; onMetric(); }, "ctl-claims-metric");
  const yearCtl = selectControl("Fiscal year", [...years].reverse().map((y) => ({ value: String(y), label: String(y) })),
    String(year), (v) => setYear(Number(v)), "ctl-claims-year");
  const help = el("p", { class: "sub claims-help", text: metric().help });
  host.append(el("div", { class: "controls" }, metricCtl.root, yearCtl.root), help);
  const tileHost = el("div", { class: "claims-tiles" });
  host.append(tileHost);
  const grid = el("div", { class: "grid" });
  host.append(grid);

  // ---------------------------------------------------------------- tiles: the selected company in the chosen year
  const renderTiles = () => {
    const c = company();
    const i = yIdx(year);
    if (!hasData(c)) {
      tileHost.replaceChildren(el("p", { class: "note", text: `${displayName(c)} has no loss-reserve roll-forward tagged in its XBRL filings.` }));
      return;
    }
    const segMed = (k: ClaimsMetricKey) => segMedian(c.segment, k)[i];
    const vs = (k: ClaimsMetricKey, f: (v: number) => string) => {
      const m = segMed(k);
      return m == null ? undefined : `segment median ${f(m)}`;
    };
    const dev = val(c.cik, "dev_pct_open", i);
    const list: Tile[] = [
      { label: `Net loss reserves, end of fiscal ${year}`, value: money(val(c.cik, "net_reserves", i)) },
      { label: "Reserve development", value: dev == null ? "–" : signedPct(dev, 1),
        delta: dev == null ? undefined : `${dev < 0 ? "favorable" : dev > 0 ? "adverse" : "none"} · ${vs("dev_pct_open", (v) => signedPct(v, 1)) ?? ""}`,
        tone: dev == null ? "" : dev < 0 ? "down-good" : dev > 0 ? "up-bad" : "", title: METRIC_BY_KEY.get("dev_pct_open")!.help },
      { label: "Survival ratio", value: (() => { const v = val(c.cik, "survival", i); return v == null ? "–" : yrs(v); })(),
        delta: vs("survival", yrs), title: METRIC_BY_KEY.get("survival")!.help },
      { label: "Reserves to equity", value: times(val(c.cik, "reserve_leverage", i)), delta: vs("reserve_leverage", (v) => times(v)),
        title: METRIC_BY_KEY.get("reserve_leverage")!.help },
      { label: "Paid to incurred", value: pct(val(c.cik, "paid_to_incurred", i), 0), delta: vs("paid_to_incurred", (v) => pct(v, 0)),
        title: METRIC_BY_KEY.get("paid_to_incurred")!.help },
      { label: "First-year payout", value: pct(val(c.cik, "first_year_payout", i), 0), delta: vs("first_year_payout", (v) => pct(v, 0)),
        title: METRIC_BY_KEY.get("first_year_payout")!.help },
    ];
    tiles(tileHost, list);
  };

  // ---------------------------------------------------------------- development history (selected company)
  const devCard = card(grid, { title: "", span: 7, id: "claims-dev" });
  legend(devCard.legend, [
    { label: "Favorable (reserves released)", color: "var(--div-neg)", shape: "box" },
    { label: "Adverse (reserves strengthened)", color: "var(--div-pos)", shape: "box" },
    { label: "Segment median", color: "var(--s2)" },
  ]);
  const dev = devBars({
    card: devCard, label: "Prior-year reserve development by fiscal year", years,
    getValues: () => row(company().cik, "dev_pct_open"),
    getMedian: () => segMedian(company().segment, "dev_pct_open"),
    getYear: () => year, onYear: (y) => setYear(y),
    fmt: (v) => signedPct(v, 1), axisFmt: (v) => signedPct(v, 0),
    names: () => ({ value: company().ticker, median: `${SEGMENT_SHORT[company().segment] ?? company().segment} median` }),
    extraRows: (i) => {
      const c = company();
      const d = val(c.cik, "py_development", i);
      const open = val(c.cik, "net_reserves_open", i);
      return [
        { name: "Development, dollars", value: d == null ? "–" : `${d >= 0 ? "+" : "−"}${money(Math.abs(d))}` },
        { name: "Opening net reserves", value: money(open) },
      ];
    },
    height: (w) => (w < 600 ? 240 : 290),
  });
  const devChrome = () => {
    const c = company();
    devCard.setTitle(`${c.ticker}: how its estimates of past years moved`, "Prior-year development as a share of opening reserves, each fiscal year · click a year to read it below");
    const v = row(c.cik, "dev_pct_open");
    const present = years.map((y, i) => ({ y, v: v[i] })).filter((d): d is { y: number; v: number } => d.v != null);
    if (!present.length) {
      devCard.caption.textContent = `${c.ticker} does not tag prior-year development and opening reserves together in its filings.`;
    } else {
      const fav = present.filter((d) => d.v < 0).length;
      const adverse = present.filter((d) => d.v > 0).sort((a, b) => b.v - a.v);
      const med = median(present.map((d) => d.v));
      const segM = median(segMedian(c.segment, "dev_pct_open").filter((x, i) => x != null && v[i] != null) as number[]);
      devCard.caption.textContent = `${c.ticker}'s estimates for prior accident years fell in ${fav} of ${present.length} fiscal years `
        + `(${present[0].y}–${present[present.length - 1].y}), by a median ${signedPct(med, 1)} of opening reserves a year`
        + (segM != null ? `; the ${SEGMENT_SHORT[c.segment] ?? c.segment} median over the same years: ${Math.abs(segM) < 0.0005 ? "about zero" : signedPct(segM, 1)}.` : ".")
        + (adverse.length ? ` Adverse years: ${adverse.slice(0, 4).map((d) => `${d.y} (${signedPct(d.v, 1)})`).join(", ")}${adverse.length > 4 ? ", …" : ""}.` : "");
    }
    devCard.setTable(() => ({
      columns: ["Fiscal year", "Development, % of opening", "Development, $", "Opening net reserves", "Segment median"],
      rows: years.map((y, i) => [String(y), v[i] == null ? "–" : signedPct(v[i] as number, 1),
        (() => { const d = val(c.cik, "py_development", i); return d == null ? "–" : `${d >= 0 ? "+" : "−"}${money(Math.abs(d))}`; })(),
        money(val(c.cik, "net_reserves_open", i)), (() => { const m = segMedian(c.segment, "dev_pct_open")[i]; return m == null ? "–" : signedPct(m, 1); })()])
        .filter((r) => r.slice(1).some((x) => x !== "–")),
    }));
  };

  // ---------------------------------------------------------------- roll-forward waterfall (selected company, chosen year)
  const wfCard = card(grid, { title: "", span: 5, id: "claims-rollforward" });
  legend(wfCard.legend, [
    { label: "Net loss reserves", color: "var(--context-strong)", shape: "box" },
    { label: "Losses incurred and claims paid", color: "var(--s3)", shape: "box" },
    { label: "Favorable / adverse development", color: "var(--div-neg)", shape: "box" },
  ]);
  const wfSwatch = wfCard.legend.querySelectorAll<HTMLElement>(".swatch-box")[2];
  if (wfSwatch) wfSwatch.style.background = "linear-gradient(90deg, var(--div-neg) 50%, var(--div-pos) 50%)";
  const steps = (): { list: WaterStep[]; other: number | null; open: number | null } => {
    const c = company();
    const i = yIdx(year);
    const g = (k: string) => val(c.cik, k, i);
    const open = g("net_reserves_open");
    const close = g("net_reserves");
    if (open == null || close == null) return { list: [], other: null, open };
    const list: WaterStep[] = [{ label: `Opening, ${year - 1}`, short: `Open ${year - 1}`, value: open, kind: "total" }];
    let level = open;
    const add = (label: string, short: string, v: Num, kind: WaterStep["kind"], note?: string) => {
      if (v == null || v === 0) return;
      list.push({ label, short, value: v, kind, note });
      level += v;
    };
    const cy = g("cy_losses");
    const py = g("py_development");
    if (cy != null && py != null) {
      add("Incurred, this year's claims", "Incurred, new", cy, "flow", "Losses and LAE incurred for the current accident year");
      add("Development, past years", "Development", py, "dev", "Change in the estimate of prior accident years (negative = favorable)");
    } else {
      add("Losses incurred", "Incurred", g("losses"), "flow", "Losses and LAE incurred (current and prior accident years)");
    }
    const pc = g("paid_cy");
    const pp = g("paid_py");
    if (pc != null && pp != null) {
      add("Paid, this year's claims", "Paid, new", -pc, "flow");
      add("Paid, past years' claims", "Paid, old", -pp, "flow");
    } else {
      add("Claims paid", "Paid", g("paid") == null ? null : -(g("paid") as number), "flow");
    }
    add("Acquired (sold)", "Acquired", g("acquired"), "flow", "Reserves assumed in acquisitions (negative: sold or transferred)");
    const other = close - level;
    if (Math.abs(other) > 0.005 * Math.abs(open)) {
      add("FX and other", "FX, other", other, "flow", "What the roll-forward as tagged does not split out: currency, commutations, retroactive reinsurance");
    }
    list.push({ label: `Closing, ${year}`, short: `Close ${year}`, value: close, kind: "total" });
    return { list, other: Math.abs(other) > 0.005 * Math.abs(open) ? other : 0, open };
  };
  const wf = waterfall({
    card: wfCard, label: "Loss-reserve roll-forward for the chosen fiscal year", fmt: money,
    getSteps: () => steps().list, title: () => `${company().ticker}, fiscal ${year}`,
  });
  const wfChrome = () => {
    const c = company();
    const i = yIdx(year);
    wfCard.setTitle(`${c.ticker}: where its reserves went in fiscal ${year}`, "Net loss reserves from the opening to the closing balance");
    const s = steps();
    if (!s.list.length) {
      wfCard.caption.textContent = `No opening and closing net reserves tagged for ${c.ticker} in fiscal ${year}. Pick another year above.`;
    } else {
      const growth = val(c.cik, "reserve_growth", i);
      const p2i = val(c.cik, "paid_to_incurred", i);
      wfCard.caption.textContent = (growth != null ? `Reserves ${growth >= 0 ? "grew" : "fell"} ${pct(Math.abs(growth), 0)} in fiscal ${year}` : `Fiscal ${year}`)
        + (p2i != null ? `: ${c.ticker} paid ${pct(p2i, 0)} of what it incurred.` : ".")
        + (s.other && s.open && Math.abs(s.other / s.open) > 0.02
          ? ` ${pct(Math.abs(s.other / s.open), 0)} of opening reserves moved through items the tagged roll-forward does not split out.` : "");
    }
    wfCard.setTable(() => ({ columns: ["Step", "Amount"], rows: s.list.map((d) => [d.label, d.kind === "total" ? money(d.value) : `${d.value >= 0 ? "+" : "−"}${money(Math.abs(d.value))}`]) }));
  };

  // ---------------------------------------------------------------- paid vs incurred over time (selected company)
  const lnCard = card(grid, { title: "", span: 7, id: "claims-paid-incurred" });
  legend(lnCard.legend, [
    { label: "Incurred loss ratio", color: "var(--s1)" },
    { label: "Paid loss ratio", color: "var(--s2)" },
  ]);
  const quarterly = () => cd.quarterly[String(company().cik)];
  const lines = lineChart({
    card: lnCard, store, quarters: cd.quarters, height: (w) => (w < 600 ? 250 : 300), label: "Paid and incurred loss ratios over time",
    fmt: (v) => pct(v), getFrom: () => {
      const q = quarterly();
      const first = q ? cd.quarters.find((_, i) => q.paid[i] != null || q.incurred[i] != null) ?? cd.quarters[0] : cd.quarters[0];
      return store.get().from > first ? store.get().from : first;
    }, clipQuantiles: [0, 1],
    getSeries: () => {
      const q = quarterly();
      if (!q) return [];
      return [
        { id: "inc", label: "Incurred", values: q.incurred, role: "ref", color: "var(--s1)" },
        { id: "paid", label: "Paid", values: q.paid, role: "ref", color: "var(--s2)" },
      ];
    },
  });
  const lnChrome = () => {
    const c = company();
    lnCard.setTitle(`${c.ticker}: paid against incurred losses`, "Trailing four quarters, per dollar of net premium earned · the gap is what went into reserves");
    const q = quarterly();
    if (!q) {
      lnCard.caption.textContent = `${c.ticker} does not tag quarterly paid losses.`;
      lnCard.setTable(() => ({ columns: ["Quarter"], rows: [] }));
      return;
    }
    const idx = cd.quarters.map((_, i) => i).filter((i) => q.paid[i] != null && q.incurred[i] != null).slice(-12);
    const ratio = idx.length ? idx.reduce((a, i) => a + (q.paid[i] as number), 0) / idx.reduce((a, i) => a + (q.incurred[i] as number), 0) : null;
    lnCard.caption.textContent = ratio == null ? "" : `Over the last ${idx.length} quarters on record ${c.ticker} paid ${pct(ratio, 0)} of the losses it incurred`
      + (ratio < 0.95 ? ": reserves were building." : ratio > 1.05 ? ": the book was running off." : ".")
      + " A gap is normal for a growing or long-tail book; it is the evidence behind a reserve, not a verdict on it.";
    lnCard.setTable(() => ({
      columns: ["Quarter", "Incurred LR (TTM)", "Paid LR (TTM)"],
      rows: cd.quarters.map((qq, i) => [quarterLabel(qq), pct(q.incurred[i]), pct(q.paid[i])]).filter((r) => r[1] !== "–" || r[2] !== "–").slice(-16),
    }));
  };

  // ---------------------------------------------------------------- peer ranking (chosen metric and year)
  const rkCard = card(grid, { title: "", span: 5, id: "claims-rank" });
  const rank = claimsRank({
    card: rkCard, store, label: "Peer ranking for the chosen metric and year", fmt: (v) => metric().fmt(v),
    metricName: () => `${metric().label}, fiscal ${year}`, ascending: () => metric().better !== "higher",
    getItems: () => {
      const i = yIdx(year);
      return peers().map((c) => ({
        id: c.cik, label: c.ticker, name: displayName(c), value: val(c.cik, metric().key, i) as number,
        note: c.cohort === "benchmark" ? "Standard-lines benchmark" : SEGMENT_SHORT[c.segment],
      })).filter((d) => d.value != null);
    },
  });
  const rkChrome = () => {
    const m = metric();
    const c = company();
    const i = yIdx(year);
    const items = peers().map((p) => ({ p, v: val(p.cik, m.key, i) })).filter((d): d is { p: Company; v: number } => d.v != null)
      .sort((a, b) => a.v - b.v);
    rkCard.setTitle(`${m.label}, fiscal ${year}`, `${items.length} carriers · ${m.better === "higher" ? "highest" : "lowest"} first · hover to find, click to focus`);
    const med = median(items.map((d) => d.v));
    const pos = items.findIndex((d) => d.p.cik === c.cik);
    rkCard.caption.textContent = items.length
      ? `Median ${m.fmt(med as number)}.` + (pos >= 0 ? ` ${c.ticker}: ${m.fmt(items[pos].v)}, ${ordinal(pos + 1)} of ${items.length}.` : ` ${c.ticker} has no value for fiscal ${year}.`)
      : `No carrier in the filter tags this for fiscal ${year}.`;
    rkCard.setTable(() => ({ columns: ["Company", m.label], rows: items.map((d) => [displayName(d.p), m.fmt(d.v)]) }));
  };

  // ---------------------------------------------------------------- tail length vs balance-sheet exposure
  const scCard = card(grid, { title: "Tail length against balance-sheet exposure", span: 6, id: "claims-tail" });
  const scLegend = () => {
    legend(scCard.legend, [
      { label: displayName(company()), color: "var(--s1)", shape: "dot" },
      { label: "Specialty carriers", color: "var(--context-strong)", shape: "dot" },
      { label: "Standard-lines benchmark (ring)", color: "transparent", shape: "dot" },
    ]);
    const ring = scCard.legend.querySelectorAll<HTMLElement>(".swatch-dot")[2];
    if (ring) ring.style.boxShadow = "inset 0 0 0 2px var(--context-strong)";
  };
  const tailPoints = () => {
    const i = yIdx(year);
    return peers().map((c) => ({
      id: c.cik, label: displayName(c), ticker: c.ticker, ring: c.cohort === "benchmark",
      x: val(c.cik, "survival", i) as number, y: val(c.cik, "reserve_leverage", i) as number,
      size: (val(c.cik, "net_reserves", i) as number) ?? 0,
      rows: [{ name: "Net loss reserves", value: money(val(c.cik, "net_reserves", i)) }],
    })).filter((p) => p.x != null && p.y != null);
  };
  const tail = claimsScatter({
    card: scCard, store, label: "Survival ratio against reserves to equity", xLabel: "Survival ratio (years of paid claims)",
    yLabel: "Reserves to equity", xFmt: (v) => `${num(v, v < 10 ? 1 : 0)}`, yFmt: (v) => times(v, 1), watermark: () => `FY ${year}`,
    getPoints: tailPoints,
  });
  const scChrome = () => {
    scLegend();
    scCard.setTitle("Tail length against balance-sheet exposure", `Each dot a carrier, sized by net loss reserves · fiscal ${year}`);
    const pts = tailPoints();
    const lev = pts.filter((p) => p.y >= 2).sort((a, b) => b.y - a.y);
    const longest = [...pts].sort((a, b) => b.x - a.x).slice(0, 3);
    scCard.caption.textContent = pts.length
      ? (lev.length ? `Reserves above twice equity: ${lev.slice(0, 5).map((p) => `${p.ticker} (${times(p.y, 1)})`).join(", ")}. ` : "No carrier held reserves above twice its equity. ")
        + `Longest tails: ${longest.map((p) => `${p.ticker} (${yrs(p.x)})`).join(", ")}. A long tail leaves more time for estimates to move; leverage sets what a move costs.`
      : "";
    scCard.setTable(() => ({
      columns: ["Company", "Survival ratio", "Reserves to equity", "Net loss reserves"],
      rows: pts.sort((a, b) => b.y - a.y).map((p) => [p.label, yrs(p.x), times(p.y, 2), money(p.size)]),
    }));
  };

  // ---------------------------------------------------------------- growth vs paid-to-incurred
  const grCard = card(grid, { title: "", span: 6, id: "claims-growth" });
  const growth = (cik: number, i: number): Num => {
    const a = val(cik, "npe", i);
    const b = val(cik, "npe", i - 1);
    return a != null && b != null && b > 0 ? a / b - 1 : null;
  };
  const growthPoints = () => {
    const i = yIdx(year);
    return peers().map((c) => ({
      id: c.cik, label: displayName(c), ticker: c.ticker, ring: c.cohort === "benchmark",
      x: growth(c.cik, i) as number, y: val(c.cik, "paid_to_incurred", i) as number, size: (val(c.cik, "npe", i) as number) ?? 0,
      rows: [{ name: "Net premiums earned", value: money(val(c.cik, "npe", i)) }],
    })).filter((p) => p.x != null && p.y != null && p.x > -0.6 && p.x < 2);
  };
  const gr = claimsScatter({
    card: grCard, store, label: "Premium growth against paid-to-incurred", xLabel: "Premium growth, fiscal year",
    yLabel: "Paid to incurred", xFmt: (v) => pct(v, 0), yFmt: (v) => pct(v, 0), watermark: () => `FY ${year}`,
    getPoints: growthPoints,
  });
  const grChrome = () => {
    legend(grCard.legend, [
      { label: displayName(company()), color: "var(--s1)", shape: "dot" },
      { label: "Other carriers (sized by premium)", color: "var(--context-strong)", shape: "dot" },
    ]);
    grCard.setTitle("Why growing books pay out less than they incur", `Premium growth against paid-to-incurred · fiscal ${year}`);
    const pts = growthPoints();
    const r = pearson(pts.map((p) => p.x), pts.map((p) => p.y));
    grCard.caption.textContent = pts.length < 6 || r == null ? "" : Math.abs(r) >= 0.3
      ? `Across ${pts.length} carriers in fiscal ${year}, faster premium growth went with ${r < 0 ? "a lower" : "a higher"} paid-to-incurred ratio (correlation ${signed(r)}): `
        + "new business is incurred at once but paid over years, so a growing book builds reserves without any change in reserving."
      : `Across ${pts.length} carriers in fiscal ${year}, premium growth and paid-to-incurred were only weakly related (correlation ${signed(r)}).`;
    grCard.setTable(() => ({
      columns: ["Company", "Premium growth", "Paid to incurred", "Net premiums earned"],
      rows: pts.sort((a, b) => b.x - a.x).map((p) => [p.label, pct(p.x, 1), pct(p.y, 0), money(p.size)]),
    }));
  };

  // ---------------------------------------------------------------- every carrier, every year
  const htCard = card(grid, { title: "", span: 12, id: "claims-heat" });
  const heatRows = () => peers()
    .sort((a, b) => SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment) || a.ticker.localeCompare(b.ticker))
    .map((c) => ({ id: c.cik, label: c.ticker, name: displayName(c), group: c.segment, values: row(c.cik, metric().key) }))
    .filter((r) => r.values.some((v) => v != null));
  const heat = yearHeat({
    card: htCard, store, label: "The metric by carrier and fiscal year", years, getRows: heatRows,
    fmt: (v) => metric().fmt(v), metricName: () => metric().label, getScale: () => metric().scale,
    getYear: () => year, onYear: (y) => setYear(y),
  });
  const htChrome = () => {
    const m = metric();
    htCard.setTitle(`${m.label}, every carrier and year`, "Rows grouped by segment · outlined: the selected carrier and the fiscal year read above · click a cell to focus both");
    if (m.scale.center !== undefined) {
      legend(htCard.legend, [
        { label: `Favorable, ${m.fmt(-(m.scale.span ?? 0.1))} or more`, color: "var(--div-neg)", shape: "box" },
        { label: "None", color: "var(--div-mid)", shape: "box" },
        { label: `Adverse, ${m.fmt(m.scale.span ?? 0.1)} or more`, color: "var(--div-pos)", shape: "box" },
      ]);
    } else {
      legend(htCard.legend, [{ label: "Lower", color: "#cde2fb", shape: "box" }, { label: "Higher", color: "#0d366b", shape: "box" }]);
    }
    const rows = heatRows();
    if (m.key === "dev_pct_open" || m.key === "pyd_ratio") {
      const share = years.map((_, i) => {
        const v = rows.map((r) => r.values[i]).filter((x): x is number => x != null);
        return { n: v.length, adverse: v.filter((x) => x > 0).length };
      });
      const ok = share.map((s, i) => ({ ...s, y: years[i] })).filter((s) => s.n >= 10);
      const worst = [...ok].sort((a, b) => b.adverse / b.n - a.adverse / a.n)[0];
      const last = ok[ok.length - 1];
      htCard.caption.textContent = worst && last
        ? `Adverse development was most widespread in fiscal ${worst.y} (${worst.adverse} of ${worst.n} carriers shown); in fiscal ${last.y}, ${last.adverse} of ${last.n}. Empty cells: not tagged that year, or before the carrier listed.`
        : "Empty cells: not tagged that year, or before the carrier listed.";
    } else {
      htCard.caption.textContent = "Colors run over the 3rd to 97th percentile of the values shown. Empty cells: not tagged that year, or before the carrier listed.";
    }
    htCard.setTable(() => ({
      columns: ["Company", ...years.map(String)],
      rows: rows.map((r) => [r.name, ...r.values.map((v) => (v == null ? "–" : m.fmt(v)))]),
    }));
  };

  // ---------------------------------------------------------------- accident-year development (10-K instances)
  const ayHost = el("div", { class: "claims-ay" });
  host.append(ayHost);
  let lineName: string | null = null;
  let ayMode: "claims" | "severity" | "ibnr" = "claims";
  const tri = () => cd.triangles[String(company().cik)] ?? null;
  const currentLine = (): ClaimsLine | null => {
    const t = tri();
    if (!t) return null;
    return t.lines.find((l) => l.name === lineName) ?? t.lines[0] ?? null;
  };
  let ayRedraw: (() => void) | null = null;
  const renderAy = () => {
    ayHost.replaceChildren();
    ayRedraw = null;
    const anyTriangles = Object.keys(cd.triangles).length > 0;
    const t = tri();
    const c = company();
    ayHost.append(el("h3", { class: "claims-ay-title", text: "Accident-year development" }));
    if (!anyTriangles) {
      ayHost.append(el("p", { class: "note", text: "Loss triangles by accident year, reported claim counts, average severity and payout patterns come "
        + "from each 10-K's XBRL instance (the claims-development disclosures required from fiscal 2016). They appear here once those "
        + "filing documents are downloaded; everything above comes from the roll-forward facts already loaded." }));
      return;
    }
    if (!t) {
      ayHost.append(el("p", { class: "note", text: `No accident-year disclosure was found for ${displayName(c)} in the 10-K instances downloaded `
        + `(${cd.coverage.triangleCompanies} carriers have one). Pick another carrier to see its triangles.` }));
      return;
    }
    const line = currentLine()!;
    lineName = line.name;
    const lineCtl = selectControl("Line of business", t.lines.map((l) => ({ value: l.name, label: l.name })), line.name,
      (v) => { lineName = v; renderAy(); }, "ctl-claims-line");
    const modeCtl = segmented("Per accident year", [
      { value: "claims", label: "Reported claims" }, { value: "severity", label: "Average severity" }, { value: "ibnr", label: "IBNR share" },
    ], ayMode, (v) => { ayMode = v as typeof ayMode; renderAy(); });
    ayHost.append(el("div", { class: "controls" }, lineCtl.root, modeCtl.root));
    const g2 = el("div", { class: "grid" });
    ayHost.append(g2);
    const tCard = card(g2, { title: `${c.ticker} · ${line.name}: incurred estimates by accident year`, span: 6, id: "claims-triangle",
      sub: `Cumulative incurred against the first estimate · from the fiscal ${t.fy} 10-K` });
    legend(tCard.legend, [
      { label: "Estimate fell (favorable)", color: "var(--div-neg)", shape: "box" },
      { label: "Unchanged", color: "var(--div-mid)", shape: "box" },
      { label: "Estimate rose (adverse)", color: "var(--div-pos)", shape: "box" },
    ]);
    const th = triangleHeat({ card: tCard, label: "Accident-year development triangle", getLine: currentLine, money,
      change: (v) => signedPct(v, 1), ratio: (v) => pct(v, 0) });
    // accident years evaluated at least twice: the latest one has only its first estimate
    const devm = developmentVsFirst(line);
    const moved = devm.map((r, i) => ({ ay: line.ays[i], v: latestOf(r), n: r.filter((x) => x != null).length }))
      .filter((d): d is { ay: number; v: number; n: number } => d.v != null && d.n >= 2);
    const up = moved.filter((d) => d.v > 0.005).length;
    const down = moved.filter((d) => d.v < -0.005).length;
    const biggest = [...moved].sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
    const ata = ageToAge(line.incurred);
    tCard.caption.textContent = moved.length
      ? `Of ${moved.length} accident years evaluated more than once, ${up} now stand above their first estimate and ${down} below`
        + (biggest ? `; the largest move: ${biggest.ay} (${signedPct(biggest.v, 1)}).` : ".")
        + (ata[0] != null ? ` Volume-weighted development factor from year 1 to 2: ${num(ata[0], 3)}.` : "")
      : "Only first estimates are disclosed for this line.";
    tCard.setTable(() => ({
      columns: ["Accident year", ...Array.from({ length: Math.max(...line.incurred.map((r) => r.length)) }, (_, k) => `Year ${k + 1}`)],
      rows: line.ays.map((ay, r) => [String(ay), ...line.incurred[r].map((v) => (v == null ? "" : money(v)))]),
    }));
    const severity = line.ays.map((_, r) => {
      const inc = latestOf(line.incurred[r]);
      const n = line.claims[r];
      return inc != null && n != null && n > 0 ? inc / n : null;
    });
    const ibnrShare = line.ays.map((_, r) => {
      const inc = latestOf(line.incurred[r]);
      const b = line.ibnr[r];
      return inc != null && b != null && inc > 0 ? b / inc : null;
    });
    const modeName = { claims: "Reported claims", severity: "Incurred per reported claim", ibnr: "IBNR share of incurred" }[ayMode];
    const aCard = card(g2, { title: `${modeName} by accident year`, span: 3, id: "claims-ay-cols",
      sub: ayMode === "claims" ? "Cumulative reported claims, latest evaluation" : ayMode === "severity" ? "Latest incurred / reported claims" : "Incurred but not reported, latest evaluation" });
    const vals = ayMode === "claims" ? line.claims : ayMode === "severity" ? severity : ibnrShare;
    const fmtA = ayMode === "claims" ? (v: number) => count(v) : ayMode === "severity" ? money : (v: number) => pct(v, 0);
    const ac = ayColumns({ card: aCard, label: modeName, getLine: currentLine, getValues: () => vals, fmt: fmtA, name: () => modeName });
    const knownVals = vals.filter((v): v is number => v != null);
    aCard.caption.textContent = !knownVals.length ? "Not disclosed for this line (claim counts are optional for some lines)."
      : ayMode === "ibnr" ? "Recent accident years carry more IBNR: their claims have not all been reported yet."
        : `Accident years ${line.ays[0]}–${line.ays[line.ays.length - 1]}; recent years are still developing.`;
    aCard.setTable(() => ({ columns: ["Accident year", modeName], rows: line.ays.map((ay, r) => [String(ay), vals[r] == null ? "–" : fmtA(vals[r] as number)]) }));
    const pCard = card(g2, { title: "Payout pattern", span: 3, id: "claims-payout", sub: "Average share of an accident year's claims paid in each development year" });
    legend(pCard.legend, [{ label: "Paid that year", color: "var(--s1)", shape: "box" }, { label: "Cumulative", color: "var(--s2)" }]);
    const pc = payoutChart({ card: pCard, label: "Average annual payout pattern", getLine: currentLine, pct: (v) => pct(v, 0) });
    const cum = line.payout.reduce<number[]>((a, v) => [...a, (a[a.length - 1] ?? 0) + (v ?? 0)], []);
    const half = cum.findIndex((v) => v >= 0.5);
    pCard.caption.textContent = line.payout.length ? (half >= 0 ? `Half of an accident year's claims are paid by development year ${half + 1}.` : "Less than half is paid within the years disclosed.") : "";
    pCard.setTable(() => ({ columns: ["Development year", "Paid that year", "Cumulative"], rows: line.payout.map((v, k) => [String(k + 1), pct(v, 1), pct(cum[k], 1)]) }));
    ayRedraw = () => { th.redraw(); ac.redraw(); pc.redraw(); };
  };

  // ---------------------------------------------------------------- wiring
  const singles = () => { renderTiles(); devChrome(); wfChrome(); lnChrome(); };
  const peersChrome = () => { rkChrome(); scChrome(); grChrome(); htChrome(); };
  const redrawPeers = () => { rank.redraw(); tail.redraw(); gr.redraw(); heat.redraw(); };
  function setYear(y: number) {
    if (y === year || !years.includes(y)) return;
    year = y;
    yearCtl.set(String(y));
    renderTiles(); devChrome(); wfChrome(); peersChrome();
    dev.redraw(); wf.redraw(); redrawPeers();
  }
  function onMetric() {
    metricCtl.set(metricKey);
    help.textContent = metric().help;
    rkChrome(); htChrome(); rank.redraw(); heat.redraw();
  }
  singles();
  peersChrome();
  renderAy();
  store.on(["selected"], () => {
    singles(); peersChrome();
    dev.redraw(); wf.redraw(); lines.redraw(); redrawPeers();
    lineName = null;
    renderAy();
  });
  store.on(["segments", "historical"], () => { peersChrome(); redrawPeers(); });
  store.on(["from"], () => lines.redraw());
  void ayRedraw;
}

function signed(v: number, digits = 2): string {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(digits);
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export const _test = { pearson, ordinal };
export type { ClaimsData };
