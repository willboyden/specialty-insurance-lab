// People and technology: staff counts, premium per employee, staff growth against premium growth, cost
// efficiency, capital spending, and how often the filings discuss technology. Six linked views: hover a company
// anywhere to light it up everywhere, click to focus it; hovering a year on a time chart moves the ranking, the
// efficiency scatter and the spending ranking to that year.
import type { AppData, Company, Num } from "../types";
import type { Store } from "../state";
import { card, el, legend, segmented, tiles } from "../ui";
import { SEGMENT_SHORT, displayName, median, visibleCompanies } from "../data";
import { count, money, pct, signedPct } from "../format";
import { rankBars, type RankItem } from "../charts/rankbars";
import { ensureStyle } from "../charts/b-style";
import { yearLines } from "../charts/b-yearlines";
import { peopleLines, type YearLine } from "../charts/people-lines";
import { peopleScatter, type PeoplePoint } from "../charts/people-scatter";
import type { PeopleCompany, PeopleData } from "../domains/people";
import "./people.css";

type Mode = "reported" | "plan";
const INTL = "Bermuda and international specialty (re)insurance";
const GROWTH_YEARS = 5;

const THEME_LABEL: Record<string, string> = {
  ai: "Artificial intelligence",
  generative_ai: "Generative AI and language models",
  machine_learning: "Machine learning",
  data_analytics: "Data and predictive analytics",
  cloud: "Cloud computing",
  automation: "Automation",
  digital: "Digital transformation",
  modernization: "Legacy-system modernization",
  insurtech: "Insurtech",
};
const TECH_SHOWN = ["ai", "generative_ai", "machine_learning", "data_analytics", "cloud", "automation"];

// what a reader needs to know about one company's staff series (checked against the plan filings)
const CAVEAT: Record<string, string> = {
  AFG: "Until the 2021 sale of the annuity business the 401(k) plan also covered annuity staff.",
  Y: "TransRe's plans count from 2012, the year Alleghany bought it.",
  SPNT: "Counts start in 2021, when Sirius merged into SiriusPoint; no plan filing was found for 2022.",
  MKL: "Markel Ventures' non-insurance businesses run their own plans and are not counted.",
  PLMR: "No Palomar plan appears in the full Form 5500 data before 2021 (plans under 100 people file a short form, not loaded here).",
  WRB: "Staff outside the US are not in the US plan.",
};
// left out of the spending ranking: the consolidated cash-flow figure is mostly not insurance
const CAPEX_EXCLUDE: Record<string, string> = {
  MKL: "Markel is left out: its cash-flow figure includes the Markel Ventures manufacturing and service businesses.",
};

const sp = (v: number | null | undefined) => signedPct(v, 1);
/** dollars per head on one scale: $915K, $2.5M */
const perHead = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return "–";
  return v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : `$${Math.round(v / 1e3)}K`;
};

export const peopleSection = {
  id: "people",
  nav: "People & tech",
  title: "People and technology",
  intro: (d: AppData) => {
    const c = d.people?.coverage;
    const span = c ? `${c.planYears[0]}–${c.planYears[1]}` : "";
    return "How many people each carrier employs, how much premium each person supports, whether staff grew as fast as "
      + "premium, and what carriers spend on and say about technology. Staff counts come from the Department of "
      + `Labor's public retirement-plan filings (${span})${c && c.companiesWithReported >= 5 ? " and from each 10-K" : ""}; `
      + "spending from the XBRL cash-flow statements; technology themes from SEC full-text search.";
  },
  mount: mountPeople,
};

function mountPeople(host: HTMLElement, data: AppData, store: Store) {
  ensureStyle();
  const P = data.people as PeopleData | null;
  if (!P || !P.years?.length) {
    host.append(el("p", { class: "empty", text: "The people and technology data is not in this build." }));
    return;
  }
  const years = P.years;
  const hasReported = P.coverage.companiesWithReported >= 5;
  let mode: Mode = hasReported ? "reported" : "plan";
  const rec = (cik: number): PeopleCompany | undefined => P.companies[String(cik)];
  const staff = (cik: number, i: number): Num => {
    const r = rec(cik);
    if (!r || i < 0) return null;
    const v = mode === "reported" ? r.employees[i] : r.plan[i];
    return v != null && v > 0 ? v : null;
  };
  const npe = (cik: number, i: number): Num => (i >= 0 ? rec(cik)?.npe[i] ?? null : null);
  const visible = () => visibleCompanies(data, store.get().segments, store.get().historical).filter((c) => rec(c.cik));
  // per-employee views leave out groups whose staff mostly work outside the US when the measure is the US plan
  const ratioSet = () => visible().filter((c) => mode === "reported" || c.segment !== INTL);
  const perEmp = (cik: number, i: number): Num => {
    const s = staff(cik, i);
    const n = npe(cik, i);
    return s && n ? n / s : null;
  };
  const expRatio = (cik: number, i: number): Num => {
    const r = rec(cik);
    const u = r?.uwExpense[i];
    const n = r?.npe[i];
    return u != null && n ? u / n : null;
  };
  // the latest year with enough companies to compare, in the current measure
  const latestIdx = () => {
    for (let i = years.length - 1; i >= 0; i--) {
      if (ratioSet().filter((c) => perEmp(c.cik, i) != null).length >= 5) return i;
    }
    return years.length - 1;
  };
  const yearIdx = () => {
    const hq = store.get().hoverQuarter;
    const i = hq ? years.indexOf(Number(hq.slice(0, 4))) : -1;
    return i >= 0 && ratioSet().some((c) => perEmp(c.cik, i) != null) ? i : latestIdx();
  };
  const caveat = (c: Company) => CAVEAT[c.ticker];
  const staffWord = () => (mode === "reported" ? "employees (10-K)" : "US 401(k) participants");

  // ---------------------------------------------------------------- controls and notes
  const modeCtl = segmented<Mode>("Staff measure", [
    { value: "reported", label: "Reported headcount (10-K)" },
    { value: "plan", label: "US 401(k) participants" },
  ], mode, (v) => {
    if (v === "reported" && !hasReported) return;
    mode = v;
    modeCtl.set(v);
    chrome();
    redrawAll();
  });
  const reportedBtn = modeCtl.root.querySelector<HTMLButtonElement>("button");
  if (reportedBtn && !hasReported) {
    reportedBtn.disabled = true;
    reportedBtn.title = "Reported headcount is read from each 10-K's Employees section; those documents are not loaded yet";
  }
  const note = el("p", { class: "sub p-note" });
  host.append(el("div", { class: "controls" }, modeCtl.root), note);
  const tileHost = el("div", { class: "p-tiles" });
  host.append(tileHost);
  const grid = el("div", { class: "grid" });
  host.append(grid);

  // ---------------------------------------------------------------- 1. staff over time
  const linesCard = card(grid, { title: "", span: 8, id: "people-staff" });
  const lines = peopleLines({
    card: linesCard, store, years, label: "Staff of every carrier by year", fmt: (v) => count(v), log: () => true,
    height: (w) => (w < 600 ? 300 : 360),
    getSeries: () => {
      const s = store.get();
      const out: YearLine[] = visible().filter((c) => c.cik !== s.selected)
        .map((c) => ({ id: String(c.cik), label: displayName(c), values: years.map((_, i) => staff(c.cik, i)), role: "context" }));
      const sel = data.byCik.get(s.selected);
      if (sel && rec(sel.cik)) {
        out.push({ id: String(sel.cik), label: sel.ticker, values: years.map((_, i) => staff(sel.cik, i)), role: "focus", color: "var(--s1)" });
      }
      return out;
    },
    note: (yr) => (mode === "plan" ? `Active 401(k) participants at the end of the ${yr} plan year` : undefined),
  });
  const linesChrome = () => {
    const sel = data.byCik.get(store.get().selected);
    const shown = visible().filter((c) => years.some((_, i) => staff(c.cik, i) != null)).length;
    linesCard.setTitle(mode === "reported" ? "Headcount over time" : "US staff over time (401(k) participants)",
      `${shown} carriers · log scale, so equal slopes mean equal growth rates · click a line to focus`);
    legend(linesCard.legend, [
      { label: sel ? displayName(sel) : "Selected", color: "var(--s1)" },
      { label: "Other carriers", color: "var(--context-strong)" },
    ]);
    const c = sel ? caveat(sel) : undefined;
    linesCard.caption.textContent = (mode === "plan"
      ? "Employees actively covered by the company's US 401(k) plans at the end of each plan year (Form 5500 line 6a(2)), "
        + "summed over its plans. Staff outside the US, and new hires not yet eligible, are not counted. "
      : "Headcount as each annual report states it, as of the date the report gives. ")
      + (sel && rec(sel.cik)?.sponsors.length && mode === "plan" ? `${sel.ticker}'s plan sponsors: ${[...new Set(rec(sel.cik)!.sponsors.map((x) => x.replace(/[.,]+$/, "")))].slice(0, 3).join("; ")}. ` : "")
      + (c ?? "");
    linesCard.setTable(() => {
      const last = years.slice(-8);
      return {
        columns: ["Company", ...last.map(String)],
        rows: visible().map((c) => [displayName(c), ...last.map((y) => count(staff(c.cik, years.indexOf(y))))]),
        caption: `${staffWord()} by year`,
      };
    });
  };

  // ---------------------------------------------------------------- 2. premium per employee
  const rankCard = card(grid, { title: "", span: 4, id: "people-rank" });
  const rank = rankBars({
    card: rankCard, store, label: "Premium per employee", fmt: (v) => perHead(v), ascending: false,
    getItems: (): RankItem[] => {
      const i = yearIdx();
      return ratioSet().map((c) => ({
        id: c.cik, label: c.ticker, name: displayName(c), value: perEmp(c.cik, i) as number,
        note: `${count(staff(c.cik, i))} ${staffWord()} · ${money(npe(c.cik, i))} net premiums earned`,
      })).filter((d) => d.value != null);
    },
  });
  const rankChrome = () => {
    const i = yearIdx();
    rankCard.setTitle(`Premium per employee, ${years[i]}`, "Net premiums earned per head · highest first · follows the time crosshair");
    rankCard.caption.textContent = mode === "plan"
      ? "Per US 401(k) participant. Bermuda and international groups are left out (most of their staff work outside the US); "
        + "for others with overseas operations the figure runs high."
      : "Per employee as reported in the 10-K.";
    rankCard.setTable(() => ({
      columns: ["Company", "Premium per employee", "Staff", "Net premiums earned"],
      rows: ratioSet().filter((c) => perEmp(c.cik, i) != null)
        .sort((a, b) => (perEmp(b.cik, i) as number) - (perEmp(a.cik, i) as number))
        .map((c) => [displayName(c), perHead(perEmp(c.cik, i)), count(staff(c.cik, i)), money(npe(c.cik, i))]),
    }));
  };

  // ---------------------------------------------------------------- 3. staff growth vs premium growth
  const cagr = (a: Num, b: Num, n: number): Num => (a && b && a > 0 && b > 0 ? (b / a) ** (1 / n) - 1 : null);
  const growthWindow = () => {
    const i1 = yearIdx();
    return { i0: i1 - GROWTH_YEARS, i1 };
  };
  const growthPoints = (): PeoplePoint[] => {
    const { i0, i1 } = growthWindow();
    if (i0 < 0) return [];
    return ratioSet().map((c): PeoplePoint | null => {
      const gs = cagr(staff(c.cik, i0), staff(c.cik, i1), GROWTH_YEARS);
      const gp = cagr(npe(c.cik, i0), npe(c.cik, i1), GROWTH_YEARS);
      if (gs == null || gp == null) return null;
      return {
        id: c.cik, ticker: c.ticker, name: displayName(c), x: gs, y: gp, size: npe(c.cik, i1) ?? 0,
        tip: [
          { name: "Premium growth a year", value: sp(gp), strong: true },
          { name: "Staff growth a year", value: sp(gs) },
          { name: `Staff ${years[i0]} → ${years[i1]}`, value: `${count(staff(c.cik, i0))} → ${count(staff(c.cik, i1))}` },
          { name: `Premium ${years[i0]} → ${years[i1]}`, value: `${money(npe(c.cik, i0))} → ${money(npe(c.cik, i1))}` },
        ],
      };
    }).filter((p): p is PeoplePoint => p != null);
  };
  const growthCard = card(grid, { title: "", span: 6, id: "people-growth" });
  const growth = peopleScatter({
    card: growthCard, store, label: "Staff growth against premium growth",
    xLabel: "Staff growth a year", yLabel: "Premium growth a year", xFmt: (v) => pct(v, 0), yFmt: (v) => pct(v, 0),
    diagonal: { label: "premium grew as fast as staff" },
    corner: () => { const { i0, i1 } = growthWindow(); return i0 >= 0 ? `${years[i0]}–${String(years[i1]).slice(2)}` : ""; },
    getPoints: growthPoints,
  });
  const growthChrome = () => {
    const { i0, i1 } = growthWindow();
    const pts = growthPoints();
    const above = pts.filter((p) => p.y > p.x).length;
    const gap = median(pts.map((p) => p.y - p.x));
    growthCard.setTitle(i0 >= 0 ? `Staff growth against premium growth, ${years[i0]}–${years[i1]}` : "Staff growth against premium growth",
      "Compound annual rates · dots above the diagonal grew premium faster than staff · sized by premium");
    legend(growthCard.legend, [
      { label: "Selected", color: "var(--s1)", shape: "dot" },
      { label: "Other carriers", color: "var(--context-strong)", shape: "dot" },
    ]);
    growthCard.caption.textContent = pts.length
      ? `${above} of ${pts.length} carriers grew premium faster than staff; the median gap is ${sp(gap)} a year. `
        + "Premium growth includes rate increases, so part of the gap is pricing rather than productivity. "
        + "Carriers without staff counts at both ends of the window are left out."
      : "Not enough years of staff counts for this window.";
    growthCard.setTable(() => ({
      columns: ["Company", "Staff growth a year", "Premium growth a year", "Gap"],
      rows: pts.sort((a, b) => (b.y - b.x) - (a.y - a.x)).map((p) => [p.name, sp(p.x), sp(p.y), sp(p.y - p.x)]),
    }));
  };

  // ---------------------------------------------------------------- 4. premium per employee vs expense ratio
  const effPoints = (): PeoplePoint[] => {
    const i = yearIdx();
    return ratioSet().map((c): PeoplePoint | null => {
      const x = perEmp(c.cik, i);
      const y = expRatio(c.cik, i);
      if (x == null || y == null) return null;
      return {
        id: c.cik, ticker: c.ticker, name: displayName(c), x, y, size: npe(c.cik, i) ?? 0,
        tip: [
          { name: "Expense ratio", value: pct(y, 1), strong: true },
          { name: "Premium per employee", value: money(x) },
          { name: "Staff", value: count(staff(c.cik, i)) },
          { name: "Segment", value: SEGMENT_SHORT[c.segment] ?? c.segment },
        ],
      };
    }).filter((p): p is PeoplePoint => p != null);
  };
  const effCard = card(grid, { title: "", span: 6, id: "people-efficiency" });
  const eff = peopleScatter({
    card: effCard, store, label: "Premium per employee against the expense ratio",
    xLabel: "Premium per employee (log scale)", yLabel: "Underwriting expense ratio", xFmt: (v) => perHead(v), yFmt: (v) => pct(v, 0),
    xLog: true, corner: () => String(years[yearIdx()]), getPoints: effPoints,
  });
  const effChrome = () => {
    const pts = effPoints();
    const rho = spearman(pts.map((p) => p.x), pts.map((p) => p.y));
    effCard.setTitle(`Do leaner carriers run cheaper? ${years[yearIdx()]}`,
      "Premium each employee supports against acquisition and other underwriting expenses per premium dollar");
    legend(effCard.legend, [
      { label: "Selected", color: "var(--s1)", shape: "dot" },
      { label: "Other carriers", color: "var(--context-strong)", shape: "dot" },
    ]);
    // t statistic of the rank correlation: below about 2 the sign could be chance with this few carriers
    const t = rho == null ? 0 : rho * Math.sqrt((pts.length - 2) / Math.max(1e-9, 1 - rho * rho));
    effCard.caption.textContent = rho == null || pts.length < 6 ? "Too few carriers with both figures this year." : (
      `Across ${pts.length} carriers the rank correlation is ${rho.toFixed(2)}`
      + (Math.abs(t) < 2 ? ", too weak to call with this few carriers: premium per employee says little about the expense ratio. "
        : rho < 0 ? ": more premium per employee goes with a lower expense ratio. "
          : ": more premium per employee goes with a higher expense ratio. ")
      + "The expense ratio includes commissions paid to brokers and agents, which a lean staff does not remove.");
    effCard.setTable(() => ({
      columns: ["Company", "Premium per employee", "Expense ratio", "Staff"],
      rows: pts.sort((a, b) => b.x - a.x).map((p) => [p.name, perHead(p.x), pct(p.y, 1), count(staff(p.id, yearIdx()))]),
    }));
  };

  // ---------------------------------------------------------------- 5. capital spending
  const capexShare = (cik: number, i: number): Num => {
    const r = rec(cik);
    if (!r) return null;
    let c = 0;
    let n = 0;
    let k = 0;
    for (let j = Math.max(0, i - 2); j <= i; j++) {
      if (r.capex[j] != null && r.npe[j]) { c += r.capex[j] as number; n += r.npe[j] as number; k++; }
    }
    return k >= 2 && n > 0 ? c / n : null;
  };
  const capCard = card(grid, { title: "", span: 6, id: "people-capex" });
  const capexSet = () => visible().filter((c) => !CAPEX_EXCLUDE[c.ticker]);
  const cap = rankBars({
    card: capCard, store, label: "Capital spending as a share of premium", fmt: (v) => pct(v, 1), ascending: false,
    getItems: (): RankItem[] => {
      const i = yearIdx();
      return capexSet().map((c) => {
        const r = rec(c.cik);
        const sw = r?.software.slice(Math.max(0, i - 2), i + 1).filter((v): v is number => v != null) ?? [];
        return {
          id: c.cik, label: c.ticker, name: displayName(c), value: capexShare(c.cik, i) as number,
          note: sw.length ? `Includes capitalized software of ${money(sw.reduce((a, b) => a + b, 0))} over these years` : "Property, equipment and software purchases",
        };
      }).filter((d) => d.value != null);
    },
  });
  const capChrome = () => {
    const i = yearIdx();
    const items = capexSet().map((c) => capexShare(c.cik, i)).filter((v): v is number => v != null);
    const excluded = visible().filter((c) => CAPEX_EXCLUDE[c.ticker]).map((c) => CAPEX_EXCLUDE[c.ticker]);
    capCard.setTitle(`Capital spending as a share of premium, ${years[Math.max(0, i - 2)]}–${years[i]}`,
      "Purchases of property, equipment and software over net premiums earned, three-year total · highest first");
    capCard.caption.textContent = `${items.length} carriers report the purchases in their XBRL cash-flow statement; the median is `
      + `${pct(median(items), 2)} of premium. It counts buildings as well as systems, so one headquarters project can lift a share; `
      + "systems bought as a service run through the expense ratio instead, so a low share does not mean little technology. "
      + `Insurers do not report research and development.${excluded.length ? ` ${excluded.join(" ")}` : ""}`;
    capCard.setTable(() => ({
      columns: ["Company", "Share of premium", "Capital spending (3 years)"],
      rows: capexSet().filter((c) => capexShare(c.cik, i) != null)
        .sort((a, b) => (capexShare(b.cik, i) as number) - (capexShare(a.cik, i) as number))
        .map((c) => {
          const r = rec(c.cik)!;
          const sum = r.capex.slice(Math.max(0, i - 2), i + 1).reduce<number>((a, b) => a + (b ?? 0), 0);
          return [displayName(c), pct(capexShare(c.cik, i), 2), money(sum)];
        }),
    }));
  };

  // ---------------------------------------------------------------- 6. technology in the filings
  const ty = P.techYears;
  const builtYear = Number(data.meta.built.slice(0, 4));
  const partialYear = ty.includes(builtYear) ? builtYear : undefined;
  const activeSpec = data.companies.filter((c) => c.cohort === "specialty" && c.status === "active" && rec(c.cik)?.tech);
  const pooled = (theme: string) => ty.map((_, i) => {
    let num = 0;
    let den = 0;
    for (const c of activeSpec) {
      const t = rec(c.cik)!.tech!;
      const n = t.filings[i] ?? 0;
      const v = (t[theme] as Num[] | undefined)?.[i];
      if (n > 0 && v != null) { num += v * n; den += n; }
    }
    return den > 0 ? num / den : null;
  });
  const techCard = card(grid, { title: "Technology in the filings", span: 6, id: "people-tech",
    sub: "Share of 10-K and 10-Q filings that mention each theme, per year" });
  const minis = el("div", { class: "b-minis" });
  techCard.body.append(minis);
  const techRedraws: (() => void)[] = [];
  const drawTech = () => {
    const sel = data.byCik.get(store.get().selected);
    legend(techCard.legend, [
      { label: `All active specialty carriers (${activeSpec.length}, filings pooled)`, color: "var(--s1)" },
      { label: sel ? displayName(sel) : "Selected company", color: "var(--s2)" },
    ]);
    minis.replaceChildren();
    techRedraws.length = 0;
    for (const theme of TECH_SHOWN) {
      const ch = el("div", { class: "b-chart" });
      minis.append(el("div", { class: "b-mini" }, el("h4", { text: THEME_LABEL[theme] }), el("p", { class: "b-unit", text: "% of filings" }), ch));
      const own = sel ? ((rec(sel.cik)?.tech?.[theme] as Num[] | undefined) ?? ty.map(() => null)) : ty.map(() => null);
      techRedraws.push(yearLines({
        host: ch, store, years: ty, partialYear, fmt: (v) => `${Math.round(v * 100)}%`, domain: [0, 1],
        label: `${THEME_LABEL[theme]}: share of filings mentioning it`,
        series: [
          { label: "All active specialty carriers", color: "var(--s1)", values: pooled(theme), strong: true },
          { label: sel ? sel.ticker : "Selected", color: "var(--s2)", values: own as (number | null)[] },
        ],
        note: () => `Searched for: ${(P.themes[theme] ?? []).map((p) => `“${p}”`).join(", ")}`,
      }));
    }
  };
  drawTech();
  techCard.onRedraw(() => techRedraws.forEach((r) => r()));
  const lastFull = partialYear ? partialYear - 1 : ty[ty.length - 1];
  const li = ty.indexOf(lastFull);
  const genai = pooled("generative_ai");
  const ml = pooled("machine_learning");
  techCard.caption.textContent = `In ${lastFull}, ${pct(genai[li], 0)} of active specialty carriers' filings mentioned generative AI `
    + `or language models and ${pct(ml[li], 0)} machine learning. A filing counts when SEC full-text search finds a phrase in any of `
    + `its documents; this measures attention, not spending.${partialYear ? ` ${partialYear} is the year to date (open dots).` : ""}`;
  techCard.setTable(() => ({
    columns: ["Year", ...TECH_SHOWN.map((t) => THEME_LABEL[t])],
    rows: ty.map((y, i) => [partialYear === y ? `${y} (to date)` : String(y),
      ...TECH_SHOWN.map((t) => pct(pooled(t)[i], 0))]).reverse(),
    caption: "Share of active specialty carriers' filings mentioning each technology theme",
  }));

  // ---------------------------------------------------------------- 7. the industry around them
  const ctxCard = card(grid, { title: "The industry around them", span: 12, id: "people-industry",
    sub: "US insurance employment and pay, and the R&D of the companies building AI" });
  const ctxMinis = el("div", { class: "b-minis" });
  ctxCard.body.append(ctxMinis);
  const ind = P.industry;
  const aiTickers = Object.keys(P.ai).filter((t) => P.ai[t].rd.some((v) => v != null));
  const aiRd = years.map((_, i) => {
    const vals = aiTickers.map((t) => P.ai[t].rd[i]);
    return vals.every((v) => v != null) ? vals.reduce<number>((a, b) => a + (b as number), 0) : null;
  });
  const ctxDefs: { title: string; unit: string; values: Num[]; fmt: (v: number) => string; label: string }[] = [
    { title: "Insurance carriers and related: employment", unit: "thousands of people (BLS)", values: ind.employment, fmt: (v) => count(v), label: "Employment" },
    { title: "Wages and salaries per full-time equivalent", unit: "dollars a year (BEA)", values: ind.wagePerFte, fmt: (v) => money(v), label: "Pay per FTE" },
    { title: "Wage growth, insurance carriers", unit: "Employment Cost Index, change on a year earlier", values: ind.eciYoy, fmt: (v) => pct(v, 1), label: "Wage growth" },
    { title: `R&D of ${aiTickers.join(", ")}`, unit: "combined, dollars a year (10-K)", values: aiRd, fmt: (v) => money(v), label: "Combined R&D" },
  ];
  const ctxRedraws: (() => void)[] = [];
  for (const d of ctxDefs) {
    const ch = el("div", { class: "b-chart" });
    ctxMinis.append(el("div", { class: "b-mini" }, el("h4", { text: d.title }), el("p", { class: "b-unit", text: d.unit }), ch));
    const vals = d.values.filter((v): v is number => v != null);
    ctxRedraws.push(yearLines({
      host: ch, store, years, fmt: d.fmt, domain: [Math.min(0, ...vals), Math.max(...vals) * 1.08],
      label: `${d.title}, ${years[0]} to ${years[years.length - 1]}`,
      series: [{ label: d.label, color: "var(--s1)", values: d.values as (number | null)[], strong: true }],
    }));
  }
  ctxCard.onRedraw(() => ctxRedraws.forEach((r) => r()));

  const e0 = ind.employment.find((v) => v != null);
  const eLast = [...ind.employment].reverse().find((v) => v != null);
  ctxCard.caption.textContent = `US employment in insurance carriers and related activities went from ${count(e0)} thousand in ${years[0]} `
    + `to ${count(eLast)} thousand. Amazon reports no research-and-development line, so it is not in the R&D total. Sources: `
    + ind.series.map((s) => s.id).join(", ") + " (FRED).";
  ctxCard.setTable(() => ({
    columns: ["Year", ...ctxDefs.map((d) => d.label)],
    rows: years.map((y, i) => [String(y), ...ctxDefs.map((d) => (d.values[i] == null ? "–" : d.fmt(d.values[i] as number)))]).reverse(),
  }));

  // ---------------------------------------------------------------- tiles, notes, wiring
  const drawTiles = () => {
    const i = latestIdx();
    const set = ratioSet();
    const pe = set.map((c) => perEmp(c.cik, i)).filter((v): v is number => v != null);
    const withStaff = visible().filter((c) => staff(c.cik, i) != null).length;
    const gp = growthPoints();
    const gap = median(gp.map((p) => p.y - p.x));
    const gai = pooled("generative_ai");
    const gi0 = ty.indexOf(lastFull - 2);
    tiles(tileHost, [
      { label: `Carriers with staff counts, ${years[i]}`, value: `${withStaff}`, delta: mode === "plan" ? "from US 401(k) filings" : "from 10-K reports" },
      { label: `Median premium per employee, ${years[i]}`, value: perHead(median(pe)), delta: mode === "plan" ? "US-based carriers" : "all carriers" },
      { label: "Premium growth minus staff growth", value: gap == null ? "–" : `${sp(gap)} a year`, delta: `median, ${GROWTH_YEARS} years to ${years[i]}` },
      { label: `Filings mentioning generative AI, ${lastFull}`, value: pct(gai[li], 0), delta: gi0 >= 0 ? `${pct(gai[gi0], 0)} in ${lastFull - 2}` : "" },
    ]);
    note.textContent = mode === "plan"
      ? `Staff measure: employees active in each carrier's US 401(k) plans at plan-year end, from ${P.coverage.planRows.toLocaleString("en-US")} `
        + "Form 5500 filings matched by employer ID. It is a proxy: staff abroad are not counted."
        + (hasReported ? "" : " Headcount as reported in each 10-K is not loaded in this build.")
      : `Staff measure: headcount as each 10-K reports it (${P.coverage.headcountFound} of ${P.coverage.headcountReports} reports gave a number).`;
  };

  const chrome = () => { linesChrome(); rankChrome(); growthChrome(); effChrome(); capChrome(); drawTiles(); };
  const redrawAll = () => { lines.redraw(); rank.redraw(); growth.redraw(); eff.redraw(); cap.redraw(); };
  chrome();
  store.on(["segments", "historical", "selected"], () => { chrome(); redrawAll(); drawTech(); });
  let raf = 0;
  store.on(["hoverQuarter"], () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      rankChrome(); effChrome(); capChrome(); growthChrome();
      rank.redraw(); eff.redraw(); cap.redraw(); growth.redraw();
    });
  });
}

/** Spearman rank correlation (ties get average ranks); null below three pairs */
function spearman(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs.slice(0, n));
  const ry = rank(ys.slice(0, n));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
