// Column chart over discrete periods (quarters or years): a single series that may diverge around zero, or a
// stack of a few categories. Columns are <= 24px wide, square at the baseline with a 4px rounded data end, and a
// 2px surface gap separates stacked segments.
import { scaleBand, scaleLinear } from "d3-scale";
import { pointer } from "d3-selection";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { responsive, valueAxis } from "./common";

export interface ColumnSeries {
  key: string;
  label: string;
  color: string; // CSS color (var(...))
  values: (number | null)[];
}

export interface ColumnOpts {
  card: Card;
  label: string;
  periods: string[]; // labels per column
  tickEvery?: number;
  height?: number;
  fmt: (v: number) => string;
  getSeries: () => ColumnSeries[]; // one series = single; several = stacked (non-negative values)
  divergingColors?: { neg: string; pos: string }; // single series colored by sign
  title?: (i: number) => string;
  note?: (i: number) => string | undefined;
  onHover?: (i: number | null) => void;
}

function colPath(x: number, w: number, y0: number, y1: number, roundTop: boolean, r = 4): string {
  // y0 = baseline side, y1 = data end
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  const rr = roundTop ? Math.min(r, w / 2, h) : 0;
  if (up) {
    return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`;
}

export function columnChart(o: ColumnOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: o.height ?? 240, label: o.label, margin: { left: 48, right: 12, bottom: 26 } }, (f) => {
      const ss = o.getSeries();
      const n = o.periods.length;
      const x = scaleBand<number>().domain(Array.from({ length: n }, (_, i) => i)).range([0, f.width]).paddingInner(0.25);
      const stacked = ss.length > 1;
      let lo = 0;
      let hi = 0;
      for (let i = 0; i < n; i++) {
        if (stacked) {
          hi = Math.max(hi, ss.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
        } else {
          const v = ss[0]?.values[i];
          if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        }
      }
      if (lo === 0 && hi === 0) hi = 1;
      const padY = (hi - lo) * 0.05;
      const y = scaleLinear().domain([lo < 0 ? lo - padY : 0, hi > 0 ? hi + padY : 0]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, o.fmt, 4);
      f.g.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0)).style("stroke", "var(--axis)");
      const w = Math.min(24, x.bandwidth());
      const off = (x.bandwidth() - w) / 2;
      const every = o.tickEvery ?? Math.max(1, Math.ceil(n / Math.max(2, Math.floor(f.width / 46))));
      f.g.append("g").selectAll("text").data(o.periods.map((p, i) => ({ p, i })).filter((d) => d.i % every === 0)).join("text")
        .attr("x", (d) => x(d.i)! + x.bandwidth() / 2).attr("y", f.height + 16).attr("text-anchor", "middle").text((d) => d.p);
      const g = f.g.append("g");
      for (let i = 0; i < n; i++) {
        const cx = x(i)! + off;
        if (stacked) {
          let acc = 0;
          const parts = ss.map((s) => ({ s, v: Math.max(0, s.values[i] ?? 0) })).filter((p) => p.v > 0);
          parts.forEach((p, k) => {
            const yb = y(acc);
            const yt = y(acc + p.v);
            const gap = k > 0 ? 1 : 0; // half of the 2px surface gap on each side of a seam
            g.append("path").attr("d", colPath(cx, w, yb - gap, Math.min(yb - gap, yt + (k < parts.length - 1 ? 1 : 0)), k === parts.length - 1))
              .style("fill", p.s.color);
            acc += p.v;
          });
        } else {
          const v = ss[0]?.values[i];
          if (v == null || v === 0) continue;
          const color = o.divergingColors ? (v < 0 ? o.divergingColors.neg : o.divergingColors.pos) : ss[0].color;
          g.append("path").attr("d", colPath(cx, w, y(0), y(v), true)).style("fill", color);
        }
      }
      const hl = f.g.append("rect").attr("y", 0).attr("height", f.height).style("fill", "var(--ink)").style("opacity", 0.06).style("display", "none");
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const [mx] = pointer(ev);
          const i = Math.max(0, Math.min(n - 1, Math.floor(mx / x.step())));
          hl.style("display", null).attr("x", x(i)! - (x.step() - x.bandwidth()) / 2).attr("width", x.step());
          const rows: TipRow[] = ss.filter((s) => s.values[i] != null).map((s) => ({
            color: o.divergingColors && !stacked ? ((s.values[i] as number) < 0 ? o.divergingColors.neg : o.divergingColors.pos) : s.color,
            name: s.label, value: o.fmt(s.values[i] as number),
          }));
          if (stacked) rows.push({ name: "Total", value: o.fmt(ss.reduce((a, s) => a + (s.values[i] ?? 0), 0)), strong: true });
          showTip(ev.clientX, ev.clientY, o.title ? o.title(i) : o.periods[i], rows, o.note?.(i));
          o.onHover?.(i);
        })
        .on("pointerleave", () => { hideTip(); hl.style("display", "none"); o.onHover?.(null); });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
