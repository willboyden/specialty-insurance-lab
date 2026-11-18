// Data & methods: the pipeline, the sources with their row counts, the survivorship timeline, and how every
// number is defined and modeled. Counts and diagnostics are read from the data files, not typed in.
import type { AppData, Company } from "../types";
import type { Store } from "../state";
import { card, el } from "../ui";
import { SEGMENT_ORDER, SEGMENT_SHORT } from "../data";
import { ensureStyle } from "../charts/b-style";
import { STATUS_STYLE, iconPath, timeline } from "../charts/timeline";
import { count, quarterLabel } from "../format";

const SOURCE_INFO: Record<string, { name: string; what: string; unit: string; url: string }> = {
  sec_companyfacts: {
    name: "SEC EDGAR XBRL company facts", what: "Every us-gaap and dei fact each company reported, in every filing that reported it",
    unit: "facts", url: "https://www.sec.gov/edgar",
  },
  sec_submissions: {
    name: "SEC EDGAR submissions", what: "The filing index: every 10-K, 10-Q, 8-K and other form, with dates",
    unit: "filings", url: "https://www.sec.gov/edgar",
  },
  efts: {
    name: "SEC EDGAR full-text search", what: "10-K and 10-Q filings that mention each risk theme, since 2001",
    unit: "company-theme-filing matches", url: "https://www.sec.gov/edgar/search/",
  },
  fred: {
    name: "FRED (Federal Reserve Bank of St. Louis)", what: "Treasury yields, CPI and PPI (BLS), GDP (BEA), oil (EIA), NFCI (Chicago Fed), policy uncertainty",
    unit: "observations", url: "https://fred.stlouisfed.org/",
  },
  gpr: {
    name: "Geopolitical Risk index", what: "Caldara and Iacoviello's monthly index from newspaper coverage, with country and component series",
    unit: "observations", url: "https://www.matteoiacoviello.com/gpr.htm",
  },
  fema: {
    name: "OpenFEMA disaster declarations", what: "Every federal disaster declaration, by designated area",
    unit: "declaration rows", url: "https://www.fema.gov/about/openfema/data-sets",
  },
  noaa_storm_events: {
    name: "NOAA Storm Events", what: "Property and crop damage, aggregated to month x state x event type on load",
    unit: "month-state-type cells", url: "https://www.ncei.noaa.gov/stormevents/",
  },
  noaa_billions: {
    name: "NOAA billion-dollar disasters", what: "US weather and climate disasters costing $1bn or more, CPI-adjusted (1980-2024)",
    unit: "events", url: "https://www.ncei.noaa.gov/access/billions/",
  },
  noaa_global_temp: {
    name: "NOAA Climate at a Glance", what: "Global land and ocean temperature departures from the 1901-2000 average",
    unit: "years", url: "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/",
  },
};

export function mountMethods(host: HTMLElement, data: AppData, store: Store) {
  ensureStyle();
  const meta = data.meta;
  const rowsOf = (k: string) => meta.sources.find((s) => s.source === k)?.rows ?? 0;

  // ---- (a) pipeline
  const stage = (tag: string, title: string, items: string[]) =>
    el("div", { class: "b-stage" }, el("div", { class: "b-tag", text: tag }), el("h4", { text: title }),
      el("ul", {}, ...items.map((t) => el("li", { text: t }))));
  const pipe = el("div", { class: "b-pipe", role: "list", "aria-label": "Data pipeline, from sources to this page" },
    stage("1 · Sources", "Public data", [
      "SEC EDGAR: XBRL facts, filing index, full-text search",
      "FRED: Treasury, BLS, BEA, EIA, Chicago Fed series",
      "Geopolitical Risk and policy-uncertainty indexes",
      "NOAA NCEI and OpenFEMA",
    ]),
    stage("2 · Postgres raw", "Loaded as received", [
      `${count(rowsOf("sec_companyfacts"))} XBRL facts, every filing kept`,
      `${count(rowsOf("sec_submissions"))} filings indexed`,
      `${count(rowsOf("efts"))} theme mentions`,
      `${count(rowsOf("fred") + rowsOf("gpr"))} macro observations`,
      `${count(rowsOf("fema") + rowsOf("noaa_storm_events") + rowsOf("noaa_billions"))} catastrophe records`,
    ]),
    stage("3 · Postgres core", "Standardized", [
      "fact_latest: the latest filed value of each period",
      "fact_quarter: 3-month values or year-to-date differences",
      "ranked XBRL tags with plausibility checks",
      `${data.panel.metrics.length} metrics per company-quarter; quarterly drivers`,
    ]),
    stage("4 · Models", "Python", [
      `PyMC hierarchical model: ${count(meta.panel.observations)} loss ratios, ${meta.panel.companies} carriers`,
      "investment sensitivities (shrinkage regressions)",
      "scenario engine and rolling backtest",
    ]),
    stage("5 · Export", "Static files", ["panel, drivers, disclosures, posterior draws and scenarios as JSON"]),
    stage("6 · This page", "d3 + TypeScript", ["no server: the scenario engine runs in your browser"]),
  );
  for (const s of pipe.children) s.setAttribute("role", "listitem");
  host.append(pipe);

  const grid = el("div", { class: "grid" });
  host.append(grid);

  // ---- (b) sources table
  const sc = card(grid, { title: "Sources", sub: `Rows loaded into Postgres; financials through ${quarterLabel(meta.dataThrough)}`, span: 12, id: "methods-sources" });
  const tbl = el("table");
  tbl.append(el("thead", {}, el("tr", {}, ...["Source", "Rows", "Loaded"].map((h) => el("th", { scope: "col", text: h })))));
  const tb = el("tbody");
  const known = Object.keys(SOURCE_INFO);
  const sources = [...meta.sources].sort((a, b) => known.indexOf(a.source) - known.indexOf(b.source));
  for (const s of sources) {
    const info = SOURCE_INFO[s.source];
    const name = info ? el("a", { href: info.url, text: info.name, rel: "noopener" }) : el("span", { text: s.source });
    tb.append(el("tr", {},
      el("th", { scope: "row" }, name, el("div", { class: "b-what", text: info?.what ?? "" })),
      el("td", { class: "n" }, el("div", { text: count(s.rows) }), el("div", { class: "b-what", text: info?.unit ?? "rows" })),
      el("td", { class: "n", text: s.loaded })));
  }
  tbl.append(tb);
  sc.body.append(el("div", { class: "b-sources" }, tbl));
  sc.root.querySelector(".tools")?.remove(); // the chart is already a table
  sc.caption.textContent = "Everything published here is public data. Stock-index and bond-spread series (S&P 500, "
    + "NASDAQ-100, VIX, Moody's and ICE spreads) are not collected at all because their owners restrict "
    + "redistribution: financial stress comes from the Chicago Fed NFCI, and the baseline equity return is a stated "
    + "assumption (2% a quarter with 8% volatility, about 8% and 16% a year).";

  // ---- (c) universe timeline
  const tc = card(grid, {
    title: "The universe, and what happened to it",
    sub: "Quarters with premium data in XBRL filings, by carrier; the marker shows the year it was acquired or stopped reporting",
    span: 12, id: "methods-universe",
  });
  statusKey(tc.legend);
  const comps = data.companies
    .filter((c) => (c.cohort === "specialty" || c.cohort === "benchmark") && c.firstQuarter)
    .sort((a, b) => SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment)
      || order(a) - order(b) || (a.firstQuarter ?? "").localeCompare(b.firstQuarter ?? "") || a.name.localeCompare(b.name));
  const lastQ = comps.reduce((m, c) => ((c.lastQuarter ?? "") > m ? c.lastQuarter! : m), "");
  const render = timeline({
    host: tc.body, store, companies: comps, groupOf: (c) => SEGMENT_SHORT[c.segment] ?? c.segment,
    start: "2008-01-01", end: endOfYear(lastQ), label: "Reporting span of every carrier in the universe, by segment and status",
  });
  tc.onRedraw(render);
  store.on(["selected"], () => { if (!tc.showingTable()) render(); });
  tc.setTable(() => ({
    columns: ["Company", "Segment", "Status", "Premium data", "10-K / 10-Q", "Note"],
    rows: comps.map((c) => [`${c.name} (${c.ticker})`, SEGMENT_SHORT[c.segment] ?? c.segment,
      c.status === "active" ? "active" : `${c.status}${c.statusYear ? ` ${c.statusYear}` : ""}`,
      `${quarterLabel(c.firstQuarter!)} – ${quarterLabel(c.lastQuarter!)}`, `${c.n10k} / ${c.n10q}`,
      [c.statusNote, c.note].filter(Boolean).join("; ")]),
    caption: "Universe and status",
  }));
  const in2010 = comps.filter((c) => c.cohort === "specialty" && (c.firstQuarter ?? "9") <= "2010-12-31" && (c.lastQuarter ?? "") >= "2010-03-31");
  const by = (s: Company["status"]) => in2010.filter((c) => c.status === s).length;
  tc.caption.textContent = `Survivorship: of the ${in2010.length} specialty carriers reporting in 2010, ${by("active")} are `
    + `still active, ${by("acquired")} were acquired and ${by("exited")} stopped reporting. Peer averages built only from `
    + "today's companies would describe the survivors, so carriers that were acquired or stopped reporting stay in "
    + "the data. The universe is hand-selected (rules in the Python source); it is not a census of every filer. Lighter bars "
    + "are groups whose consolidated figures are not comparable (see below).";

  // ---- (d) prose
  const pr = el("div", { class: "prose" });
  host.append(pr);
  const h = (t: string) => pr.append(el("h3", { text: t }));
  const p = (t: string) => pr.append(el("p", { text: t }));
  const ul = (items: string[]) => pr.append(el("ul", {}, ...items.map((t) => el("li", { text: t }))));
  const block = (cls: string, t: string) => pr.append(el("div", { class: cls, text: t }));

  h("The measures");
  ul([
    "Loss ratio: losses and loss-adjustment expenses incurred, net of reinsurance, over net premiums earned. Most views use the trailing four quarters, which smooths seasonal catastrophe swings.",
    "Accident-year loss ratio: losses for claims occurring in the current year only. Prior-year development is the change in the estimate for earlier years' claims; negative means reserves were released and flatters the calendar-year ratio.",
    "Expense ratio: acquisition-cost amortization plus other underwriting expenses, over premium. Carriers tag these items inconsistently, so each part comes from the quarterly XBRL tag when it passes a plausibility check, otherwise from the company's annual Schedule III (the insurance schedule every carrier files), otherwise from the income statement itself: (premium − losses + investment income − (pre-tax income − investment gains)) ÷ premium over four quarters. Each quarter records its source: quarterly, annual, mixed or implied.",
    "Combined ratio: loss ratio plus expense ratio; below 100% means an underwriting profit.",
    "Return on equity: net income over average shareholders' equity. Investment yield: annualized net investment income over average investments. Reserve leverage: net loss reserves over trailing premium.",
  ]);

  h("How the raw facts become quarters");
  ul([
    "Every fact is kept with the filing that reported it. For each company, tag and period the most recently filed value wins, so restatements replace the original figure.",
    "Quarters: a reported three-month value is used when one exists; otherwise the quarter is the difference of year-to-date values with the same start date (Q4 = full year − nine months). Fiscal quarters map to the nearest calendar quarter end; balance-sheet values must fall within 15 days of one.",
    "Each concept has a ranked list of XBRL tags, and a fallback tag is used only if it passes a check against premium: losses 15–250% of premium, prior-year development within ±100%, acquisition costs 0–60%, other underwriting expenses 2–30%. At least one filer tags acquisition costs with the wrong sign; values whose absolute size passes the check are sign-corrected and flagged.",
    "The model uses quarters with at least $15M of premium and a loss ratio between 5% and 250%, and carriers with at least six such quarters.",
  ]);
  const nc = data.companies.filter((c) => !c.comparable);
  if (nc.length) {
    p("Kept in the database but out of the model and the peer averages, because their consolidated lines mix in other business:");
    ul(nc.map((c) => `${c.name} (${c.ticker}): ${c.note ?? "not comparable"}.`));
  }

  h("The loss-ratio model");
  p("A Bayesian hierarchical regression, fitted with PyMC's NUTS sampler. Each carrier's quarterly loss ratio partially "
    + "adjusts toward its own long-run level, responds to three public drivers, and shares an industry-wide shock:");
  block("b-eq", "LR[i,t] = μ[i]·(1 − ρ[i]) + ρ[i]·A[i,t−1] + Σk β[i,k]·x[k,t] + λ[i]·f[t] + ε[i,t]\n"
    + "A[i,t−1] = mean of (LR[i,s] − λ[i]·f[s]) over the previous four quarters s\n"
    + "ε[i,t] ~ Student-t(ν = 5, 0, σ[i])        f ~ ZeroSumNormal(1) over quarters\n"
    + "μ[i], logit ρ[i], β[i,k], log λ[i] ~ Normal(segment mean, shared scale)   (non-centered)");
  ul([
    "A[i,t−1] is the carrier's attritional level: the average of its previous four quarterly loss ratios with the catastrophe component (λ·f) taken out, so a catastrophe quarter does not raise later forecasts. ρ is the persistence of that level and μ the long-run loss ratio when the drivers are at their 2010–2026 averages.",
    "The drivers x, standardized over the fitting window: litigation-cost inflation (producer prices of law offices, four-quarter mean), the geopolitical shock (log GPR minus its mean over the previous eight quarters) and financial conditions (Chicago Fed NFCI). β is in loss-ratio points per standard deviation. The segment means of β have a non-negative (half-normal) prior: these drivers should not lower loss ratios on average; single carriers can still deviate.",
    "f is the industry shock: a latent quarterly factor every carrier loads on with weight λ > 0. It sums to zero over the sample, which separates it from each carrier's level μ. Its largest values fall on the big catastrophe quarters, so λ works as an estimated catastrophe sensitivity, and the climate scenario acts through it.",
    "Partial pooling: μ, ρ, β and λ are drawn around segment means (E&S, diversified, Bermuda, niche, benchmark), so a carrier with a short history borrows strength from its peers. Student-t errors keep one bad quarter from dominating.",
    "Three candidate drivers were tested and dropped: a catastrophe index built from storm damage and FEMA declarations (the latent shock tracks insured catastrophes better), lagged insurance pricing (prices rise when loss costs rise, so its sign was confounded), and general CPI inflation (negative for Bermuda groups, because 2022-23 inflation coincided with a hard reinsurance market; forcing it positive made out-of-sample forecasts worse). Both confounds are the pricing cycle, which the model does not represent, so the scenarios carry no general-inflation channel.",
  ]);
  const d = data.model.diagnostics;
  pr.append(el("div", { class: "b-diag" },
    el("span", { text: `Largest R-hat ${d.max_r_hat.toFixed(3)}` }),
    el("span", { text: `Smallest bulk effective sample size ${Math.round(d.min_ess_bulk)}` }),
    el("span", { text: `${d.divergences} divergent transitions` }),
    el("span", { text: `${d.parameters_checked} parameters checked` }),
    el("span", { text: `Sampled in ${Math.round(d.seconds)} s` }),
    el("span", { text: `${data.model.draws} posterior draws per carrier power the stress lab` })));

  h("Investment sensitivities");
  ul([
    "Reinvestment speed: each quarter the portfolio yield closes a share κ of its gap to the 5-year Treasury yield (plus a company-specific spread), estimated by regression on each carrier's history.",
    "Rate and financial-conditions sensitivity of book value: other comprehensive income as a share of equity regressed on changes in the 5-year Treasury yield and in the NFCI.",
    "Estimates from short or noisy histories are shrunk toward the peer median in proportion to their standard error (empirical Bayes). For the NFCI term the spread of company estimates is no larger than their noise, so the shrinkage pools completely: every carrier gets the same value. The rate term and the reinvestment speed keep company differences.",
  ]);

  h("Scenarios and the simulation");
  ul([
    "Baseline: each underlying series follows an autoregressive model fitted from 2000; the 5-year yield follows a random walk; equity returns are an assumption (2% a quarter on average, 8% quarterly volatility); the industry shock is resampled from its own estimates for the same quarter of the year.",
    "Scenarios add shocks to the baseline in natural units (percentage points, log points, standard deviations of the industry shock), scaled linearly by the severity setting. The shocks are assumptions; how each carrier responds to them is estimated.",
    "Where the 2010–2026 data cannot identify a channel, a scenario carries an explicit overlay on the loss ratio, labeled as an assumption and weighted by the carrier's exposure: professional-lines claims (weighted by D&O and cyber disclosure), conflict losses (political-risk, war and trade-credit disclosure) and reserve strengthening (scaled by reserve leverage). The stress lab can switch overlays off.",
    `Each simulated quarter: the loss ratio from the model plus overlays; the combined ratio adds the carrier's recent expense ratio; premium grows with the scenario; net income is ${Math.round((1 - data.model.tax) * 100)}% of pre-tax underwriting, investment and other income (a flat ${Math.round(data.model.tax * 100)}% tax); book value moves with retained earnings and other comprehensive income. Capital generated is cumulative net income plus other comprehensive income, before distributions.`,
  ]);

  h("Limitations");
  ul([
    "Consolidated figures: a group's premium and losses include every line it writes (Arch's includes mortgage insurance), so ratios describe the whole company, not its specialty book.",
    "Expense ratios rebuilt from XBRL tags can differ from the ratios companies report by a few points, because the available tags sometimes include non-underwriting costs.",
    "No market prices: free price sources need an API key or a browser session, and index owners restrict redistribution, so valuation (price-to-book) is out of scope.",
    "The backtest uses latest-filed values, not values as first reported, which gives it a small look-ahead advantage on restated quarters.",
    "Disclosure shares measure how much a filing discusses a theme, not how exposed the company is.",
    "Scenario results are hypothetical stress tests, not predictions, and nothing here is investment advice.",
  ]);

  h("Reproduce it");
  block("b-cmd", [
    "./scripts/init-env.sh                   # .env with a random database password (mode 600, gitignored)",
    "docker compose up -d                    # Postgres 17 on 127.0.0.1:5544",
    "uv sync                                 # Python 3.13 environment from uv.lock",
    "uv run python -m sil migrate            # schema",
    "uv run python -m sil ingest             # every public source (cached under data/cache)",
    "uv run python -m sil export             # standardize, fit, simulate, write dashboard/public/data",
    "uv run python -m sil.model.backtest     # rolling-origin backtest -> backtest.json",
    "cd dashboard && npm ci && npm run build # this page",
  ].join("\n"));
}

function order(c: Company): number {
  return c.status === "active" ? 0 : c.status === "acquired" ? 1 : 2;
}

function endOfYear(iso: string): string {
  return iso ? `${iso.slice(0, 4)}-12-31` : "2026-12-31";
}

function statusKey(host: HTMLElement) {
  host.replaceChildren();
  for (const st of ["active", "acquired", "exited"] as const) {
    const s = STATUS_STYLE[st];
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "30");
    svg.setAttribute("height", "12");
    svg.setAttribute("aria-hidden", "true");
    const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bar.setAttribute("x", "0");
    bar.setAttribute("y", "2");
    bar.setAttribute("width", "20");
    bar.setAttribute("height", "8");
    bar.setAttribute("rx", "4");
    bar.style.fill = s.color;
    svg.append(bar);
    if (st !== "active") {
      const ic = document.createElementNS("http://www.w3.org/2000/svg", "path");
      ic.setAttribute("d", iconPath(s.icon, 24, 6, 5));
      if (s.icon === "cross") {
        ic.style.stroke = s.color;
        ic.style.strokeWidth = "2.5";
        ic.style.fill = "none";
      } else {
        ic.style.fill = s.color;
        ic.style.stroke = "var(--surface)";
        ic.style.strokeWidth = "2";
      }
      svg.append(ic);
    }
    host.append(el("span", { class: "key b-status" }, svg, el("span", { text: s.label })));
  }
}
