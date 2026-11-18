// Horizontal bars for a short ranked list (one hue: these are magnitudes of one measure). Bars grow from zero,
// at most 22px thick, 4px rounded data end; the value sits at the bar tip and the name on the left.
import { scaleBand, scaleLinear } from "d3-scale";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { responsive } from "./common";

export interface BarItem {
  key: string;
  label: string;
  value: number;
  tip?: TipRow[];
  note?: string;
}

export function barList(o: { card: Card; label: string; items: BarItem[]; fmt: (v: number) => string }): () => void {
  const ROW = 26;
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, {
      height: o.items.length * ROW + 8, label: o.label,
      margin: (w) => ({ left: Math.min(190, w * 0.44), right: 58, top: 4, bottom: 4 }),
    }, (f) => {
      const x = scaleLinear().domain([0, Math.max(...o.items.map((d) => d.value))]).range([0, f.width]);
      const y = scaleBand<string>().domain(o.items.map((d) => d.key)).range([0, o.items.length * ROW]).paddingInner(0.28);
      const bh = Math.min(22, y.bandwidth());
      for (const d of o.items) {
        const top = (y(d.key) ?? 0) + (y.bandwidth() - bh) / 2;
        const w = Math.max(1, x(d.value));
        const r = Math.min(4, w / 2, bh / 2);
        f.g.append("path").style("fill", "var(--s1)")
          .attr("d", `M0,${top}H${w - r}Q${w},${top} ${w},${top + r}V${top + bh - r}Q${w},${top + bh} ${w - r},${top + bh}H0Z`);
        f.g.append("text").attr("class", "label").attr("x", -8).attr("y", top + bh / 2).attr("dy", "0.32em")
          .attr("text-anchor", "end").text(d.label);
        f.g.append("text").attr("class", "label strong").attr("x", w + 6).attr("y", top + bh / 2).attr("dy", "0.32em")
          .text(o.fmt(d.value));
        f.g.append("rect").attr("class", "hit").attr("x", -f.margin.left).attr("y", y(d.key) ?? 0)
          .attr("width", f.width + f.margin.left + f.margin.right).attr("height", y.bandwidth())
          .on("pointermove", (ev: PointerEvent) => showTip(ev.clientX, ev.clientY, d.label,
            [{ color: "var(--s1)", name: o.label, value: o.fmt(d.value), strong: true }, ...(d.tip ?? [])], d.note))
          .on("pointerleave", hideTip);
      }
    });
  };
  o.card.onRedraw(draw);
  draw();
  return draw;
}
