// Combined-ratio decomposition by year: accident-year loss ratio + expense ratio stacked in one column, prior-year
// reserve development as a thin diverging bar beside it, and the combined ratio as a dot.
//   combined ratio = accident-year loss ratio + prior-year development + expense ratio
import { scaleBand, scaleLinear } from "d3-scale";
import { pointer } from "d3-selection";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";
import { pct, pts } from "../format";

export interface DecompRow {
  label: string; // "2019" or "TTM Q3 2026"
  ay: number | null; // accident-year loss ratio
  pyd: number | null; // prior-year development (negative = favorable)
  er: number | null; // expense ratio
  cr: number | null; // combined ratio as computed
  basis?: string | null;
}

export function decompChart(o: { card: Card; label: string; getRows: () => DecompRow[]; height?: number }) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: o.height ?? 300, label: o.label, margin: { left: 44, right: 12, bottom: 28 } }, (f) => {
      const rows = o.getRows();
      const n = rows.length;
      const x = scaleBand<number>().domain(rows.map((_, i) => i)).range([0, f.width]).paddingInner(0.3);
      let hi = 1.05;
      let lo = 0;
      for (const r of rows) {
        hi = Math.max(hi, (r.ay ?? 0) + (r.er ?? 0), r.cr ?? 0, (r.ay ?? 0) + Math.max(0, r.pyd ?? 0) + (r.er ?? 0));
        lo = Math.min(lo, r.pyd ?? 0);
      }
      const y = scaleLinear().domain([lo, hi]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, (v) => pct(v, 0), 5);
      const ref = f.g.append("g").attr("class", "ref");
      ref.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(1)).attr("y2", y(1));
      ref.append("text").attr("x", 4).attr("y", y(1) - 5).text("100%");
      f.g.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0)).style("stroke", "var(--axis)");
      const colW = Math.min(24, x.bandwidth() * 0.62);
      const pydW = Math.min(10, x.bandwidth() * 0.26);
      const g = f.g.append("g");
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(f.width / 44))));
      rows.forEach((r, i) => {
        const x0 = x(i)!;
        if (r.ay != null) {
          const top = y(r.ay);
          g.append("path").attr("d", `M${x0},${y(0)}V${top + 1}H${x0 + colW}V${y(0)}Z`).style("fill", "var(--s1)");
          if (r.er != null) {
            const t2 = y(r.ay + r.er);
            const rr = Math.min(4, colW / 2, Math.max(0, top - 1 - t2));
            g.append("path")
              .attr("d", `M${x0},${top - 1}V${t2 + rr}Q${x0},${t2} ${x0 + rr},${t2}H${x0 + colW - rr}Q${x0 + colW},${t2} ${x0 + colW},${t2 + rr}V${top - 1}Z`)
              .style("fill", "var(--s3)");
          }
        }
        if (r.pyd != null && r.pyd !== 0) {
          const px = x0 + colW + 3;
          const yv = y(r.pyd);
          const y0 = y(0);
          const rr = Math.min(3, pydW / 2, Math.abs(yv - y0));
          const d = r.pyd > 0
            ? `M${px},${y0}V${yv + rr}Q${px},${yv} ${px + rr},${yv}H${px + pydW - rr}Q${px + pydW},${yv} ${px + pydW},${yv + rr}V${y0}Z`
            : `M${px},${y0}V${yv - rr}Q${px},${yv} ${px + rr},${yv}H${px + pydW - rr}Q${px + pydW},${yv} ${px + pydW},${yv - rr}V${y0}Z`;
          g.append("path").attr("d", d).style("fill", r.pyd > 0 ? "var(--div-pos)" : "var(--div-neg)");
        }
        if (r.cr != null) {
          g.append("circle").attr("class", "dot").attr("r", 4.5).attr("cx", x0 + colW / 2).attr("cy", y(r.cr)).style("fill", "var(--ink)");
        }
        if (i % every === 0 || i === n - 1) {
          f.g.append("text").attr("x", x0 + colW / 2).attr("y", f.height + 16).attr("text-anchor", "middle")
            .attr("class", i === n - 1 ? "label strong" : "label").style("font-size", "10.5px").text(r.label);
        }
      });
      const hl = f.g.append("rect").attr("y", 0).attr("height", f.height).style("fill", "var(--ink)").style("opacity", 0.05).style("display", "none");
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const i = Math.max(0, Math.min(n - 1, Math.floor(pointer(ev)[0] / x.step())));
          const r = rows[i];
          hl.style("display", null).attr("x", x(i)! - (x.step() - x.bandwidth()) / 2).attr("width", x.step());
          showTip(ev.clientX, ev.clientY, r.label, [
            { color: "var(--ink)", name: "Combined ratio", value: pct(r.cr), strong: true },
            { color: "var(--s1)", name: "Accident-year loss ratio", value: pct(r.ay) },
            { color: r.pyd != null && r.pyd > 0 ? "var(--div-pos)" : "var(--div-neg)", name: "Prior-year development", value: pts(r.pyd) },
            { color: "var(--s3)", name: "Expense ratio", value: pct(r.er) },
          ], r.basis ? `Expense ratio source: ${r.basis}` : undefined);
        })
        .on("pointerleave", () => { hideTip(); hl.style("display", "none"); });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
