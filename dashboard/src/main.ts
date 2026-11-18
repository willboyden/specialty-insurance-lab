import "./styles.css";
import { METRIC, loadAll, SEGMENT_ORDER, SEGMENT_SHORT, displayName } from "./data";
import { createStore, readHash, writeHash, type AppState, type Store } from "./state";
import { el, segmented, selectControl } from "./ui";
import type { AppData } from "./types";
import { count, quarterLabel } from "./format";
import { mountOverview } from "./sections/overview";
import { mountPeers } from "./sections/peers";
import { mountCompany } from "./sections/company";
import { mountDrivers } from "./sections/drivers";
import { mountDisclosures } from "./sections/disclosures";
import { mountStress } from "./sections/stress";
import { mountBacktest } from "./sections/backtest";
import { mountMethods } from "./sections/methods";
import { claimsSection } from "./sections/claims";
import { catastropheSection } from "./sections/catastrophes";
import { maSection } from "./sections/ma";
import { peopleSection } from "./sections/people";

export interface SectionDef {
  id: string;
  nav: string;
  title: string;
  intro: string | ((data: AppData) => string);
  mount: (host: HTMLElement, data: AppData, store: Store) => void;
}

const SECTIONS: SectionDef[] = [
  {
    id: "overview", nav: "Overview", title: "The specialty market at a glance", mount: mountOverview,
    intro: "Specialty carriers write the risks standard insurers decline or price badly: excess and surplus lines, "
      + "professional liability, marine, energy, catastrophe-exposed property. Their results, side by side with the "
      + "standard-lines benchmark, from every quarterly and annual report they filed with the SEC.",
  },
  {
    id: "peers", nav: "Peers", title: "Peer landscape", mount: mountPeers,
    intro: "Every carrier on one scale. Pick a metric; hover any line, dot or cell to light the same company up in "
      + "every view, and click to make it the focus of the page.",
  },
  {
    id: "company", nav: "Company", title: "Company deep dive", mount: mountCompany,
    intro: "Where the selected carrier's combined ratio comes from (current-year losses, reserve development and "
      + "expenses), what the model estimates about its sensitivities, and its filing record.",
  },
  claimsSection,
  catastropheSection,
  maSection,
  peopleSection,
  {
    id: "drivers", nav: "Risk drivers", title: "Risk drivers: catastrophes, geopolitics, the AI cycle, inflation", mount: mountDrivers,
    intro: "The forces the scenarios lean on, from public sources. The industry shock is not an input: the model "
      + "infers it from the carriers' own loss ratios, and it lines up with the catastrophe calendar.",
  },
  {
    id: "disclosures", nav: "Disclosures", title: "What the filings talk about", mount: mountDisclosures,
    intro: "SEC full-text search across every 10-K and 10-Q since 2001: the share of each carrier's filings that "
      + "discuss artificial intelligence, climate, geopolitics, social inflation and other themes.",
  },
  {
    id: "stress", nav: "Stress lab", title: "Stress lab: eight quarters under four shocks", mount: mountStress,
    intro: (d) => "Forecasts from the Bayesian model, run in your browser: pick a scenario, set its severity and watch "
      + "every carrier's combined ratio, return on equity and capital respond. Shocks and the labeled overlays are "
      + `assumptions; how each carrier responds to the shocks is estimated from ${d.meta.panel.first.slice(0, 4)}–`
      + `${d.meta.panel.last.slice(0, 4)} data.`,
  },
  {
    id: "backtest", nav: "Backtest", title: "Does the model forecast well?", mount: mountBacktest,
    intro: (d) => d.backtest
      ? `A rolling-origin test: refit at each year-end from ${d.backtest.origins[0].slice(0, 4)} to `
        + `${d.backtest.origins[d.backtest.origins.length - 1].slice(0, 4)} using only data available then, forecast the next `
        + "eight quarters, and compare with what happened and with naive forecasts."
      : "A rolling-origin test of the loss-ratio model against naive forecasts.",
  },
  {
    id: "methods", nav: "Data & methods", title: "Data, pipeline and methods", mount: mountMethods,
    intro: "Where every number comes from, how the database is built, how the models work, and what they cannot do.",
  },
];

function header(data: AppData): HTMLElement {
  const m = data.meta;
  const nCompanies = data.companies.filter((c) => c.cohort === "specialty").length;
  return el("header", { class: "masthead" },
    el("div", { class: "wrap" },
      el("p", { class: "eyebrow", text: "US specialty insurance · public data · Bayesian scenarios" }),
      el("h1", { text: "Specialty Insurance Stress Lab" }),
      el("p", {
        class: "lede",
        text: `${nCompanies} hand-selected US-listed specialty insurers, including the ones that were later acquired, `
          + `rebuilt quarter by quarter from ${count(m.xbrl.facts)} SEC XBRL facts, set against catastrophe, `
          + "geopolitical, AI-cycle and inflation data, and stress-tested with a hierarchical Bayesian model.",
      }),
      el("div", { class: "byline" },
        el("span", { text: `Financials through ${quarterLabel(m.dataThrough)}` }),
        el("span", { text: `Last filing read ${m.xbrl.lastFiled}` }),
        ...(checkedOn(data) ? [el("span", { text: `Statuses checked ${checkedOn(data)}` })] : []),
        el("span", { text: `Built ${m.built}` }),
        el("a", { href: "https://github.com/willboyden/specialty-insurance-lab", text: "Source code" }),
      ),
    ),
  );
}

function checkedOn(data: AppData): string | null {
  return data.companies.find((c) => c.listing)?.listing?.checkedOn ?? null;
}

function controls(data: AppData, store: Store): HTMLElement {
  const s = store.get();
  const groups = SEGMENT_ORDER;
  const options = data.companies
    .filter((c) => c.comparable)
    .sort((a, b) => groups.indexOf(a.segment) - groups.indexOf(b.segment) || a.name.localeCompare(b.name))
    .map((c) => ({
      value: String(c.cik),
      label: displayName(c) + (c.status !== "active" ? ` · ${c.status} ${c.statusYear ?? ""}`.trimEnd() : ""),
      group: SEGMENT_SHORT[c.segment] ?? c.segment,
    }));
  const company = selectControl("Company in focus", options, String(s.selected),
    (v) => store.set({ selected: Number(v) }), "ctl-company");
  store.on(["selected"], (st) => company.set(String(st.selected)));

  const chipBox = el("div", { class: "chips", role: "group", "aria-label": "Segments shown" });
  const chipFor = new Map<string, HTMLButtonElement>();
  for (const seg of groups) {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": String(s.segments.includes(seg)), text: SEGMENT_SHORT[seg] });
    b.addEventListener("click", () => {
      const cur = store.get().segments;
      const next = cur.includes(seg) ? cur.filter((x) => x !== seg) : [...cur, seg];
      if (next.length) store.set({ segments: groups.filter((g) => next.includes(g)) });
    });
    chipFor.set(seg, b);
    chipBox.append(b);
  }
  store.on(["segments"], (st) => chipFor.forEach((b, seg) => b.setAttribute("aria-pressed", String(st.segments.includes(seg)))));

  const hist = el("input", { type: "checkbox", id: "ctl-hist" }) as HTMLInputElement;
  hist.checked = s.historical;
  hist.addEventListener("change", () => store.set({ historical: hist.checked }));
  const histLabel = el("label", { class: "toggle", for: "ctl-hist" }, hist, "Include acquired and exited carriers");

  let theme = document.documentElement.getAttribute("data-theme") ?? "system";
  const themeCtl = segmented("Theme", [
    { value: "system", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" },
  ], theme, (v) => {
    theme = v;
    if (v === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", v);
    try {
      if (v === "system") localStorage.removeItem("sil.theme");
      else localStorage.setItem("sil.theme", v);
    } catch { /* storage may be unavailable */ }
    themeCtl.set(v);
    window.dispatchEvent(new Event("sil:theme"));
  });

  return el("div", { class: "wrap" },
    el("div", { class: "controls", role: "region", "aria-label": "Filters for the whole page" },
      company.root,
      el("div", { class: "control" }, el("span", { class: "label", text: "Segments" }), chipBox),
      el("div", { class: "control" }, el("span", { class: "label", text: "History" }), histLabel),
      themeCtl.root,
    ));
}

function navBar(): HTMLElement {
  const links = SECTIONS.map((s) => el("a", { href: `#${s.id}`, "data-target": s.id, text: s.nav }));
  for (const a of links) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.target!)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  return el("nav", { class: "sections", "aria-label": "Sections" }, el("div", { class: "wrap" }, ...links));
}

async function start() {
  const app = document.getElementById("app")!;
  let data: AppData;
  try {
    data = await loadAll();
  } catch (err) {
    app.replaceChildren(el("p", { class: "loading", text: `Could not load the data: ${(err as Error).message}` }));
    return;
  }
  const defaultCik = data.companies.find((c) => c.ticker === "KNSL")?.cik ?? data.companies[0].cik;
  const defaults: AppState = {
    selected: defaultCik, hover: null, hoverQuarter: null, metric: "combined_ratio_ttm",
    from: "2010-03-31", segments: [...SEGMENT_ORDER], historical: false,
    scenario: "climate", severity: 1, overlays: true, year: 1,
  };
  const byTicker = new Map(data.companies.map((c) => [c.ticker, c.cik]));
  const initial = readHash(defaults, (t) => byTicker.get(t));
  // a hand-edited or stale link must not break a section: keep only values that exist
  if (!METRIC.has(initial.metric)) initial.metric = defaults.metric;
  const scenarioKeys = new Set(["baseline", ...data.model.scenarios.map((x) => x.key)]);
  if (!scenarioKeys.has(initial.scenario)) initial.scenario = defaults.scenario;
  if (!data.byCik.has(initial.selected)) initial.selected = defaults.selected;
  const store = createStore(initial);
  store.on(["selected", "metric", "scenario", "severity", "year"], (st) =>
    writeHash(st, (c) => data.byCik.get(c)?.ticker ?? String(c)));

  app.replaceChildren(header(data), navBar(), controls(data, store));
  const main = el("main", { id: "main" });
  app.append(main);
  for (const s of SECTIONS) {
    const intro = typeof s.intro === "function" ? s.intro(data) : s.intro;
    const inner = el("div", { class: "wrap" }, el("h2", { text: s.title }), el("p", { class: "intro", text: intro }));
    const sec = el("section", { class: "block", id: s.id, "aria-labelledby": `${s.id}-h` }, inner);
    (inner.firstChild as HTMLElement).id = `${s.id}-h`;
    main.append(sec);
    try {
      s.mount(inner, data, store);
    } catch (err) {
      console.error(`section ${s.id} failed`, err);
      inner.append(el("p", { class: "empty", text: "This section could not be drawn." }));
    }
  }
  const loaded = (prefix: string) => data.meta.sources.find((x) => x.source.startsWith(prefix))?.loaded;
  const femaCite = [
    `Disaster Declarations Summaries v2 (https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries, retrieved ${loaded("fema") ?? "–"})`,
    ...(loaded("openfema_nfip") ? [`FIMA NFIP Redacted Claims v3 (https://www.fema.gov/api/open/v3/NfipClaims, retrieved ${loaded("openfema_nfip")})`] : []),
  ].join("; ");
  app.append(el("footer", { class: "site" }, el("div", { class: "wrap" },
    el("p", { text: "Data: SEC EDGAR (XBRL company facts, submissions, full-text search"
      + (data.meta.sources.some((x) => x.source.startsWith("sec_document")) ? ", filing documents" : "") + "); FRED "
      + "(BLS, BEA, Treasury, EIA, Chicago Fed series); Caldara-Iacoviello Geopolitical Risk index; Baker-Bloom-Davis "
      + "Economic Policy Uncertainty; NOAA (NCEI, National Hurricane Center HURDAT2, Storm Prediction Center, Climate "
      + "Prediction Center); USGS earthquake catalog; National Interagency Fire Center; U.S. Department of Labor Form 5500 "
      + `datasets; OpenFEMA: ${femaCite}. Public data; not investment advice. Scenario results are hypothetical stress `
      + "tests, not predictions." }),
    el("p", { text: "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by "
      + "FEMA. The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the "
      + "data have been retrieved from the Agency's website(s)." }),
  )));

  // highlight the section in view
  const navLinks = [...document.querySelectorAll<HTMLAnchorElement>("nav.sections a")];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      navLinks.forEach((a) => a.setAttribute("aria-current", String(a.dataset.target === e.target.id)));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  document.querySelectorAll("section.block").forEach((s) => io.observe(s));
  if (location.hash.length > 1 && !location.hash.includes("=")) {
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }
}

start();
