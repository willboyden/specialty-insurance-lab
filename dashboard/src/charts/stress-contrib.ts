// Diverging horizontal bars: how much each component moves a value (here: a combined ratio, in points),
// with the total on its own row. Positive = worse (red pole), negative = better (blue pole); value at the tip.
// Wide cards put the label beside the bar; narrow ones (phones) put it above, so bars keep the full width.
import { scaleLinear } from "d3-scale";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";

export interface ContribPart {
  label: string;
  value: number;
  note?: string;
}

export interface ContribSpec {
  label: string;
  parts: ContribPart[];
  total: ContribPart;
  fmt: (v: number) => string;
}

const ROW = 30; // label beside the bar
const ROW_STACKED = 42; // label above the bar
const BAR = 16;
const MARGIN = { top: 6, right: 12, bottom: 4, left: 12 };
const NARROW = 440; // inner width below which labels go above the bars

/** a horizontal bar from the baseline x0 to x1, rounded (4px) only at the data end */
function barPath(x0: number, x1: number, y: number, h: number, r = 4): string {
  const w = Math.abs(x1 - x0);
  const rr = Math.min(r, w / 2, h / 2);
  if (w < 0.5) return "";
  if (x1 >= x0) {
    return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  }
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

export function drawContrib(host: HTMLElement, getSpec: () => ContribSpec | null): () => void {
  const stacked = (outerW: number) => outerW - MARGIN.left - MARGIN.right < NARROW;
  return responsive(host, {
    height: (w) => {
      const s = getSpec();
      return s ? (s.parts.length + 1) * (stacked(w) ? ROW_STACKED : ROW) + 26 : 120;
    },
    margin: MARGIN,
    label: getSpec()?.label ?? "Contributions",
  }, (fr) => {
    const spec = getSpec();
    if (!spec) return;
    const rows = [...spec.parts, spec.total];
    const isStacked = fr.width < NARROW;
    const rowH = isStacked ? ROW_STACKED : ROW;
    let labelW = 0;
    if (!isStacked) {
      // measure the longest label as rendered, so a bar never starts under its own label
      const probe = fr.g.append("g").style("visibility", "hidden");
      let widest = 0;
      for (const r of rows) {
        const t = probe.append("text").attr("class", "label strong").text(r.label).node();
        widest = Math.max(widest, t ? t.getComputedTextLength() : r.label.length * 6.5);
      }
      probe.remove();
      labelW = Math.min(fr.width * 0.55, widest + 12);
    }
    const vals = rows.map((r) => r.value);
    const valueRoom = 62; // room for a tip label beyond the bar
    // asymmetric: only the side(s) that have bars get room, so a mostly one-signed chart uses its width
    const lo = Math.min(0, ...vals);
    let hi = Math.max(0, ...vals);
    if (hi - lo < 0.002) hi = lo + 0.002;
    const x = scaleLinear().domain([lo, hi])
      .range([labelW + (lo < 0 ? valueRoom : 6), fr.width - (hi > 0 ? valueRoom : 6)]);
    const g = fr.g;
    const x0 = x(0);
    const barY = isStacked ? 20 : (ROW - BAR) / 2;
    if (!isStacked) {
      g.append("line").attr("x1", x0).attr("x2", x0).attr("y1", 0).attr("y2", rows.length * rowH + 6)
        .style("stroke", "var(--axis)");
    }
    rows.forEach((r, i) => {
      const isTotal = i === rows.length - 1;
      const y = i * rowH + (isTotal ? 10 : 0);
      if (isTotal) {
        g.append("line").attr("x1", 0).attr("x2", fr.width).attr("y1", y - 5).attr("y2", y - 5)
          .style("stroke", "var(--grid)");
      }
      const row = g.append("g").attr("transform", `translate(0,${y})`);
      if (isStacked) {
        // zero line only across the bar band, so it never runs through the label above
        row.append("line").attr("x1", x0).attr("x2", x0).attr("y1", barY - 3).attr("y2", barY + BAR + 3)
          .style("stroke", "var(--axis)");
      }
      row.append("text").attr("class", isTotal ? "label strong" : "label").attr("x", 0)
        .attr("y", isStacked ? 12 : ROW / 2).attr("dy", isStacked ? null : "0.35em").text(r.label);
      const x1 = x(r.value);
      const d = barPath(x0, x1, barY, BAR);
      if (d) {
        row.append("path").attr("d", d)
          .style("fill", r.value > 0 ? "var(--div-pos)" : "var(--div-neg)")
          .style("opacity", isTotal ? 1 : 0.85);
      }
      const pos = r.value >= 0;
      row.append("text").attr("class", isTotal ? "label strong" : "label")
        .attr("x", pos ? x1 + 6 : x1 - 6).attr("y", barY + BAR / 2).attr("dy", "0.35em")
        .attr("text-anchor", pos ? "start" : "end").text(spec.fmt(r.value));
      row.append("rect").attr("class", "hit").attr("x", 0).attr("y", 0).attr("width", fr.width).attr("height", rowH)
        .on("pointermove", (ev: PointerEvent) =>
          showTip(ev.clientX, ev.clientY, r.label, [{ name: "change vs baseline", value: spec.fmt(r.value), strong: true }], r.note))
        .on("pointerleave", hideTip);
    });
  });
}
