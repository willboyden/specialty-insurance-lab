// Ranked horizontal bars (one hue; the focus company in the accent). Bars grow from zero, <= 24px thick with a
// 4px rounded data end; the value sits at the bar tip.
import { scaleBand, scaleLinear } from "d3-scale";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";

export interface RankItem {
  id: number;
  label: string;
  name: string;
  value: number;
  note?: string;
}

export interface RankOpts {
  card: Card;
  store: Store;
  label: string;
  fmt: (v: number) => string;
  getItems: () => RankItem[];
  ref?: { value: number; label: string };
  ascending?: boolean;
  rowHeight?: number;
}

function barPath(x0: number, x1: number, y: number, h: number, r: number): string {
  // square at the baseline, rounded at the data end (either direction)
  const w = x1 - x0;
  const rr = Math.min(r, Math.abs(w) / 2, h / 2);
  if (w >= 0) {
    return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  }
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

export function rankBars(o: RankOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    const items = o.getItems().filter((d) => Number.isFinite(d.value))
      .sort((a, b) => (o.ascending === false ? b.value - a.value : a.value - b.value));
    const rh = o.rowHeight ?? 17;
    responsive(o.card.body, { height: () => items.length * rh + 28, label: o.label, margin: { left: 50, right: 52, top: 4, bottom: 20 } }, (f) => {
      const vals = items.map((d) => d.value);
      const lo = Math.min(0, ...vals);
      const hi = Math.max(0, ...vals, o.ref?.value ?? 0);
      const x = scaleLinear().domain([lo, hi]).range([0, f.width]).nice();
      const y = scaleBand<number>().domain(items.map((d) => d.id)).range([0, items.length * rh]).paddingInner(0.3);
      const bh = Math.min(24, y.bandwidth());
      const st = o.store.get();
      f.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", items.length * rh).style("stroke", "var(--axis)");
      if (o.ref) {
        const g = f.g.append("g").attr("class", "ref");
        g.append("line").attr("x1", x(o.ref.value)).attr("x2", x(o.ref.value)).attr("y1", -2).attr("y2", items.length * rh);
        g.append("text").attr("x", x(o.ref.value)).attr("y", items.length * rh + 14).attr("text-anchor", "middle").text(o.ref.label);
      }
      const rows = f.g.append("g").selectAll("g").data(items).join("g")
        .attr("transform", (d) => `translate(0,${y(d.id)})`);
      rows.append("path").attr("d", (d) => barPath(x(0), x(d.value), (y.bandwidth() - bh) / 2, bh, 4))
        .style("fill", (d) => (d.id === st.selected ? "var(--s1)" : "var(--context-strong)"))
        .style("fill-opacity", (d) => (d.id === st.selected ? 1 : 0.55));
      rows.append("text").attr("x", -6).attr("y", y.bandwidth() / 2).attr("dy", "0.32em").attr("text-anchor", "end")
        .attr("class", (d) => (d.id === st.selected ? "label strong" : "label")).style("font-size", "11px").text((d) => d.label);
      rows.append("text").attr("x", (d) => x(d.value) + (d.value >= 0 ? 5 : -5)).attr("y", y.bandwidth() / 2).attr("dy", "0.32em")
        .attr("text-anchor", (d) => (d.value >= 0 ? "start" : "end"))
        .attr("class", (d) => (d.id === st.selected ? "label strong" : "label")).style("font-size", "11px").text((d) => o.fmt(d.value));
      rows.append("rect").attr("class", "hit").attr("x", -50).attr("width", f.width + 100).attr("height", y.step())
        .attr("y", -(y.step() - y.bandwidth()) / 2).style("cursor", "pointer")
        .on("pointerenter", (ev: PointerEvent, d) => {
          o.store.set({ hover: d.id });
          showTip(ev.clientX, ev.clientY, d.name, [{ name: o.label, value: o.fmt(d.value), strong: true }], d.note ?? "Click to focus this company");
        })
        .on("pointermove", (ev: PointerEvent, d) => showTip(ev.clientX, ev.clientY, d.name, [{ name: o.label, value: o.fmt(d.value), strong: true }], d.note ?? "Click to focus this company"))
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
