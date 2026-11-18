// Forest plot: one row per estimated sensitivity, the company's posterior mean with its 89% interval in the
// accent, and every peer's mean as a faint dot on the same row for context.
import { scaleBand, scaleLinear } from "d3-scale";
import { axisBottom } from "d3-axis";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";

export interface ForestRow {
  key: string;
  label: string;
  est: [number, number, number] | null; // mean, lo, hi
  peers: number[];
  group?: string; // rows of one group share an x scale; each group gets its own axis
}

export function forestChart(o: { card: Card; label: string; fmt: (v: number) => string; axisLabel: string; getRows: () => ForestRow[] }) {
  const ROW = 40;
  const GROUP_GAP = 46;
  const draw = () => {
    if (o.card.showingTable()) return;
    const rows = o.getRows();
    const groups = [...new Set(rows.map((r) => r.group ?? ""))];
    const height = rows.length * ROW + groups.length * GROUP_GAP + 6;
    responsive(o.card.body, { height, label: o.label, margin: { left: 150, right: 16, top: 6, bottom: 4 } }, (f) => {
      let top = 0;
      for (const grp of groups) {
        const gr = rows.filter((r) => (r.group ?? "") === grp);
        const vals = gr.flatMap((r) => [...(r.est ?? []), ...r.peers]).filter((v) => Number.isFinite(v));
        const x = scaleLinear().domain([Math.min(0, ...vals), Math.max(0, ...vals)]).range([0, f.width]).nice();
        const y = scaleBand<string>().domain(gr.map((r) => r.key)).range([top, top + gr.length * ROW]).paddingInner(0.2);
        const bottom = top + gr.length * ROW;
        f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${bottom})`)
          .call(axisBottom(x).ticks(Math.max(3, Math.floor(f.width / 70))).tickFormat((d) => o.fmt(Number(d))).tickSizeOuter(0));
        f.g.append("text").attr("x", f.width).attr("y", bottom + 30).attr("text-anchor", "end").text(grp ? `${grp} · ${o.axisLabel}` : o.axisLabel);
        f.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", top).attr("y2", bottom).style("stroke", "var(--axis)");
        for (const r of gr) {
          const cy = y(r.key)! + y.bandwidth() / 2;
          f.g.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", cy).attr("y2", cy).style("stroke", "var(--grid)");
          f.g.append("text").attr("x", -10).attr("y", cy).attr("dy", "0.32em").attr("text-anchor", "end").attr("class", "label").text(r.label);
          f.g.append("g").selectAll("circle").data(r.peers.filter((v) => Number.isFinite(v))).join("circle")
            .attr("cx", (v) => x(v)).attr("cy", cy).attr("r", 3).style("fill", "var(--context-strong)").style("opacity", 0.35);
          if (r.est) {
            const [m, a, b] = r.est;
            f.g.append("line").attr("x1", x(a)).attr("x2", x(b)).attr("y1", cy).attr("y2", cy)
              .style("stroke", "var(--s1)").style("stroke-width", 3).style("stroke-linecap", "round");
            f.g.append("circle").attr("class", "dot").attr("cx", x(m)).attr("cy", cy).attr("r", 5.5).style("fill", "var(--s1)");
          }
          f.g.append("rect").attr("class", "hit").attr("x", -150).attr("y", y(r.key)!).attr("width", f.width + 150).attr("height", y.bandwidth())
            .on("pointermove", (ev: PointerEvent) => {
              const rowsTip = r.est
                ? [{ color: "var(--s1)", name: "Estimate", value: o.fmt(r.est[0]), strong: true },
                   { name: "89% interval", value: `${o.fmt(r.est[1])} to ${o.fmt(r.est[2])}` }]
                : [{ name: "Estimate", value: "not modeled" }];
              const sorted = [...r.peers].sort((p, q) => p - q);
              const rank = r.est ? sorted.filter((v) => v < r.est![0]).length : 0;
              showTip(ev.clientX, ev.clientY, r.label, rowsTip, r.est ? `Higher than ${rank} of ${sorted.length} other carriers` : undefined);
            })
            .on("pointerleave", hideTip);
        }
        top = bottom + GROUP_GAP;
      }
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
