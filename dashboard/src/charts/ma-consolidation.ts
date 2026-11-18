// The listed universe over time, as two aligned panels on one year axis (small multiples, not a dual axis):
// top, the number of listed specialty carriers of the universe at each year-end; bottom, that year's listings
// (IPOs and relistings, up) against its exits (down), stacked by who bought (or "stopped reporting").
import { scaleBand, scaleLinear } from "d3-scale";
import { pointer } from "d3-selection";
import { line } from "d3-shape";
import type { MaData } from "../domains/ma";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { responsive, valueAxis } from "./common";
import { groupColor } from "./ma-style";

export interface ConsolidationOpts {
  card: Card;
  label: string;
  data: MaData;
  tickerOf: (cik: number) => string;
  exitOrder: string[]; // stack order of exit groups (fixed)
}

export function consolidationChart(o: ConsolidationOpts) {
  const L = o.data.listed;
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: 330, label: o.label, margin: { left: 40, right: 14, top: 14, bottom: 24 } }, (f) => {
      const n = L.years.length;
      const x = scaleBand<number>().domain(L.years).range([0, f.width]).paddingInner(0.3);
      const topH = Math.round(f.height * 0.38);
      const gap = 30;
      const botY = topH + gap;
      const botH = f.height - botY;
      // top panel: listed count
      const yTop = scaleLinear().domain([0, Math.max(...L.count) + 2]).range([topH, 0]).nice();
      const gTop = f.g.append("g");
      valueAxis(gTop, yTop, f.width, (v) => String(v), 3);
      gTop.append("text").attr("x", 0).attr("y", -4).text("Listed at year-end");
      const cxp = (i: number) => (x(L.years[i]) ?? 0) + x.bandwidth() / 2;
      gTop.append("path").attr("class", "line").attr("d", line<number>().x((_, i) => cxp(i)).y((v) => yTop(v))(L.count))
        .style("stroke", "var(--ink-2)");
      gTop.selectAll("circle").data(L.count).join("circle").attr("class", "dot").attr("r", 3)
        .attr("cx", (_, i) => cxp(i)).attr("cy", (v) => yTop(v)).style("fill", "var(--ink-2)");
      gTop.append("text").attr("class", "label strong halo").attr("x", cxp(n - 1)).attr("y", yTop(L.count[n - 1]) - 8)
        .attr("text-anchor", "end").text(`${L.count[n - 1]} now`);
      // bottom panel: listings up, exits down
      const exitsBy = L.exits.map((ex) => o.exitOrder.map((g) => ex.filter((e) => e.group === g).length));
      const lo = -Math.max(1, ...exitsBy.map((v) => v.reduce((a, b) => a + b, 0)));
      const hi = Math.max(1, ...L.entries.map((e) => e.length));
      const yB = scaleLinear().domain([lo, hi]).range([botH, 0]).nice();
      const gB = f.g.append("g").attr("transform", `translate(0,${botY})`);
      valueAxis(gB, yB, f.width, (v) => String(Math.abs(v)), 4);
      gB.append("text").attr("x", 0).attr("y", -6).text("Listings (up) and exits (down)");
      gB.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", yB(0)).attr("y2", yB(0)).style("stroke", "var(--axis)");
      const bw = Math.min(22, x.bandwidth());
      const off = (x.bandwidth() - bw) / 2;
      const seg = (px: number, y0: number, y1: number, color: string) => {
        const h = Math.abs(yB(y1) - yB(y0));
        if (h < 0.5) return;
        gB.append("rect").attr("x", px + off).attr("width", bw).attr("y", Math.min(yB(y0), yB(y1)) + 1)
          .attr("height", Math.max(0.5, h - 2)).attr("rx", 2).style("fill", color);
      };
      L.years.forEach((yr, i) => {
        const px = x(yr) ?? 0;
        if (L.entries[i].length) seg(px, 0, L.entries[i].length, "var(--context-strong)");
        let acc = 0;
        o.exitOrder.forEach((g, k) => {
          const v = exitsBy[i][k];
          if (!v) return;
          seg(px, -acc, -(acc + v), groupColor(g));
          acc += v;
        });
      });
      // year labels (every other year when narrow)
      const every = f.width < 420 ? 4 : f.width < 700 ? 2 : 1;
      L.years.forEach((yr, i) => {
        if (i % every && i !== n - 1) return;
        gB.append("text").attr("x", cxp(i)).attr("y", botH + 16).attr("text-anchor", "middle").text(String(yr).slice(f.width < 520 ? 2 : 0))
          .style("font-variant-numeric", "tabular-nums");
      });
      const hot = f.g.append("rect").attr("y", 0).attr("height", f.height).attr("width", x.step())
        .style("fill", "var(--ink)").style("opacity", 0.05).style("display", "none").lower();
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const [mx] = pointer(ev);
          const i = Math.max(0, Math.min(n - 1, Math.floor(mx / x.step())));
          hot.style("display", null).attr("x", (x(L.years[i]) ?? 0) - (x.step() - x.bandwidth()) / 2);
          const rows: TipRow[] = [{ name: "Listed at year-end", value: String(L.count[i]), strong: true }];
          if (L.entries[i].length) rows.push({ color: "var(--context-strong)", name: "Listed", value: L.entries[i].map(o.tickerOf).join(", ") });
          for (const g of o.exitOrder) {
            const ex = L.exits[i].filter((e) => e.group === g);
            if (ex.length) rows.push({ color: groupColor(g), name: g, value: ex.map((e) => o.tickerOf(e.cik)).join(", ") });
          }
          showTip(ev.clientX, ev.clientY, i === n - 1 ? `${L.years[i]} so far` : String(L.years[i]), rows);
        })
        .on("pointerleave", () => { hideTip(); hot.style("display", "none"); });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
