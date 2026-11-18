// Company deep dive: where the selected carrier's combined ratio comes from, what the model estimated about it,
// and its SEC filing record.
import type { AppData, Company, Num } from "../types";
import type { Store } from "../state";
import { card, el, legend, tiles, type Tile } from "../ui";
import { SEGMENT_SHORT, latestValue, series } from "../data";
import { decompChart, type DecompRow } from "../charts/decomp";
import { forestChart, type ForestRow } from "../charts/forest";
import { lineChart } from "../charts/lines";
import { columnChart } from "../charts/columns";
import { count, money, num, pct, pts, quarterLabel, times } from "../format";

const INCORPORATION: Record<string, string> = { D0: "Bermuda", E9: "Cayman Islands", V8: "Switzerland" };

const SENS: { key: string; label: string; group: string }[] = [
  { key: "lam", label: "Catastrophe (industry shock)", group: "Catastrophes" },
  { key: "beta:social", label: "Social inflation", group: "Macro drivers" },
  { key: "beta:geo", label: "Geopolitical shock", group: "Macro drivers" },
  { key: "beta:finstress", label: "Financial stress", group: "Macro drivers" },
];

export function mountCompany(host: HTMLElement, data: AppData, store: Store) {
  const quarters = data.panel.quarters;
  const ident = el("div", { class: "note" });
  const tileHost = el("div");
  host.append(ident, el("div", { style: "height:12px" }), tileHost, el("div", { style: "height:16px" }));
  const grid = el("div", { class: "grid" });
  host.append(grid);
  const company = (): Company => data.byCik.get(store.get().selected) ?? data.companies[0];

  // ---------------------------------------------------------------- identity + tiles
  const renderIdent = () => {
    const c = company();
    const inc = c.incorporated ? `${c.incorporated}${INCORPORATION[c.incorporated] ? ` (${INCORPORATION[c.incorporated]})` : ""}` : "–";
    const L0 = c.listing;
    const status = c.status !== "active"
      ? `${c.status === "acquired" ? "Acquired" : "Stopped filing"} ${c.statusYear ?? ""}${c.statusNote ? ` — ${c.statusNote}` : ""}`
      : L0?.derived === "pending"
        ? `Active SEC filer, deal pending (filed: ${L0.pendingForms ?? "deal documents"})`
        : "Active SEC filer"
          + (L0?.lastChangeOfControl && L0.lastChangeOfControl >= `${Number(L0.checkedOn.slice(0, 4)) - 1}`
            ? ` · change of control reported ${L0.lastChangeOfControl} (8-K item 5.01)` : "");
    ident.replaceChildren(
      el("strong", { text: `${c.name} (${c.ticker})` }), " · ", SEGMENT_SHORT[c.segment] ?? c.segment, " · ", status,
      el("br"),
      `SEC name: ${c.secName ?? "–"} · incorporated: ${inc} · CIK ${c.cik} · ${count(c.filings)} filings `
        + `(${count(c.n10k)} 10-K, ${count(c.n10q)} 10-Q) from ${c.firstFiling ?? "–"} to ${c.lastFiling ?? "–"} · `,
      el("a", { href: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(c.cik).padStart(10, "0")}`, text: "EDGAR filings index", rel: "noopener" }),
    );
    if (c.note) ident.append(el("span", { text: ` · Note: ${c.note}` }));
    const L = (m: string) => latestValue(data, c.cik, m);
    const cr = L("combined_ratio_ttm");
    const i = cr.q ? quarters.indexOf(cr.q) : -1;
    const crPrev = i >= 4 ? series(data, c.cik, "combined_ratio_ttm")[i - 4] : null;
    const npe = L("npe_ttm");
    const ay = L("cy_loss_ratio_ttm");
    const pyd = L("pyd_ratio_ttm");
    const roe = L("roe_ttm");
    const g = L("npe_growth_yoy");
    const res = L("reserve_to_npe");
    const basis = cr.q ? (data.panel.series[String(c.cik)]?.expense_basis?.[quarters.indexOf(cr.q)] as string | null) : null;
    const list: Tile[] = [
      { label: `Net premiums earned, TTM ${npe.q ? quarterLabel(npe.q) : ""}`, value: money(npe.v) },
      {
        label: "Combined ratio, TTM", value: pct(cr.v),
        delta: crPrev != null && cr.v != null ? `${pts(cr.v - crPrev)} vs a year earlier` : basis === "none" || cr.v == null ? "Expense tags not comparable" : undefined,
        tone: crPrev != null && cr.v != null ? (cr.v > crPrev ? "up-bad" : "down-good") : "",
      },
      { label: "Accident-year loss ratio, TTM", value: pct(ay.v) },
      { label: "Prior-year development, TTM", value: pts(pyd.v), delta: pyd.v == null ? undefined : pyd.v < 0 ? "Favorable" : "Adverse", tone: pyd.v == null ? "" : pyd.v < 0 ? "down-good" : "up-bad" },
      { label: "Return on equity, TTM", value: pct(roe.v) },
      { label: "Premium growth, TTM", value: pct(g.v) },
      { label: "Reserve leverage", value: times(res.v), title: "Net loss reserves over trailing premium" },
    ];
    tiles(tileHost, list);
  };

  // ---------------------------------------------------------------- decomposition by year
  const dCard = card(grid, { title: "", span: 8, id: "co-decomp" });
  legend(dCard.legend, [
    { label: "Accident-year loss ratio", color: "var(--s1)", shape: "box" },
    { label: "Expense ratio", color: "var(--s3)", shape: "box" },
    { label: "Adverse reserve development", color: "var(--div-pos)", shape: "box" },
    { label: "Favorable reserve development", color: "var(--div-neg)", shape: "box" },
    { label: "Combined ratio", color: "var(--ink)", shape: "dot" },
  ]);
  const decompRows = (): DecompRow[] => {
    const c = company();
    const s = (m: string) => series(data, c.cik, m);
    const basis = data.panel.series[String(c.cik)]?.expense_basis ?? [];
    const out: DecompRow[] = [];
    quarters.forEach((q, i) => {
      if (q.slice(5, 7) !== "12" || q < "2010-01-01") return;
      const r: DecompRow = { label: q.slice(0, 4), ay: s("cy_loss_ratio_ttm")[i] as Num, pyd: s("pyd_ratio_ttm")[i] as Num,
        er: s("expense_ratio_ttm")[i] as Num, cr: s("combined_ratio_ttm")[i] as Num, basis: basis[i] as string | null };
      if (r.ay != null || r.cr != null) out.push(r);
    });
    const lastCr = latestValue(data, c.cik, "loss_ratio_ttm");
    if (lastCr.q && lastCr.q.slice(5, 7) !== "12") {
      const i = quarters.indexOf(lastCr.q);
      out.push({ label: `TTM ${quarterLabel(lastCr.q)}`, ay: s("cy_loss_ratio_ttm")[i] as Num, pyd: s("pyd_ratio_ttm")[i] as Num,
        er: s("expense_ratio_ttm")[i] as Num, cr: s("combined_ratio_ttm")[i] as Num, basis: basis[i] as string | null });
    }
    return out;
  };
  const decomp = decompChart({ card: dCard, label: "Combined ratio decomposition by year", getRows: decompRows });

  // ---------------------------------------------------------------- model estimates
  const fCard = card(grid, { title: "What the model estimated", span: 4, id: "co-forest",
    sub: "Loss-ratio points per one standard deviation of each driver · 89% intervals · gray = every other carrier" });
  const forest = forestChart({
    card: fCard, label: "Estimated sensitivities of the loss ratio", fmt: (v) => num(v * 100, 1), axisLabel: "loss-ratio points per 1 sd",
    getRows: (): ForestRow[] => {
      const c = company();
      return SENS.map((s) => ({
        key: s.key, label: s.label, group: s.group,
        est: c.model?.[s.key] && c.model[s.key][0] != null ? (c.model[s.key] as [number, number, number]) : null,
        peers: data.companies.filter((p) => p.cik !== c.cik && p.model?.[s.key]?.[0] != null).map((p) => p.model![s.key][0] as number),
      }));
    },
  });
  const fExtra = el("div", { class: "legend" });
  fCard.root.insertBefore(fExtra, fCard.root.querySelector("figcaption"));

  // ---------------------------------------------------------------- quarterly volatility
  const qCard = card(grid, { title: "", span: 8, id: "co-quarterly" });
  legend(qCard.legend, [
    { label: "Combined ratio", color: "var(--s1)" }, { label: "Loss ratio", color: "var(--s2)" },
    { label: "Accident-year loss ratio", color: "var(--s3)" },
  ]);
  const qLines = lineChart({
    card: qCard, store, quarters, height: 280, label: "Quarterly ratios of the selected company", fmt: (v) => pct(v),
    getFrom: () => store.get().from, getRef: () => ({ value: 1, label: "100%" }), clipQuantiles: [0, 1],
    getSeries: () => {
      const c = company();
      return [
        { id: "cr", label: "Combined", values: series(data, c.cik, "combined_ratio"), role: "ref", color: "var(--s1)" },
        { id: "lr", label: "Loss", values: series(data, c.cik, "loss_ratio"), role: "ref", color: "var(--s2)" },
        { id: "ay", label: "Accident-yr", values: series(data, c.cik, "cy_loss_ratio"), role: "ref", color: "var(--s3)" },
      ];
    },
  });

  // ---------------------------------------------------------------- filing record
  const filCard = card(grid, { title: "Filing record", span: 4, id: "co-filings", sub: "SEC filings per year, from the EDGAR index" });
  legend(filCard.legend, [
    { label: "10-K / 10-Q", color: "var(--s1)", shape: "box" }, { label: "8-K", color: "var(--s2)", shape: "box" },
    { label: "Insider (Forms 3/4/5)", color: "var(--s3)", shape: "box" }, { label: "Proxy and other", color: "var(--s4)", shape: "box" },
  ]);
  const filYears = () => {
    const c = company();
    const ys = Object.keys(c.filingsByYear ?? {}).map(Number).filter((y) => y >= 2001).sort((a, b) => a - b);
    return { c, ys };
  };
  const filChart = columnChart({
    card: filCard, label: "Filings per year by type", height: 220, fmt: (v) => count(v),
    get periods() { return filYears().ys.map((y) => (y % 5 === 0 ? String(y) : "")); },
    tickEvery: 1,
    getSeries: () => {
      const { c, ys } = filYears();
      const k = (y: number, keys: string[]) => keys.reduce((a, kk) => a + (c.filingsByYear?.[String(y)]?.[kk] ?? 0), 0);
      return [
        { key: "periodic", label: "10-K / 10-Q", color: "var(--s1)", values: ys.map((y) => k(y, ["annual", "quarterly"])) },
        { key: "current", label: "8-K", color: "var(--s2)", values: ys.map((y) => k(y, ["current"])) },
        { key: "insider", label: "Insider", color: "var(--s3)", values: ys.map((y) => k(y, ["insider"])) },
        { key: "other", label: "Proxy and other", color: "var(--s4)", values: ys.map((y) => k(y, ["proxy", "other"])) },
      ];
    },
    title: (i) => String(filYears().ys[i]),
  } as Parameters<typeof columnChart>[0]);
  const recentHost = el("div", { class: "table-view", style: "margin-top:10px;max-height:220px" });
  filCard.root.insertBefore(recentHost, filCard.root.querySelector("figcaption"));

  const chrome = () => {
    const c = company();
    renderIdent();
    dCard.setTitle(`Where ${c.ticker}'s combined ratio comes from`, "Each year: accident-year losses + expenses (column), reserve development (thin bar), combined ratio (dot)");
    dCard.caption.textContent = "Fiscal-year values are trailing four quarters at Q4. Combined ratio = accident-year loss ratio + prior-year "
      + "development + expense ratio; a gap means a component was not tagged comparably that year.";
    dCard.setTable(() => ({
      columns: ["Year", "Accident-year LR", "Prior-year dev.", "Expense ratio", "Combined ratio", "Expense source"],
      rows: decompRows().map((r) => [r.label, pct(r.ay), pts(r.pyd), pct(r.er), pct(r.cr), r.basis ?? "–"]),
    }));
    const mdl = c.model;
    const mu = mdl?.mu;
    const rho = mdl?.rho;
    fExtra.replaceChildren(el("span", {
      text: mu?.[0] != null
        ? `Long-run loss ratio ${pct(mu[0])} (${pct(mu[1])}–${pct(mu[2])}) · persistence ${num(rho?.[0] ?? null, 2)} · `
          + `rate sensitivity of book value ${c.investment?.d_rate != null ? pct(c.investment.d_rate) + " per +1 pt in 5-year yields" : "–"} · `
          + `disclosure exposure: geopolitical ${num(c.exposure?.geo ?? null, 2)}, professional lines ${num(c.exposure?.prof ?? null, 2)}`
        : "Not in the model: too few comparable quarters.",
    }));
    fCard.setTable(() => ({
      columns: ["Driver", "Estimate (pts per sd)", "89% low", "89% high"],
      rows: SENS.map((s) => {
        const e = c.model?.[s.key];
        return [s.label, e?.[0] != null ? num(e[0] * 100, 2) : "–", e?.[1] != null ? num(e[1] * 100, 2) : "–", e?.[2] != null ? num(e[2] * 100, 2) : "–"];
      }),
    }));
    qCard.setTitle(`${c.ticker} quarter by quarter`, "Single-quarter ratios: catastrophe quarters and reserve actions show up here before the trailing averages");
    qCard.setTable(() => ({
      columns: ["Quarter", "Combined", "Loss", "Accident-year"],
      rows: quarters.map((q, i) => [quarterLabel(q), pct(series(data, c.cik, "combined_ratio")[i] as Num),
        pct(series(data, c.cik, "loss_ratio")[i] as Num), pct(series(data, c.cik, "cy_loss_ratio")[i] as Num)]).filter((r) => r[2] !== "–"),
    }));
    filCard.setTable(() => {
      const { ys } = filYears();
      return {
        columns: ["Year", "10-K/10-Q", "8-K", "Insider", "Other"],
        rows: ys.map((y) => {
          const f = c.filingsByYear?.[String(y)] ?? {};
          return [String(y), String((f.annual ?? 0) + (f.quarterly ?? 0)), String(f.current ?? 0), String(f.insider ?? 0), String((f.proxy ?? 0) + (f.other ?? 0))];
        }),
      };
    });
    const rows = (c.recentFilings ?? []).slice(0, 8);
    const t = el("table");
    t.append(el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Latest filings" }), el("th", { scope: "col", text: "Period" }), el("th", { scope: "col", text: "Filed" }))));
    const tb = el("tbody");
    for (const r of rows) {
      tb.append(el("tr", {}, el("td", {}, el("a", { href: r.url, rel: "noopener", text: r.form })), el("td", { text: r.period ?? "–" }), el("td", { text: r.filed })));
    }
    t.append(tb);
    recentHost.replaceChildren(t);
  };

  chrome();
  store.on(["selected"], () => { chrome(); decomp.redraw(); forest.redraw(); qLines.redraw(); filChart.redraw(); });
  store.on(["from"], () => qLines.redraw());
}
