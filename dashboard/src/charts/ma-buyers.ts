// Who bought: one horizontal bar per buyer group, length = implied equity value of its deals, labeled with the
// number of deals and the median price-to-book. Bars are in the fixed group order, not sorted, so the color of a
// group never moves.
import { scaleBand, scaleLinear } from "d3-scale";
import type { MaDeal } from "../domains/ma";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";
import { GROUPS, groupColor } from "./ma-style";
import { money, times } from "../format";

export interface BuyerRow {
  group: string;
  deals: MaDeal[];
  value: number;
  medianPb: number | null;
}

export function buyerRows(deals: MaDeal[]): BuyerRow[] {
  return GROUPS.map((g) => {
    const ds = deals.filter((d) => d.status === "closed" && d.group === g);
    const pbs = ds.map((d) => d.pb).filter((v): v is number => v != null).sort((a, b) => a - b);
    const m = pbs.length ? (pbs.length % 2 ? pbs[(pbs.length - 1) / 2] : (pbs[pbs.length / 2 - 1] + pbs[pbs.length / 2]) / 2) : null;
    return { group: g, deals: ds, value: ds.reduce((a, d) => a + (d.value ?? 0), 0), medianPb: m };
  });
}

export function buyerChart(o: { card: Card; label: string; getRows: () => BuyerRow[] }) {
  const draw = () => {
    if (o.card.showingTable()) return;
    const rows = o.getRows();
    responsive(o.card.body, { height: rows.length * 46 + 24, label: o.label, margin: { left: 8, right: 16, top: 6, bottom: 18 } }, (f) => {
      const y = scaleBand<string>().domain(rows.map((r) => r.group)).range([0, rows.length * 46]).paddingInner(0.45);
      const x = scaleLinear().domain([0, Math.max(1, ...rows.map((r) => r.value))]).range([0, f.width]).nice();
      for (const r of rows) {
        const y0 = y(r.group) ?? 0;
        const head = f.g.append("text").attr("class", "label").attr("x", 0).attr("y", y0 - 5);
        head.append("tspan").attr("class", "strong").style("font-weight", "600").style("fill", "var(--ink)").text(r.group);
        head.append("tspan").text(`  ${money(r.value)} · ${r.deals.length} deal${r.deals.length === 1 ? "" : "s"}`
          + (r.medianPb != null ? ` · median ${times(r.medianPb)} book` : ""));
        const w = Math.max(r.value > 0 ? 3 : 0, x(r.value));
        const h = y.bandwidth();
        const rr = Math.min(4, w / 2, h / 2);
        if (w > 0) {
          f.g.append("path").attr("d", `M0,${y0}H${w - rr}Q${w},${y0} ${w},${y0 + rr}V${y0 + h - rr}Q${w},${y0 + h} ${w - rr},${y0 + h}H0Z`)
            .style("fill", groupColor(r.group));
        }
        f.g.append("rect").attr("class", "hit").attr("x", 0).attr("y", y0 - 16).attr("width", f.width).attr("height", h + 18)
          .on("pointermove", (ev: PointerEvent) => showTip(ev.clientX, ev.clientY, r.group,
            r.deals.map((d) => ({ name: `${d.target} (${d.announced?.slice(0, 4) ?? ""})`, value: d.value != null ? money(d.value) : "–" })),
            "Implied equity value: price per share times shares outstanding"))
          .on("pointerleave", hideTip);
      }
      f.g.append("text").attr("x", f.width).attr("y", rows.length * 46 + 12).attr("text-anchor", "end")
        .text("Implied equity value of the deals");
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
