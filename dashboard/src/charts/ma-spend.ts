// Cash the carriers paid for acquisitions, by fiscal year: one column per year for the visible carriers together
// (net of the cash the targets held, so a year can be negative), and the company in focus as a marker on the
// same scale (same unit, one axis). Hover lists the year's largest buyers.
import { scaleBand, scaleLinear } from "d3-scale";
import { pointer } from "d3-selection";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { responsive, valueAxis } from "./common";
import { money } from "../format";

export interface SpendOpts {
  card: Card;
  label: string;
  years: number[];
  getTotals: () => (number | null)[]; // USD
  getFocus: () => { name: string; values: (number | null)[] } | null;
  getTop: (i: number) => { name: string; value: number }[];
}

export function spendChart(o: SpendOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: 250, label: o.label, margin: { left: 54, right: 12, top: 12, bottom: 24 } }, (f) => {
      const totals = o.getTotals();
      const focus = o.getFocus();
      const vals = [...totals, ...(focus?.values ?? [])].filter((v): v is number => v != null);
      const y = scaleLinear().domain([Math.min(0, ...vals), Math.max(1, ...vals)]).range([f.height, 0]).nice();
      const x = scaleBand<number>().domain(o.years).range([0, f.width]).paddingInner(0.3);
      valueAxis(f.g, y, f.width, (v) => money(v), 4);
      f.g.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0)).style("stroke", "var(--axis)");
      const bw = Math.min(24, x.bandwidth());
      const off = (x.bandwidth() - bw) / 2;
      o.years.forEach((yr, i) => {
        const v = totals[i];
        if (v == null || v === 0) return;
        const y0 = y(0);
        const y1 = y(v);
        const h = Math.abs(y1 - y0);
        const r = Math.min(4, bw / 2, h);
        const px = (x(yr) ?? 0) + off;
        const d = v > 0
          ? `M${px},${y0}V${y1 + r}Q${px},${y1} ${px + r},${y1}H${px + bw - r}Q${px + bw},${y1} ${px + bw},${y1 + r}V${y0}Z`
          : `M${px},${y0}V${y1 - r}Q${px},${y1} ${px + r},${y1}H${px + bw - r}Q${px + bw},${y1} ${px + bw},${y1 - r}V${y0}Z`;
        f.g.append("path").attr("d", d).style("fill", "var(--context-strong)").style("fill-opacity", v > 0 ? 0.75 : 0.4);
      });
      if (focus) {
        o.years.forEach((yr, i) => {
          const v = focus.values[i];
          if (v == null || v === 0) return;
          f.g.append("circle").attr("class", "dot").attr("cx", (x(yr) ?? 0) + x.bandwidth() / 2).attr("cy", y(v)).attr("r", 4.5)
            .style("fill", "var(--s1)");
        });
      }
      const every = f.width < 420 ? 4 : f.width < 700 ? 2 : 1;
      o.years.forEach((yr, i) => {
        if (i % every && i !== o.years.length - 1) return;
        f.g.append("text").attr("x", (x(yr) ?? 0) + x.bandwidth() / 2).attr("y", f.height + 16).attr("text-anchor", "middle")
          .text(String(yr).slice(f.width < 520 ? 2 : 0)).style("font-variant-numeric", "tabular-nums");
      });
      const hot = f.g.append("rect").attr("y", 0).attr("height", f.height).attr("width", x.step())
        .style("fill", "var(--ink)").style("opacity", 0.05).style("display", "none").lower();
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const [mx] = pointer(ev);
          const i = Math.max(0, Math.min(o.years.length - 1, Math.floor(mx / x.step())));
          hot.style("display", null).attr("x", (x(o.years[i]) ?? 0) - (x.step() - x.bandwidth()) / 2);
          const rows: TipRow[] = [{ color: "var(--context-strong)", name: "All visible carriers", value: money(totals[i]), strong: true }];
          if (focus && focus.values[i] != null) rows.push({ color: "var(--s1)", name: focus.name, value: money(focus.values[i]) });
          for (const t of o.getTop(i)) rows.push({ name: t.name, value: money(t.value) });
          showTip(ev.clientX, ev.clientY, `Fiscal ${o.years[i]}`, rows, "Net of the cash the acquired businesses held");
        })
        .on("pointerleave", () => { hideTip(); hot.style("display", "none"); });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
