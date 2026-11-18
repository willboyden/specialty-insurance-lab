// Catastrophe sensitivity by carrier: the model's loading on the industry shock (loss-ratio points per 1 sigma),
// posterior mean with its 89% interval, one row per carrier, sorted. The focus company is in the accent and labeled;
// hover sets store.hover (the same carrier lights up in every view), click sets store.selected.
import { scaleBand, scaleLinear } from "d3-scale";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";

export interface SensRow {
  cik: number;
  ticker: string;
  name: string;
  segment: string;
  mean: number;
  lo: number;
  hi: number;
}

export function sensChart(o: { card: Card; store: Store; getRows: () => SensRow[]; fmt: (v: number) => string;
  shock: { sigma: number; label: string } | null }): () => void {
  const ROW = 18;
  const draw = () => {
    if (o.card.showingTable()) return;
    const rows = o.getRows().sort((a, b) => b.mean - a.mean);
    responsive(o.card.body, {
      height: rows.length * ROW + 46, label: "Catastrophe sensitivity by carrier, with 89% intervals",
      margin: { left: 56, right: 64, top: 6, bottom: 40 },
    }, (f) => {
      const x = scaleLinear().domain([0, Math.max(...rows.map((r) => r.hi))]).range([0, f.width]).nice();
      const y = scaleBand<number>().domain(rows.map((r) => r.cik)).range([0, rows.length * ROW]).paddingInner(0.25);
      f.g.append("g").attr("class", "grid").call((g) => {
        for (const t of x.ticks(4)) g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", 0).attr("y2", rows.length * ROW);
      });
      const ax = f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${rows.length * ROW + 4})`);
      for (const t of x.ticks(4)) {
        ax.append("text").attr("x", x(t)).attr("y", 12).attr("text-anchor", "middle").text(`${t > 0 ? "+" : ""}${Math.round(t * 100)}`);
      }
      f.g.append("text").attr("x", f.width).attr("y", rows.length * ROW + 36).attr("text-anchor", "end")
        .text("loss-ratio points per 1σ industry shock");
      const st = o.store.get();
      const g = f.g.append("g");
      const rowG = g.selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(0,${y(r.cik)})`);
      const bw = y.bandwidth();
      rowG.append("text").attr("class", (r) => (r.cik === st.selected ? "b-rowlabel sel" : "b-rowlabel"))
        .attr("x", -8).attr("y", bw / 2).attr("dy", "0.32em").attr("text-anchor", "end").text((r) => r.ticker);
      const ink = (r: SensRow, s: { selected: number; hover: number | null }) =>
        r.cik === s.selected || r.cik === s.hover ? "var(--s1)" : "var(--context-strong)";
      const bars = rowG.append("line").attr("x1", (r) => x(r.lo)).attr("x2", (r) => x(r.hi)).attr("y1", bw / 2).attr("y2", bw / 2)
        .style("stroke", (r) => ink(r, st)).style("stroke-width", 3).style("stroke-linecap", "round").style("opacity", 0.5);
      const dots = rowG.append("circle").attr("class", "dot").attr("cx", (r) => x(r.mean)).attr("cy", bw / 2).attr("r", 4.5)
        .style("fill", (r) => ink(r, st));
      const sel = rows.find((r) => r.cik === st.selected);
      if (sel) {
        f.g.append("text").attr("class", "label strong").attr("x", x(sel.hi) + 6).attr("y", (y(sel.cik) ?? 0) + bw / 2)
          .attr("dy", "0.32em").text(o.fmt(sel.mean));
      }
      rowG.append("rect").attr("class", "hit").attr("x", -56).attr("y", -2).attr("width", f.width + 56 + 60).attr("height", bw + 4)
        .style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent, r) => {
          o.store.set({ hover: r.cik });
          const rowsTip = [
            { color: "var(--s1)", name: "Points per 1σ shock", value: o.fmt(r.mean), strong: true },
            { name: "89% interval", value: `${o.fmt(r.lo)} to ${o.fmt(r.hi)}` },
          ];
          if (o.shock) rowsTip.push({ name: `In a ${o.shock.label} quarter`, value: `about ${o.fmt(r.mean * o.shock.sigma)}` });
          showTip(ev.clientX, ev.clientY, `${r.name} (${r.ticker})`, rowsTip, `${r.segment} · click to focus`);
        })
        .on("pointerleave", () => { hideTip(); o.store.set({ hover: null }); })
        .on("click", (_ev: PointerEvent, r) => o.store.set({ selected: r.cik }));
      const unsub = o.store.on(["hover"], (s2) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        bars.style("stroke", (r) => ink(r, s2));
        dots.style("fill", (r) => ink(r, s2));
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return draw;
}
