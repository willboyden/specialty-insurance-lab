// Deal timeline: one row per deal, a bar from the announcement to the closing (a pending deal runs to today with
// a dashed outline), colored by buyer group, with the merger proxy marked on the bar and the buyer and price
// labeled at its end. Rows hover-link to every other view (store.hover); a click focuses comparable carriers.
import { scaleUtc } from "d3-scale";
import { select } from "d3-selection";
import { axisBottom, axisTop } from "d3-axis";
import type { MaDeal } from "../domains/ma";
import type { Store } from "../state";
import { hideTip, showTip, type TipRow } from "../ui";
import { isoToDate, yearFmt } from "./common";
import { earlierLabel, groupColor, priceLabel, shortBuyer, shortTarget } from "./ma-style";
import { money, pct, times } from "../format";

export interface DealTimelineOpts {
  host: HTMLElement;
  store: Store;
  label: string;
  asOf: string;
  getDeals: () => MaDeal[]; // already ordered
  canFocus: (cik: number) => boolean;
}

export function dealTip(d: MaDeal): { rows: TipRow[]; note: string } {
  const rows: TipRow[] = [
    { color: groupColor(d.group), name: "Buyer", value: d.acquirer ?? (d.status === "pending" ? "pending" : "not verified"), strong: true },
  ];
  if (d.acquirerType) rows.push({ name: "Buyer type", value: d.acquirerType });
  rows.push({ name: "Price", value: priceLabel(d) });
  const earlier = earlierLabel(d);
  if (earlier) rows.push({ name: "History", value: earlier });
  if (d.value != null) rows.push({ name: "Implied equity value", value: money(d.value) });
  if (d.pb != null) rows.push({ name: "Price / book", value: times(d.pb) });
  if (d.roe != null) rows.push({ name: "Target ROE, TTM", value: pct(d.roe) });
  if (d.cr != null) rows.push({ name: "Target combined ratio, TTM", value: pct(d.cr) });
  rows.push({ name: "Announced", value: d.announced ?? "–" });
  rows.push({ name: d.status === "pending" ? "Status" : "Closed", value: d.status === "pending" ? "pending" : `${d.closed ?? "–"}${d.days != null ? ` (${d.days} days)` : ""}` });
  const acq = d.checks.find((c) => c.field === "acquirer");
  const note = [
    acq ? `Buyer and price found together in ${acq.hits} of the target's deal filings (SEC full-text search)` : null,
    d.status === "pending" ? `Filed so far: ${d.pendingForms ?? "–"}` : null,
    d.note,
  ].filter(Boolean).join(". ");
  return { rows, note };
}

export function dealTimeline(o: DealTimelineOpts): () => void {
  const RH = 22;
  let lastW = -1;
  const render = () => {
    const W = Math.max(300, o.host.clientWidth);
    lastW = W;
    o.host.replaceChildren();
    const deals = o.getDeals();
    const narrow = W < 640;
    const rowLabel = (d: MaDeal) => (narrow ? d.ticker : `${shortTarget(d.target)} (${d.ticker})`);
    const gutter = narrow ? 52 : Math.min(230, 14 + Math.max(...deals.map((d) => rowLabel(d).length)) * 6.4);
    const right = narrow ? 10 : 196;
    const top = 24;
    const bottom = 24;
    const H = top + deals.length * RH + bottom;
    const svg = select(o.host).append("svg").attr("class", "chart").attr("width", W).attr("height", H)
      .attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", o.label);
    const g = svg.append("g").attr("transform", `translate(${gutter},${top})`);
    const iw = W - gutter - right;
    const dates = deals.flatMap((d) => [d.announced, d.closed]).filter((x): x is string => !!x).map(isoToDate);
    const t0 = new Date(Math.min(...dates.map(Number)));
    t0.setUTCMonth(0, 1);
    const t1 = isoToDate(o.asOf);
    t1.setUTCMonth(t1.getUTCMonth() + 2);
    const x = scaleUtc().domain([t0, t1]).range([0, iw]);
    const ticks = Math.max(3, Math.min(14, Math.floor(iw / 62)));
    const yy = deals.length * RH;
    g.append("g").attr("class", "grid").call(axisBottom(x).ticks(ticks).tickSize(yy).tickFormat(() => ""))
      .call((s) => s.select(".domain").remove());
    g.append("g").attr("class", "axis").call(axisTop(x).ticks(ticks).tickFormat((d) => yearFmt(d as Date)).tickSizeOuter(0))
      .call((s) => s.select(".domain").remove());
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${yy})`)
      .call(axisBottom(x).ticks(ticks).tickFormat((d) => yearFmt(d as Date)).tickSizeOuter(0))
      .call((s) => s.select(".domain").remove());
    const today = x(isoToDate(o.asOf));
    g.append("line").attr("x1", today).attr("x2", today).attr("y1", -4).attr("y2", yy).style("stroke", "var(--ink-3)")
      .style("stroke-dasharray", "2 3");

    const st = o.store.get();
    const hot = g.append("rect").attr("class", "b-rowhot ma-rowhot").attr("x", -gutter).attr("width", gutter + iw + right)
      .attr("height", RH).style("display", "none");
    const rowsG = g.append("g");
    const rowSel = deals.map((d, i) => {
      const row = rowsG.append("g").attr("transform", `translate(0,${i * RH})`).attr("data-cik", d.cik);
      const y = RH / 2;
      row.append("text").attr("class", `label${d.cik === st.selected ? " strong" : ""}`).attr("x", -8).attr("y", y).attr("dy", "0.32em")
        .attr("text-anchor", "end").text(rowLabel(d));
      if (!d.announced) return row;
      const a = x(isoToDate(d.announced));
      const b = x(isoToDate(d.closed ?? o.asOf));
      const color = groupColor(d.group);
      const bar = row.append("rect").attr("x", a).attr("y", y - 5).attr("width", Math.max(3, b - a)).attr("height", 10).attr("rx", 5)
        .style("fill", color).style("fill-opacity", d.status === "pending" ? 0.25 : 0.95);
      if (d.status === "pending") bar.style("stroke", color).style("stroke-width", 1.5).style("stroke-dasharray", "3 2");
      if (d.proxy) {
        const px = x(isoToDate(d.proxy));
        if (px > a + 3 && px < b - 3) {
          row.append("line").attr("x1", px).attr("x2", px).attr("y1", y - 5).attr("y2", y + 5)
            .style("stroke", "var(--surface)").style("stroke-width", 2);
        }
      }
      if (!narrow) {
        const price = d.price != null ? ` · $${d.price.toFixed(2)}` : d.consideration === "mixed" ? " · stock + cash" : "";
        row.append("text").attr("class", "label").attr("x", Math.min(iw + 4, b + 6)).attr("y", y).attr("dy", "0.32em")
          .text(`${shortBuyer(d)}${price}`);
      }
      return row;
    });

    const rowAt = (py: number) => Math.floor(py / RH);
    let hov = -1;
    const emphasize = (cik: number | null) => {
      rowSel.forEach((r, i) => r.style("opacity", cik == null || deals[i].cik === cik ? 1 : 0.4));
    };
    g.append("rect").attr("class", "hit").attr("x", -gutter).attr("width", gutter + iw + right).attr("height", yy)
      .style("cursor", "pointer")
      .on("pointermove", (ev: PointerEvent) => {
        const rect = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
        const i = rowAt(ev.clientY - rect.top);
        if (i < 0 || i >= deals.length) { hideTip(); return; }
        const d = deals[i];
        if (i !== hov) {
          hov = i;
          hot.style("display", null).attr("y", i * RH).lower();
          o.store.set({ hover: d.cik });
        }
        const tip = dealTip(d);
        showTip(ev.clientX, ev.clientY, `${d.target} (${d.ticker})`, tip.rows,
          [tip.note, o.canFocus(d.cik) ? "Click to focus this carrier" : null].filter(Boolean).join(". "));
      })
      .on("pointerleave", () => {
        hideTip();
        hov = -1;
        hot.style("display", "none");
        o.store.set({ hover: null });
      })
      .on("click", (ev: MouseEvent) => {
        const rect = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
        const i = rowAt(ev.clientY - rect.top);
        if (i >= 0 && i < deals.length && o.canFocus(deals[i].cik)) o.store.set({ selected: deals[i].cik });
      });
    const unsub = o.store.on(["hover"], (s2) => {
      if (!svg.node()?.isConnected) { unsub(); return; }
      emphasize(s2.hover != null && deals.some((d) => d.cik === s2.hover) ? s2.hover : null);
    });
  };
  OBSERVERS.get(o.host)?.disconnect();
  const ro = new ResizeObserver(() => {
    if (Math.abs(o.host.clientWidth - lastW) > 2 && o.host.offsetParent !== null) render();
  });
  OBSERVERS.set(o.host, ro);
  ro.observe(o.host);
  render();
  return render;
}

const OBSERVERS = new WeakMap<HTMLElement, ResizeObserver>();
