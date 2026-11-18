// Time-series emphasis chart: many peers as thin gray context lines, the focus company in the accent, a few
// reference series (medians, aggregates) in categorical colors. A crosshair snaps to the nearest quarter and is
// shared through the store; the peer line nearest the pointer lights up, and a click selects it.
import { scaleLinear, scaleUtc } from "d3-scale";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import type { Num } from "../types";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { isoToDate, nearestIndex, responsive, timeAxis, valueAxis } from "./common";
import { quarterLabel } from "../format";

export interface LineSeries {
  id: string; // company cik as string, or a reference key
  label: string;
  values: Num[];
  role: "context" | "focus" | "ref";
  color?: string; // CSS color for focus/ref
}

export interface LineChartOpts {
  card: Card;
  store: Store;
  quarters: string[];
  height?: number | ((w: number) => number);
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  getRef?: () => { value: number; label: string } | undefined;
  label: string;
  getSeries: () => LineSeries[];
  getFrom: () => string;
  partialFrom?: string; // quarters at/after this are drawn as "to date"
  clipQuantiles?: [number, number]; // robust y-domain over all visible values
  zeroLine?: boolean;
  selectable?: boolean; // context lines are companies: hover highlights and click selects
}

export function lineChart(o: LineChartOpts) {
  const dates = o.quarters.map(isoToDate);
  let hoverLine: string | null = null;

  const draw = () => {
    if (o.card.showingTable()) return;
    // narrow screens: no end labels (the legend names every series), the plot gets the width back
    const narrow = (w: number) => w < 520;
    responsive(o.card.body, { height: o.height ?? 320, label: o.label, margin: (w) => ({ right: narrow(w) ? 12 : 96 }) }, (f) => {
      const showEnds = f.width + f.margin.left + f.margin.right >= 520;
      const from = o.getFrom();
      const i0 = Math.max(0, o.quarters.findIndex((q) => q >= from));
      const idx = dates.map((_, i) => i).filter((i) => i >= i0);
      const all = o.getSeries();
      const x = scaleUtc().domain([dates[i0], dates[dates.length - 1]]).range([0, f.width]);
      const vals: number[] = [];
      for (const s of all) for (const i of idx) { const v = s.values[i]; if (v != null && Number.isFinite(v)) vals.push(v); }
      vals.sort((a, b) => a - b);
      const [ql, qh] = o.clipQuantiles ?? [0.02, 0.98];
      let lo = vals.length ? vals[Math.floor(ql * (vals.length - 1))] : 0;
      let hi = vals.length ? vals[Math.ceil(qh * (vals.length - 1))] : 1;
      for (const s of all) if (s.role !== "context") for (const i of idx) { const v = s.values[i]; if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      const ref = o.getRef?.();
      if (ref) { lo = Math.min(lo, ref.value); hi = Math.max(hi, ref.value); }
      if (o.zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      const pad = (hi - lo) * 0.06 || 0.05;
      const y = scaleLinear().domain([lo - pad, hi + pad]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, o.axisFmt ?? o.fmt);
      timeAxis(f.g, x, f.height, f.width);

      const clipId = `clip-${Math.random().toString(36).slice(2)}`;
      f.svg.append("defs").append("clipPath").attr("id", clipId)
        .append("rect").attr("x", 0).attr("y", -2).attr("width", f.width).attr("height", f.height + 4);
      const plot = f.g.append("g").attr("clip-path", `url(#${clipId})`);

      if (ref) {
        const r = f.g.append("g").attr("class", "ref");
        r.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(ref.value)).attr("y2", y(ref.value));
        r.append("text").attr("class", "halo").attr("x", f.width - 4).attr("y", y(ref.value) - 5).attr("text-anchor", "end").text(ref.label);
      }
      if (o.zeroLine) {
        f.g.append("g").attr("class", "ref").append("line")
          .attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0));
      }

      const pathFor = (s: LineSeries) => {
        const g2 = d3line<number>()
          .defined((i) => i >= i0 && s.values[i] != null && Number.isFinite(s.values[i] as number))
          .x((i) => x(dates[i]))
          .y((i) => y(s.values[i] as number));
        return g2(dates.map((_, i) => i)) ?? "";
      };

      const ctx = all.filter((s) => s.role === "context");
      const ctxPaths = plot.append("g").selectAll("path").data(ctx).join("path")
        .attr("class", (s) => `ctx${s.id === hoverLine ? " hot" : ""}`)
        .attr("d", pathFor);
      const refs = all.filter((s) => s.role !== "context");
      plot.append("g").selectAll("path").data(refs).join("path")
        .attr("class", "line")
        .style("stroke", (s) => s.color ?? "var(--s1)")
        .attr("d", pathFor);

      // end labels for focus/ref series (text in ink, a short colored key beside it)
      const ends = refs.map((s) => {
        let j = -1;
        for (let i = s.values.length - 1; i >= i0; i--) if (s.values[i] != null) { j = i; break; }
        return { s, j, yv: j >= 0 ? y(s.values[j] as number) : NaN };
      }).filter((e) => e.j >= 0).sort((a, b) => a.yv - b.yv);
      for (let k = 1; k < ends.length; k++) if (ends[k].yv - ends[k - 1].yv < 13) ends[k].yv = ends[k - 1].yv + 13;
      const lab = f.g.append("g");
      for (const e of showEnds ? ends : []) {
        lab.append("circle").attr("class", "dot").attr("r", 4)
          .attr("cx", x(dates[e.j])).attr("cy", y(e.s.values[e.j] as number))
          .style("fill", e.s.color ?? "var(--s1)");
        lab.append("line").attr("x1", f.width + 6).attr("x2", f.width + 14).attr("y1", e.yv).attr("y2", e.yv)
          .style("stroke", e.s.color ?? "var(--s1)").style("stroke-width", 2);
        lab.append("text").attr("class", e.s.role === "focus" ? "label strong" : "label")
          .attr("x", f.width + 17).attr("y", e.yv).attr("dy", "0.32em")
          .text(`${shortLabel(e.s.label)} ${o.fmt(e.s.values[e.j] as number)}`);
      }

      // crosshair + interaction layer
      const cross = f.g.append("g").attr("class", "crosshair").style("display", "none");
      const vline = cross.append("line").attr("y1", 0).attr("y2", f.height);
      const hitDots = cross.append("g");
      const showAt = (i: number) => {
        const cx = x(dates[i]);
        cross.style("display", null);
        vline.attr("x1", cx).attr("x2", cx);
        hitDots.selectAll("circle").data(refs.filter((s) => s.values[i] != null)).join("circle")
          .attr("class", "dot").attr("r", 4).attr("cx", cx).attr("cy", (s) => y(s.values[i] as number))
          .style("fill", (s) => s.color ?? "var(--s1)");
      };
      const unsub = o.store.on(["hoverQuarter", "hover"], (st, changed) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        if (changed.has("hoverQuarter")) {
          const i = st.hoverQuarter ? o.quarters.indexOf(st.hoverQuarter) : -1;
          if (i >= i0) showAt(i); else cross.style("display", "none");
        }
        if (changed.has("hover")) {
          // linked highlighting: a company hovered in another view lights up here too
          const id = st.hover != null ? String(st.hover) : null;
          ctxPaths.attr("class", (s) => `ctx${s.id === id ? " hot" : ""}`);
          if (id) ctxPaths.filter((s) => s.id === id).raise();
        }
      });

      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .style("cursor", o.selectable ? "pointer" : "crosshair")
        .on("pointermove", (ev: PointerEvent) => {
          const [px, py] = pointer(ev);
          const i = Math.max(i0, nearestIndex(dates, x.invert(px)));
          o.store.set({ hoverQuarter: o.quarters[i] });
          showAt(i);
          // nearest context line at this quarter
          let best: LineSeries | null = null;
          let bestD = 14;
          if (o.selectable) {
            for (const s of ctx) {
              const v = s.values[i];
              if (v == null) continue;
              const d = Math.abs(y(v) - py);
              if (d < bestD) { bestD = d; best = s; }
            }
          }
          const id = best?.id ?? null;
          if (id !== hoverLine) {
            hoverLine = id;
            ctxPaths.attr("class", (s) => `ctx${s.id === hoverLine ? " hot" : ""}`);
            ctxPaths.filter((s) => s.id === hoverLine).raise();
            o.store.set({ hover: id ? Number(id) : null });
          }
          const rows: TipRow[] = refs
            .filter((s) => s.values[i] != null)
            .map((s) => ({ color: s.color ?? "var(--s1)", name: s.label, value: o.fmt(s.values[i] as number), strong: s.role === "focus" }));
          if (best && best.values[i] != null) rows.push({ color: "var(--context-strong)", name: best.label, value: o.fmt(best.values[i] as number) });
          showTip(ev.clientX, ev.clientY, quarterLabel(o.quarters[i]), rows,
            o.partialFrom && o.quarters[i] >= o.partialFrom ? "Quarter to date" : best ? "Click to focus this company" : undefined);
        })
        .on("pointerleave", () => {
          hideTip();
          cross.style("display", "none");
          o.store.set({ hoverQuarter: null, hover: null });
          if (hoverLine) { hoverLine = null; ctxPaths.attr("class", "ctx"); }
        })
        .on("click", () => {
          if (o.selectable && hoverLine) o.store.set({ selected: Number(hoverLine) });
        });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}

function shortLabel(label: string): string {
  return label.length > 16 ? label.slice(0, 15) + "…" : label;
}
