// Mergers and acquisitions: who bought the carriers that left the public market, at what price and multiple of
// book, how long the deals took, how the listed universe shrank and grew, and what the carriers bought themselves.
// Every deal field shown was found in the target's own SEC filings (sil/ma.py); every title is computed here.
import type { AppData } from "../types";
import type { Store } from "../state";
import type { MaData, MaDeal } from "../domains/ma";
import { card, el, legend, tiles } from "../ui";
import { median, visibleCompanies } from "../data";
import { count, money, pct, times } from "../format";
import { dealTimeline } from "../charts/ma-timeline";
import { dealScatter } from "../charts/ma-scatter";
import { consolidationChart } from "../charts/ma-consolidation";
import { spendChart } from "../charts/ma-spend";
import { buyerChart, buyerRows } from "../charts/ma-buyers";
import { GROUPS, GROUP_HELP, earlierLabel, groupColor, priceLabel } from "../charts/ma-style";
import { rankBars } from "../charts/rankbars";
import "./ma.css";

const EXIT_ORDER = [...GROUPS, "Stopped reporting"];
const EXIT_LABEL: Record<string, string> = {
  "US insurer": "Bought by a US insurer",
  "Japanese insurer": "Bought by a Japanese insurer",
  "Other non-US insurer": "Bought by another non-US insurer",
  "Private capital": "Bought by private capital",
  "Stopped reporting": "Stopped reporting, no buyer",
};

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
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
  return sxy / Math.sqrt(sxx * syy);
}

function intro(d: AppData): string {
  const m = d.ma;
  if (!m) return "Deals, consolidation and acquisition activity of the universe.";
  const closed = m.deals.filter((x) => x.status === "closed");
  const first = closed.map((x) => x.closed ?? "").filter(Boolean).sort()[0]?.slice(0, 4) ?? "";
  return `Every deal that took a carrier of the universe off the public market since ${first}, the take-privates `
    + "pending now, and what the carriers bought themselves. Buyer, price and form of payment are shown only where "
    + "SEC full-text search found them in the target's own filings: the buyer's name and the price in the same "
    + "document. Dates come from the filing index; values and multiples from the targets' XBRL facts.";
}

function mount(host: HTMLElement, data: AppData, store: Store): void {
  const m = data.ma;
  if (!m) {
    host.append(el("p", { class: "empty", text: "The M&A data has not been exported yet (python -m sil domains ma)." }));
    return;
  }
  const ma: MaData = m;
  const tickerOf = (cik: number) => data.byCik.get(cik)?.ticker ?? String(cik);
  const canFocus = (cik: number) => !!data.byCik.get(cik)?.comparable;
  const closedAll = ma.deals.filter((d) => d.status === "closed");
  const pendingAll = ma.deals.filter((d) => d.status === "pending");
  const visibleDeals = (): MaDeal[] => {
    const segs = store.get().segments;
    return ma.deals.filter((d) => segs.includes(d.segment))
      .sort((a, b) => (a.status === b.status ? (a.announced ?? "").localeCompare(b.announced ?? "") : a.status === "pending" ? 1 : -1));
  };

  // ---------------------------------------------------------------- tiles
  const nonUs = closedAll.filter((d) => d.group === "Japanese insurer" || d.group === "Other non-US insurer");
  const values = closedAll.filter((d) => d.value != null).sort((a, b) => (b.value as number) - (a.value as number));
  const pbs = closedAll.map((d) => d.pb).filter((v): v is number => v != null).sort((a, b) => a - b);
  const days = closedAll.filter((d) => d.days != null).sort((a, b) => (a.days as number) - (b.days as number));
  const L = ma.listed;
  const tileHost = el("div");
  host.append(tileHost);
  tiles(tileHost, [
    { label: `Carriers acquired, ${closedAll.map((d) => d.closed?.slice(0, 4)).filter(Boolean).sort()[0]}–${ma.asOf.slice(0, 4)}`,
      value: count(closedAll.length), delta: `${nonUs.length} by insurers from outside the US` },
    { label: "Implied equity value", value: money(values.reduce((a, d) => a + (d.value as number), 0)),
      delta: values[0] ? `Largest: ${values[0].target} by ${values[0].acquirer} (${money(values[0].value)})` : "",
      title: "Deal price per share times shares outstanding before the announcement" },
    { label: "Median price / book", value: times(median(pbs)),
      delta: pbs.length ? `${times(pbs[0])} to ${times(pbs[pbs.length - 1])} across ${pbs.length} deals` : "" },
    { label: "Median time to close", value: `${median(days.map((d) => d.days as number)) ?? "–"} days`,
      delta: days.length ? `${days[0].ticker} ${days[0].days} · ${days[days.length - 1].ticker} ${days[days.length - 1].days}` : "",
      title: "From the first filing stating the terms to the closing 8-K or delisting" },
    { label: "Listed specialty carriers", value: count(L.count[L.count.length - 1]),
      delta: `${L.count[0]} at the end of ${L.years[0]}` },
    { label: "Take-privates pending", value: count(pendingAll.length),
      delta: pendingAll.map((d) => d.target).join(", ") || "none" },
  ]);
  host.append(el("div", { style: "height:16px" }));
  const grid = el("div", { class: "grid" });
  host.append(grid);
  const groupLegend = (c: { legend: HTMLElement }, withPending = false) => legend(c.legend, [
    ...GROUPS.map((g) => ({ label: g, color: groupColor(g), shape: "box" as const })),
    ...(withPending ? [{ label: "Pending (buyer in the proxy)", color: groupColor("Buyer not yet identified"), shape: "box" as const }] : []),
  ]);

  // ---------------------------------------------------------------- deal timeline
  const t = card(grid, {
    title: `${closedAll.length} carriers bought out since ${closedAll.map((d) => d.announced?.slice(0, 4)).filter(Boolean).sort()[0]}; `
      + `${pendingAll.length} take-private${pendingAll.length === 1 ? "" : "s"} pending`,
    sub: "From the first filing that states the deal terms to the closing (8-K item 5.01 or the delisting), by buyer",
    span: 12, id: "ma-timeline",
  });
  groupLegend(t, true);
  const tBody = el("div");
  t.body.append(tBody);
  const drawTimeline = () => {
    if (t.showingTable()) return;
    dealTimeline({ host: t.body, store, label: "Deal timeline", asOf: ma.asOf, getDeals: visibleDeals, canFocus });
  };
  t.onRedraw(drawTimeline);
  drawTimeline();
  const nAcq = closedAll.filter((d) => d.verified.acquirer).length;
  const nPrice = closedAll.filter((d) => d.verified.price).length;
  const nPay = closedAll.filter((d) => d.verified.consideration).length;
  const mixed = closedAll.filter((d) => d.consideration === "mixed").map((d) => d.ticker);
  t.caption.textContent = `Checked against the targets' own filings with SEC full-text search: the buyer's name and the price `
    + `in the same document for ${nAcq} of ${closedAll.length} deals, the price per share for ${nPrice}`
    + `${mixed.length ? ` (${mixed.join(" and ")} paid in stock and cash: their exchange terms are checked instead)` : ""}, `
    + `the form of payment for ${nPay}. A white tick on a bar marks the merger proxy; the dotted line is today. `
    + (ma.documentsRead ? `Terms also read from ${ma.documentsRead} deal documents.` : "Pending buyers come from the merger proxies once those documents are read.");
  t.setTable(() => ({
    columns: ["Target", "Buyer", "Buyer type", "Announced", "Closed", "Days", "Price", "Implied value", "Price / book", "Found in filings"],
    rows: visibleDeals().map((d) => [
      `${d.target} (${d.ticker})`, d.acquirer ?? (d.status === "pending" ? "pending" : "not verified"), d.acquirerType ?? "–",
      d.announced ?? "–", d.closed ?? (d.status === "pending" ? "pending" : "–"), d.days != null ? String(d.days) : "–",
      priceLabel(d) + (earlierLabel(d) ? ` (${earlierLabel(d)})` : ""), money(d.value), times(d.pb),
      d.checks.map((c) => `${c.field.replace("earlier_price:", "earlier ")} ${c.hits}`).join(", ") || "–",
    ]),
  }));

  // ---------------------------------------------------------------- who bought
  const rowsAll = buyerRows(closedAll);
  const byValue = [...rowsAll].sort((a, b) => b.value - a.value);
  const byPb = rowsAll.filter((r) => r.medianPb != null && r.deals.length >= 2).sort((a, b) => (b.medianPb as number) - (a.medianPb as number));
  const totalValue = rowsAll.reduce((a, r) => a + r.value, 0) || 1;
  const lowPb = byPb[byPb.length - 1];
  const buyerTitle = byPb.length < 2 ? "Who bought"
    : (byPb[0].medianPb as number) - (byPb[1].medianPb as number) < 0.1
      ? `${byPb[0].group}s and ${byPb[1].group.toLowerCase().replace("us ", "US ")}s paid about ${times(((byPb[0].medianPb as number) + (byPb[1].medianPb as number)) / 2, 1)} book; `
        + `${lowPb.group.toLowerCase()} paid ${times(lowPb.medianPb)}`
      : `${byPb[0].group}s paid the most: median ${times(byPb[0].medianPb)} book; ${lowPb.group.toLowerCase()} ${times(lowPb.medianPb)}`;
  const b = card(grid, {
    title: buyerTitle,
    sub: "Deals by buyer group: implied equity value, number of deals, median price-to-book", span: 5, id: "ma-buyers",
  });
  const buyers = buyerChart({ card: b, label: "Deal value by buyer group", getRows: () => buyerRows(visibleDeals()) });
  b.caption.textContent = `Share of the value: ${byValue.map((r) => `${r.group} ${pct(r.value / totalValue, 0)}`).join(" · ")}. `
    + GROUPS.map((g) => `${g}: ${GROUP_HELP[g]}`).join(". ") + ".";
  b.setTable(() => ({
    columns: ["Buyer group", "Deals", "Implied value", "Median price / book", "Targets"],
    rows: buyerRows(visibleDeals()).map((r) => [r.group, String(r.deals.length), money(r.value), times(r.medianPb),
      r.deals.map((d) => d.ticker).join(", ")]),
  }));

  // ---------------------------------------------------------------- valuation vs performance
  const withBoth = closedAll.filter((d) => d.pb != null && d.roe != null);
  const r = withBoth.length > 3 ? pearson(withBoth.map((d) => d.roe as number), withBoth.map((d) => d.pb as number)) : NaN;
  const hiRoe = withBoth.filter((d) => (d.roe as number) >= 0.1).map((d) => d.pb as number);
  const loRoe = withBoth.filter((d) => (d.roe as number) < 0.1).map((d) => d.pb as number);
  const s = card(grid, {
    title: Number.isFinite(r) && r > 0.3
      ? `Profitable targets fetched higher multiples: ${times(median(hiRoe))} book at a 10%+ ROE, ${times(median(loRoe))} below`
      : `Profitability explains little of the price (r = ${Number.isFinite(r) ? r.toFixed(2) : "–"})`,
    sub: "Price-to-book at the deal price against the target's trailing return on equity; dot area = implied equity value",
    span: 7, id: "ma-valuation",
  });
  groupLegend(s);
  const scatter = dealScatter({ card: s, store, label: "Price to book against target ROE", getDeals: visibleDeals, canFocus });
  const below = withBoth.filter((d) => (d.pb as number) < 1).map((d) => d.ticker);
  const extreme = withBoth.filter((d) => (d.roe as number) < -0.3).map((d) => `${d.ticker} (ROE ${pct(d.roe)})`);
  s.caption.textContent = `Correlation across ${withBoth.length} deals: r = ${Number.isFinite(r) ? r.toFixed(2) : "–"}. `
    + `Bought below book: ${below.join(", ") || "none"}. Book value per share = common equity (total equity less preferred `
    + `stock) over shares outstanding at the last quarter before the announcement`
    + `${extreme.length ? `; ${extreme.join(", ")} sits on the left edge` : ""}. `
    + `Deals without a published multiple: ${closedAll.filter((d) => d.pb == null).map((d) => d.ticker).join(", ") || "none"} (see the table).`;
  s.setTable(() => ({
    columns: ["Target", "Buyer group", "Price / book", "Target ROE (TTM)", "Combined ratio (TTM)", "Book quarter", "Value basis"],
    rows: visibleDeals().filter((d) => d.status === "closed").map((d) => [d.target, d.group, times(d.pb), pct(d.roe), pct(d.cr),
      d.bookQuarter ?? "–", d.valueBasis ?? "–"]),
  }));

  // ---------------------------------------------------------------- consolidation
  const nEntries = L.entries.reduce((a, e) => a + e.length, 0);
  const exitsAll = L.exits.flat();
  const dealExits = exitsAll.filter((e) => e.deal).length;
  const c = card(grid, {
    title: `${L.count[0]} listed carriers in ${L.years[0]}, ${L.count[L.count.length - 1]} now: ${dealExits} bought out, `
      + `${exitsAll.length - dealExits} stopped reporting, ${nEntries} listed`,
    sub: "Specialty carriers of the universe listed at each year-end, and each year's listings and exits by buyer",
    span: 6, id: "ma-consolidation",
  });
  legend(c.legend, [{ label: "Listed (IPO or relisting)", color: "var(--context-strong)", shape: "box" },
    ...EXIT_ORDER.map((g) => ({ label: EXIT_LABEL[g] ?? g, color: groupColor(g), shape: "box" as const }))]);
  consolidationChart({ card: c, label: "Listed specialty carriers and their listings and exits", data: ma, tickerOf, exitOrder: EXIT_ORDER });
  const ipoTickers = L.entries.flat().map(tickerOf);
  c.caption.textContent = `Listings since ${L.years[0]}: ${ipoTickers.join(", ")}. The universe is hand-selected (see Data & methods), `
    + `so these counts describe it, not every US-listed carrier. A listing is the IPO prospectus (424B4) or the exchange `
    + `registration; an exit is the deal's closing or the delisting (Form 25).`;
  c.setTable(() => ({
    columns: ["Year", "Listed at year-end", "Listed that year", "Exits that year"],
    rows: L.years.map((y, i) => [String(y), String(L.count[i]), L.entries[i].map(tickerOf).join(", ") || "–",
      L.exits[i].map((e) => `${tickerOf(e.cik)} (${e.group})`).join(", ") || "–"]),
  }));

  // ---------------------------------------------------------------- acquisitions by the carriers
  const A = ma.activity;
  const series = (cik: number, f: "acq" | "giEq" | "gw" | "intang" | "eq") => A.series[String(cik)]?.[f] ?? [];
  const visible = () => visibleCompanies(data, store.get().segments, store.get().historical);
  const totals = () => A.years.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (const co of visible()) {
      const v = series(co.cik, "acq")[i];
      if (v != null) { sum += v * 1e6; n++; }
    }
    return n ? sum : null;
  });
  const top = (i: number) => visible().map((co) => ({ name: co.name, value: (series(co.cik, "acq")[i] ?? 0) * 1e6 }))
    .filter((d) => d.value > 0).sort((a, b2) => b2.value - a.value).slice(0, 3);
  const tot0 = totals();
  let peak = -1;
  tot0.forEach((v, i) => {
    if (v != null && (peak < 0 || v > (tot0[peak] ?? 0))) peak = i;
  });
  const sum0 = tot0.reduce((a: number, v) => a + (v ?? 0), 0);
  const sp = card(grid, {
    title: peak >= 0 ? `$${(sum0 / 1e9).toFixed(1)}B spent on acquisitions since ${A.years[0]}; the peak was ${A.years[peak]} `
      + `(${top(peak)[0]?.name ?? "–"} ${money(top(peak)[0]?.value)})` : "Cash paid for acquisitions",
    sub: "Cash paid for acquired businesses, net of the cash they held, by fiscal year; the company in focus as a dot",
    span: 6, id: "ma-spend",
  });
  legend(sp.legend, [{ label: "All visible carriers", color: "var(--context-strong)", shape: "box" },
    { label: "Company in focus", color: "var(--s1)", shape: "dot" }]);
  const spend = spendChart({
    card: sp, label: "Cash paid for acquisitions by fiscal year", years: A.years, getTotals: totals, getTop: top,
    getFocus: () => {
      const co = data.byCik.get(store.get().selected);
      return co ? { name: co.name, values: series(co.cik, "acq").map((v) => (v == null ? null : v * 1e6)) } : null;
    },
  });
  sp.caption.textContent = "XBRL tag PaymentsToAcquireBusinessesNetOfCashAcquired (or the gross or affiliate variants), from "
    + "each 10-K; it covers every business bought, inside insurance or not. A negative year means the businesses bought "
    + "held more cash than was paid for them. Values implausible against the buyer's own equity are dropped as tagging errors.";
  sp.setTable(() => ({
    columns: ["Fiscal year", "All visible carriers", "Largest buyers"],
    rows: A.years.map((y, i) => [String(y), money(totals()[i]), top(i).map((d) => `${d.name} ${money(d.value)}`).join("; ") || "–"]),
  }));

  // ---------------------------------------------------------------- goodwill and intangibles
  const giItems = () => {
    const out = [];
    for (const co of visible()) {
      const gi = series(co.cik, "giEq");
      for (let i = gi.length - 1; i >= Math.max(0, gi.length - 3); i--) {
        if (gi[i] != null) {
          const gw = series(co.cik, "gw")[i];
          const ig = series(co.cik, "intang")[i];
          const eq = series(co.cik, "eq")[i];
          out.push({ id: co.cik, label: co.ticker, name: `${co.name} (${co.ticker})`, value: gi[i] as number,
            note: `Fiscal ${A.years[i]}: goodwill ${money(gw == null ? null : gw * 1e6)}, other intangibles `
              + `${money(ig == null ? null : ig * 1e6)}, equity ${money(eq == null ? null : eq * 1e6)}` });
          break;
        }
      }
    }
    return out;
  };
  const gi0 = giItems().sort((a, b2) => b2.value - a.value);
  const g = card(grid, {
    title: gi0.length ? `Built by acquisition: ${gi0[0].name.replace(/ \(.*/, "")} carries ${pct(gi0[0].value, 0)} of its equity in goodwill and intangibles`
      : "Goodwill and intangibles relative to equity",
    sub: "Goodwill plus other intangible assets, as a share of shareholders' equity, latest fiscal year",
    span: 6, id: "ma-goodwill",
  });
  const goodwill = rankBars({ card: g, store, label: "Goodwill and intangibles / equity", fmt: (v) => pct(v, 0), getItems: giItems,
    ascending: false });
  const med = median(gi0.map((d) => d.value));
  g.caption.textContent = `Median of the carriers shown: ${pct(med, 0)}. Goodwill and intangibles are what a buyer paid above `
    + "the net assets it bought; a high share means more of the book value came from deals and is not loss-absorbing "
    + "capital. From the 10-K balance sheets (XBRL Goodwill and IntangibleAssetsNetExcludingGoodwill).";
  g.setTable(() => ({
    columns: ["Carrier", "Goodwill + intangibles / equity", "Detail"],
    rows: giItems().sort((a, b2) => b2.value - a.value).map((d) => [d.name, pct(d.value, 1), d.note]),
  }));

  // ---------------------------------------------------------------- pending deals and change-of-control filings
  const pcard = card(grid, {
    title: `${pendingAll.length} take-private${pendingAll.length === 1 ? "" : "s"} pending, and change-of-control filings of carriers that stayed listed`,
    sub: "From the filing index: merger proxies, going-private schedules (13E-3), and 8-K item 5.01", span: 12, id: "ma-pending",
  });
  const list = el("div", { class: "ma-list" });
  pcard.body.append(list);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  for (const d of [...pendingAll].sort((a, b2) => (a.announced ?? "").localeCompare(b2.announced ?? ""))) {
    const item = el("div", { class: "ma-item" },
      el("div", { class: "ma-item-head" },
        el("span", { class: "ma-chip ma-chip-pending", text: "pending" }),
        el("strong", { text: `${d.target} (${d.ticker})` })),
      el("p", { text: `Merger agreement reported ${d.announced ?? "–"} (8-K item 1.01); first merger proxy ${d.proxy ?? "–"}.`
        + (d.note ? ` ${cap(d.note)}.` : "") }),
      el("p", { class: "ma-muted", text: `Filed so far: ${d.pendingForms ?? "–"}.` }),
      el("p", { class: "ma-muted", text: d.acquirer
        ? `Buyer named in the proxy: ${d.acquirer}.`
        : "Buyer and price: read from the merger proxy once the filing documents are cached." }));
    if (d.proxyUrl) item.append(el("a", { href: d.proxyUrl, text: `Open the ${d.proxyForm ?? "proxy"} on EDGAR`, rel: "noopener" }));
    list.append(item);
  }
  const stayed = ma.events.filter((e) => e.stayedPublic && e.date >= "2009-01-01");
  if (stayed.length) {
    const ul = el("ul", { class: "ma-events" });
    for (const e of stayed) {
      const co = data.byCik.get(e.cik);
      const li = el("li", {}, el("span", { text: `${co?.name ?? e.cik} (${tickerOf(e.cik)}), ${e.date}: ` }));
      if (e.url) li.append(el("a", { href: e.url, text: "8-K", rel: "noopener" }));
      ul.append(li);
    }
    list.append(el("div", { class: "ma-item" },
      el("div", { class: "ma-item-head" }, el("span", { class: "ma-chip", text: "item 5.01" }),
        el("strong", { text: "Change-of-control filings of carriers that stayed listed" })),
      el("p", { class: "ma-muted", text: "Each company kept filing and stayed listed. Item 5.01 also covers reorganizations "
        + "and new controlling holders, so each filing says which." }), ul));
  }
  pcard.setTable(() => ({
    columns: ["Company", "Kind", "Date", "Detail"],
    rows: [
      ...pendingAll.map((d) => [`${d.target} (${d.ticker})`, "take-private pending", d.proxy ?? "–", d.pendingForms ?? "–"]),
      ...stayed.map((e) => [`${data.byCik.get(e.cik)?.name ?? e.cik}`, "8-K item 5.01, stayed listed", e.date, `items ${e.items}`]),
    ],
  }));
  pcard.caption.textContent = "Links open the filings on SEC EDGAR.";

  // ---------------------------------------------------------------- linked updates
  // the page filters (segments, history) and the company in focus redraw every view; hover links without redraws
  store.on(["segments", "historical", "selected"], () => {
    drawTimeline();
    buyers.redraw();
    scatter.redraw();
    spend.redraw();
    goodwill.redraw();
  });
}

export const maSection = {
  id: "ma",
  nav: "M&A",
  title: "Mergers and acquisitions",
  intro,
  mount,
};
