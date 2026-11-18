// Small multiples of a scenario's shocks, one panel per driver, one column per forecast quarter.
// Each panel has its own zero-centered scale (they are different units), so panels are not compared by height.
import { scaleBand, scaleLinear } from "d3-scale";
import { hideTip, showTip } from "../ui";
import { responsive } from "./common";

export interface ShockPanel {
  title: string;
  values: number[];
  fmt: (v: number) => string;
}

export interface ShockSpec {
  label: string;
  panels: ShockPanel[];
  quarters: string[]; // labels, one per column
}

const PANEL_H = 112;
const ROW_GAP = 18;

function columnPath(x: number, w: number, y0: number, y1: number, r = 4): string {
  const h = Math.abs(y1 - y0);
  const rr = Math.min(r, w / 2, h / 2);
  if (h < 0.5) return "";
  if (y1 <= y0) {
    // grows upward: round the top
    return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`;
}

export function drawShockPanels(host: HTMLElement, getSpec: () => ShockSpec | null): () => void {
  const cols = (w: number) => (w >= 560 ? 2 : 1);
  return responsive(host, {
    height: (w) => {
      const s = getSpec();
      const n = s?.panels.length ?? 0;
      const rows = Math.ceil(n / cols(w));
      return Math.max(80, rows * PANEL_H + Math.max(0, rows - 1) * ROW_GAP + 6);
    },
    margin: { top: 4, right: 4, bottom: 2, left: 4 },
    label: getSpec()?.label ?? "Scenario shocks",
  }, (fr) => {
    const spec = getSpec();
    if (!spec || !spec.panels.length) return;
    const nc = cols(fr.width + 8);
    const gap = 18;
    const pw = (fr.width - gap * (nc - 1)) / nc;
    spec.panels.forEach((p, i) => {
      const cx = (i % nc) * (pw + gap);
      const cy = Math.floor(i / nc) * (PANEL_H + ROW_GAP);
      const g = fr.g.append("g").attr("transform", `translate(${cx},${cy})`);
      g.append("text").attr("class", "label strong").attr("x", 0).attr("y", 12).text(p.title);
      let iPeak = 0;
      p.values.forEach((v, j) => {
        if (Math.abs(v) > Math.abs(p.values[iPeak])) iPeak = j;
      });
      // the one direct label: the peak, in the title row, where it cannot collide with the bars or the axis
      g.append("text").attr("class", "label").attr("x", pw).attr("y", 12).attr("text-anchor", "end")
        .text(`peak ${p.fmt(p.values[iPeak])} in ${spec.quarters[iPeak]}`);
      const top = 22;
      const bottom = PANEL_H - 22;
      const lo = Math.min(0, ...p.values);
      const hi = Math.max(0, ...p.values);
      const span = hi - lo || 1;
      const y = scaleLinear().domain([lo - span * 0.12, hi + span * 0.12]).range([bottom, top + 10]);
      const x = scaleBand<number>().domain(p.values.map((_, j) => j)).range([0, pw]).paddingInner(0.3).paddingOuter(0.15);
      const bw = Math.min(24, x.bandwidth());
      const y0 = y(0);
      g.append("line").attr("x1", 0).attr("x2", pw).attr("y1", y0).attr("y2", y0).style("stroke", "var(--axis)");
      p.values.forEach((v, j) => {
        const bx = x(j)! + (x.bandwidth() - bw) / 2;
        const d = columnPath(bx, bw, y0, y(v));
        if (d) g.append("path").attr("d", d).style("fill", "var(--s2)");
        g.append("rect").attr("class", "hit").attr("x", x(j)!).attr("y", top).attr("width", x.bandwidth())
          .attr("height", bottom - top + 14)
          .on("pointermove", (ev: PointerEvent) =>
            showTip(ev.clientX, ev.clientY, spec.quarters[j], [{ name: p.title, value: p.fmt(v), strong: true }]))
          .on("pointerleave", hideTip);
      });
      g.append("text").attr("class", "label").attr("x", 0).attr("y", PANEL_H - 6).text(spec.quarters[0]);
      g.append("text").attr("class", "label").attr("x", pw).attr("y", PANEL_H - 6).attr("text-anchor", "end")
        .text(spec.quarters[spec.quarters.length - 1]);
    });
  });
}
