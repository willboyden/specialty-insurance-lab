// Ranked horizontal bars for one claims metric: peers in gray, the selected company in the accent. Values that
// diverge around zero grow both ways from it; the value sits at the bar tip, and the plot reserves room on each side
// that has values so a tip label never runs into the company labels. Hover links to every other view; click selects.
import { scaleBand, scaleLinear } from "d3-scale";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";

export interface ClaimsRankItem {
  id: number;
  label: string;
  name: string;
  value: number;
  note?: string;
}

export interface ClaimsRankOpts {
  card: Card;
  store: Store;
  label: string;
  fmt: (v: number) => string;
  metricName: () => string;
  ascending: () => boolean;
  getItems: () => ClaimsRankItem[];
}

function hbar(x0: number, x1: number, y: number, h: number, r = 4): string {
  const w = x1 - x0;
  const rr = Math.min(r, Math.abs(w) / 2, h / 2);
  if (w >= 0) return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

export function claimsRank(o: ClaimsRankOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    const asc = o.ascending();
    const items = o.getItems().filter((d) => Number.isFinite(d.value)).sort((a, b) => (asc ? a.value - b.value : b.value - a.value));
    const rh = 17;
    responsive(o.card.body, { height: () => Math.max(1, items.length) * rh + 12, label: o.label, margin: { left: 46, right: 8, top: 4, bottom: 8 } }, (f) => {
      const lo = Math.min(0, ...items.map((d) => d.value));
      const hi = Math.max(0, ...items.map((d) => d.value));
      const room = 50; // px for the tip labels
      const x = scaleLinear().domain([lo, hi || 1]).range([lo < 0 ? room : 0, f.width - (hi > 0 ? room : 0)]);
      const y = scaleBand<number>().domain(items.map((d) => d.id)).range([0, items.length * rh]).paddingInner(0.3);
      const bh = Math.min(24, y.bandwidth());
      const st = o.store.get();
      f.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", -2).attr("y2", items.length * rh).style("stroke", "var(--axis)");
      const rows = f.g.append("g").selectAll("g").data(items).join("g").attr("transform", (d) => `translate(0,${y(d.id)})`);
      rows.append("path").attr("d", (d) => hbar(x(0), x(d.value), (y.bandwidth() - bh) / 2, bh))
        .style("fill", (d) => (d.id === st.selected ? "var(--s1)" : "var(--context-strong)"))
        .style("fill-opacity", (d) => (d.id === st.selected ? 1 : 0.55));
      rows.append("text").attr("x", -6).attr("y", y.bandwidth() / 2).attr("dy", "0.32em").attr("text-anchor", "end")
        .attr("class", (d) => (d.id === st.selected ? "label strong" : "label")).style("font-size", "11px").text((d) => d.label);
      rows.append("text").attr("x", (d) => x(d.value) + (d.value >= 0 ? 4 : -4)).attr("y", y.bandwidth() / 2).attr("dy", "0.32em")
        .attr("text-anchor", (d) => (d.value >= 0 ? "start" : "end"))
        .attr("class", (d) => (d.id === st.selected ? "label strong" : "label")).style("font-size", "11px").text((d) => o.fmt(d.value));
      const tip = (ev: PointerEvent, d: ClaimsRankItem) => showTip(ev.clientX, ev.clientY, d.name,
        [{ name: o.metricName(), value: o.fmt(d.value), strong: true }], d.note ? `${d.note} · click to focus` : "Click to focus this company");
      rows.append("rect").attr("class", "hit").attr("x", -f.margin.left).attr("width", f.width + f.margin.left + f.margin.right)
        .attr("height", y.step()).attr("y", -(y.step() - y.bandwidth()) / 2).style("cursor", "pointer")
        .on("pointerenter", (ev: PointerEvent, d) => { o.store.set({ hover: d.id }); tip(ev, d); })
        .on("pointermove", tip)
        .on("pointerleave", () => { hideTip(); o.store.set({ hover: null }); })
        .on("click", (_ev, d) => o.store.set({ selected: d.id }));
      const unsub = o.store.on(["hover"], (s2) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        rows.select("path").style("fill-opacity", (d) => (d.id === s2.selected || d.id === s2.hover ? 1 : 0.55));
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
