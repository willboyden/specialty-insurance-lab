// Company x quarter heatmap. Diverging color around a reference (100% combined ratio, zero development) or a
// one-hue sequential ramp for metrics without a natural center. Rows are companies grouped by segment.
import { scaleBand, scaleDiverging, scaleSequential } from "d3-scale";
import { interpolateRgbBasis } from "d3-interpolate";
import { pointer } from "d3-selection";
import type { Num } from "../types";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { css, isoToDate, responsive, yearFmt } from "./common";
import { quarterLabel } from "../format";

export interface HeatRow {
  id: number;
  label: string;
  name: string;
  group: string;
  values: Num[];
}

export interface HeatmapOpts {
  card: Card;
  store: Store;
  label: string;
  quarters: string[];
  getFrom: () => string;
  getRows: () => HeatRow[];
  fmt: (v: number) => string;
  /** diverging around center (below = good when goodLow), else a one-hue ramp over the visible values */
  getScale: () => { center?: number; span?: number; goodLow?: boolean };
}

const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

export function heatmapChart(o: HeatmapOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    const rows = o.getRows();
    const rowH = 13;
    responsive(o.card.body, {
      height: () => rows.length * rowH + 48 + new Set(rows.map((r) => r.group)).size * 6,
      label: o.label, margin: { left: 58, right: 10, top: 6, bottom: 24 },
    }, (f) => {
      const from = o.getFrom();
      const idx = o.quarters.map((_, i) => i).filter((i) => o.quarters[i] >= from);
      const x = scaleBand<number>().domain(idx).range([0, f.width]).paddingInner(0.06);
      // rows with a small gap between segments
      const yPos = new Map<number, number>();
      let yy = 0;
      let prev = "";
      for (const r of rows) {
        if (prev && r.group !== prev) yy += 6;
        yPos.set(r.id, yy);
        yy += rowH;
        prev = r.group;
      }
      const negC = css("--div-neg"), midC = css("--div-mid"), posC = css("--div-pos");
      let color: (v: number) => string;
      const sp = o.getScale();
      if (sp.center !== undefined) {
        const span = sp.span ?? 0.25;
        const [loC, hiC] = sp.goodLow === false ? [posC, negC] : [negC, posC];
        const sc = scaleDiverging(interpolateRgbBasis([loC, midC, hiC])).domain([sp.center - span, sp.center, sp.center + span]).clamp(true);
        color = (v) => sc(v);
      } else {
        const vals = rows.flatMap((r) => idx.map((i) => r.values[i])).filter((v): v is number => v != null).sort((a, b) => a - b);
        const lo = vals[Math.floor(0.03 * (vals.length - 1))] ?? 0;
        const hi = vals[Math.ceil(0.97 * (vals.length - 1))] ?? 1;
        const sc = scaleSequential(interpolateRgbBasis(SEQ)).domain([lo, hi]).clamp(true);
        color = (v) => sc(v);
      }
      const st = o.store.get();
      const g = f.g.append("g");
      for (const r of rows) {
        const ry = yPos.get(r.id)!;
        const rowG = g.append("g").attr("transform", `translate(0,${ry})`);
        rowG.selectAll("rect").data(idx.filter((i) => r.values[i] != null)).join("rect")
          .attr("x", (i) => x(i)!).attr("width", x.bandwidth()).attr("height", rowH - 2)
          .style("fill", (i) => color(r.values[i] as number));
        f.g.append("text").attr("x", -6).attr("y", ry + rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end")
          .attr("class", r.id === st.selected ? "label strong" : "label").style("font-size", "10.5px").text(r.label);
      }
      const sel = yPos.get(st.selected);
      if (sel !== undefined) {
        f.g.append("rect").attr("x", -1).attr("y", sel - 1).attr("width", f.width + 2).attr("height", rowH)
          .style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.5).attr("rx", 2);
      }
      // year ticks
      const years = idx.filter((i) => o.quarters[i].slice(5, 7) === "03" && Number(o.quarters[i].slice(0, 4)) % 2 === 0);
      f.g.append("g").selectAll("text").data(years).join("text")
        .attr("x", (i) => x(i)!).attr("y", yy + 14).text((i) => yearFmt(isoToDate(o.quarters[i])));
      const cross = f.g.append("rect").attr("y", -2).attr("height", yy + 2).attr("width", x.bandwidth() + 2)
        .style("fill", "none").style("stroke", "var(--ink-3)").style("display", "none");
      const hoverRow = f.g.append("rect").attr("x", -1).attr("width", f.width + 2).attr("height", rowH)
        .style("fill", "none").style("stroke", "var(--ink-3)").style("display", "none").attr("rx", 2);
      const rowAt = (py: number) => {
        let best: HeatRow | null = null;
        for (const r of rows) { const ry = yPos.get(r.id)!; if (py >= ry && py < ry + rowH) best = r; }
        return best;
      };
      const showCol = (q: string | null) => {
        const i = q ? o.quarters.indexOf(q) : -1;
        if (i >= 0 && x(i) !== undefined) cross.style("display", null).attr("x", x(i)! - 1);
        else cross.style("display", "none");
      };
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", yy).style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const step = x.step();
          const k = Math.max(0, Math.min(idx.length - 1, Math.floor(mx / step)));
          const i = idx[k];
          const r = rowAt(my);
          o.store.set({ hoverQuarter: o.quarters[i], hover: r ? r.id : null });
          showCol(o.quarters[i]);
          if (r) {
            hoverRow.style("display", null).attr("y", yPos.get(r.id)! - 1);
            const v = r.values[i];
            showTip(ev.clientX, ev.clientY, `${r.name}`, [{ name: quarterLabel(o.quarters[i]), value: v == null ? "no data" : o.fmt(v), strong: true }], "Click to focus this company");
          } else { hoverRow.style("display", "none"); hideTip(); }
        })
        .on("pointerleave", () => { hideTip(); hoverRow.style("display", "none"); cross.style("display", "none"); o.store.set({ hoverQuarter: null, hover: null }); })
        .on("click", (ev: PointerEvent) => { const r = rowAt(pointer(ev)[1]); if (r) o.store.set({ selected: r.id }); });
      const unsub = o.store.on(["hoverQuarter", "hover"], (s2, changed) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        if (changed.has("hoverQuarter")) showCol(s2.hoverQuarter);
        if (changed.has("hover")) {
          const ry = s2.hover != null ? yPos.get(s2.hover) : undefined;
          if (ry !== undefined) hoverRow.style("display", null).attr("y", ry - 1);
          else hoverRow.style("display", "none");
        }
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}

/** a small horizontal scale legend for the heatmap */
export function heatLegend(host: HTMLElement, o: { center?: number; span?: number; goodLow?: boolean; fmt: (v: number) => string; lowLabel: string; highLabel: string }) {
  host.replaceChildren();
  const bar = document.createElement("span");
  bar.style.display = "inline-block";
  bar.style.width = "120px";
  bar.style.height = "8px";
  bar.style.borderRadius = "4px";
  bar.style.background = o.center !== undefined
    ? `linear-gradient(90deg, var(${o.goodLow === false ? "--div-pos" : "--div-neg"}), var(--div-mid), var(${o.goodLow === false ? "--div-neg" : "--div-pos"}))`
    : `linear-gradient(90deg, ${SEQ.join(",")})`;
  const lo = document.createElement("span");
  lo.textContent = o.lowLabel;
  const hi = document.createElement("span");
  hi.textContent = o.highLabel;
  const wrap = document.createElement("span");
  wrap.className = "key";
  wrap.append(lo, bar, hi);
  host.append(wrap);
}
