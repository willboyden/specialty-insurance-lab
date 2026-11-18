// Horizontal waterfall of one fiscal year's loss-reserve roll-forward: opening reserves, what was added (losses
// incurred) and taken out (claims paid), reserve development in the diverging colors, the remainder the tagged
// roll-forward does not explain, and the closing reserves. One row per step so labels never collide on a phone.
import { scaleBand, scaleLinear } from "d3-scale";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";

export interface WaterStep {
  label: string;
  short?: string; // label on narrow screens
  value: number; // totals: the level; flows: the change
  kind: "total" | "flow" | "dev";
  note?: string;
}

export interface WaterfallOpts {
  card: Card;
  label: string;
  getSteps: () => WaterStep[];
  fmt: (v: number) => string;
  title: () => string;
}

function hbar(x0: number, x1: number, y: number, h: number, r = 4): string {
  // square at the start, rounded at the end the bar grows to
  const a = Math.min(x0, x1);
  const b = Math.max(x0, x1);
  const rr = Math.min(r, (b - a) / 2, h / 2);
  if (x1 >= x0) return `M${a},${y}H${b - rr}Q${b},${y} ${b},${y + rr}V${y + h - rr}Q${b},${y + h} ${b - rr},${y + h}H${a}Z`;
  return `M${b},${y}H${a + rr}Q${a},${y} ${a},${y + rr}V${y + h - rr}Q${a},${y + h} ${a + rr},${y + h}H${b}Z`;
}

export function waterfall(o: WaterfallOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    const steps = o.getSteps();
    const narrow = (w: number) => w < 480;
    const rowH = (w: number) => (narrow(w) ? 30 : 36);
    responsive(o.card.body, {
      height: (w) => Math.max(1, steps.length) * rowH(w) + 24, label: o.label,
      margin: (w) => ({ left: narrow(w) ? 92 : 156, right: 64, top: 4, bottom: 18 }),
    }, (f) => {
      const isNarrow = narrow(f.width + f.margin.left + f.margin.right);
      const rh = rowH(f.width + f.margin.left + f.margin.right);
      if (!steps.length) {
        f.g.append("text").attr("x", 0).attr("y", 20).text("No roll-forward tagged for this year.");
        return;
      }
      // running level: totals reset it, flows move it
      const spans: { s: WaterStep; a: number; b: number }[] = [];
      let level = 0;
      for (const s of steps) {
        if (s.kind === "total") { spans.push({ s, a: 0, b: s.value }); level = s.value; } else { spans.push({ s, a: level, b: level + s.value }); level += s.value; }
      }
      const lo = Math.min(0, ...spans.map((d) => Math.min(d.a, d.b)));
      const hi = Math.max(...spans.map((d) => Math.max(d.a, d.b)));
      const x = scaleLinear().domain([lo, hi]).range([0, f.width]).nice();
      const y = scaleBand<number>().domain(spans.map((_, i) => i)).range([0, spans.length * rh]).paddingInner(0.32);
      const bh = Math.min(22, y.bandwidth());
      const color = (d: { s: WaterStep }) =>
        d.s.kind === "total" ? "var(--context-strong)" : d.s.kind === "dev" ? (d.s.value < 0 ? "var(--div-neg)" : "var(--div-pos)") : "var(--s3)";
      f.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", -2).attr("y2", spans.length * rh).style("stroke", "var(--axis)");
      const rows = f.g.append("g").selectAll("g").data(spans).join("g").attr("transform", (_, i) => `translate(0,${y(i)})`);
      rows.append("path").attr("d", (d) => hbar(x(d.a), x(d.b), (y.bandwidth() - bh) / 2, bh))
        .style("fill", color).style("fill-opacity", (d) => (d.s.kind === "flow" ? 0.85 : 1));
      // connector from each bar's end to the next row
      spans.forEach((d, i) => {
        if (i === spans.length - 1) return;
        const yy = y(i)! + (y.bandwidth() + bh) / 2;
        f.g.append("line").attr("x1", x(d.b)).attr("x2", x(d.b)).attr("y1", yy).attr("y2", y(i + 1)! + (y.bandwidth() - bh) / 2)
          .style("stroke", "var(--axis)").style("stroke-dasharray", "2 2");
      });
      rows.append("text").attr("x", -8).attr("y", y.bandwidth() / 2).attr("dy", "0.32em").attr("text-anchor", "end")
        .attr("class", (d) => (d.s.kind === "total" ? "label strong" : "label")).text((d) => (isNarrow ? d.s.short ?? d.s.label : d.s.label));
      rows.append("text").attr("class", (d) => (d.s.kind === "total" ? "label strong" : "label"))
        .attr("x", (d) => x(Math.max(d.a, d.b)) + 5).attr("y", y.bandwidth() / 2).attr("dy", "0.32em")
        .text((d) => (d.s.kind === "total" ? o.fmt(d.s.value) : `${d.s.value >= 0 ? "+" : "−"}${o.fmt(Math.abs(d.s.value))}`));
      rows.append("rect").attr("class", "hit").attr("x", -f.margin.left).attr("width", f.width + f.margin.left + f.margin.right)
        .attr("height", y.step()).attr("y", -(y.step() - y.bandwidth()) / 2)
        .on("pointermove", (ev: PointerEvent, d) => showTip(ev.clientX, ev.clientY, d.s.label, [
          { color: color(d), name: d.s.kind === "total" ? "Net loss reserves" : "Change in reserves", value: d.s.kind === "total" ? o.fmt(d.s.value) : `${d.s.value >= 0 ? "+" : "−"}${o.fmt(Math.abs(d.s.value))}`, strong: true },
        ], d.s.note ?? o.title()))
        .on("pointerleave", hideTip);
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
