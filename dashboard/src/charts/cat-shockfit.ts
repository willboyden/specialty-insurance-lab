// The loss model's industry shock (posterior mean + 80% band, accent) against the shock predicted from observed US
// perils (comparison color), on one sigma axis. Crosshair shared with every time chart through store.hoverQuarter;
// the largest quarters carry the catastrophe they coincide with.
import { scaleLinear, scaleUtc } from "d3-scale";
import { area as d3area, line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import type { Num } from "../types";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { isoToDate, nearestIndex, responsive, timeAxis, valueAxis } from "./common";
import { fmtSigma } from "./driver-panels";
import { quarterLabel } from "../format";

export interface ShockFitOpts {
  card: Card;
  store: Store;
  quarters: string[];
  f: Num[];
  f10: Num[];
  f90: Num[];
  fitted: Num[];
  events: Record<string, string>;
  labelTop: number;
}

export function shockFitChart(o: ShockFitOpts): () => void {
  const first = o.f.findIndex((v) => v != null);
  let last = -1;
  for (let i = o.f.length - 1; i >= 0; i--) if (o.f[i] != null) { last = i; break; }
  const idx = first >= 0 ? Array.from({ length: last - first + 1 }, (_, k) => first + k) : [];
  const dates = o.quarters.map(isoToDate);
  const ranked = idx.filter((i) => o.f[i] != null).sort((a, b) => (o.f[b] as number) - (o.f[a] as number));
  const labelled = ranked.slice(0, o.labelTop).filter((i) => o.events[o.quarters[i]]);

  const draw = () => {
    if (o.card.showingTable() || !idx.length) return;
    responsive(o.card.body, {
      height: (w) => (w < 640 ? 280 : 320), label: "Industry shock and the shock predicted from US perils, by quarter",
      margin: { top: 48, right: 16, bottom: 26, left: 40 },
    }, (fr) => {
      const x = scaleUtc().domain([dates[first], dates[last]]).range([0, fr.width]);
      const vals = idx.flatMap((i) => [o.f10[i], o.f90[i], o.f[i], o.fitted[i]]).filter((v): v is number => v != null);
      const y = scaleLinear().domain([Math.min(-1, ...vals), Math.max(1, ...vals)]).range([fr.height, 0]).nice();
      valueAxis(fr.g, y, fr.width, (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(0) + "σ", 5);
      timeAxis(fr.g, x, fr.height, fr.width);
      fr.g.append("g").attr("class", "ref").append("line")
        .attr("x1", 0).attr("x2", fr.width).attr("y1", y(0)).attr("y2", y(0));
      const band = d3area<number>().defined((i) => o.f10[i] != null && o.f90[i] != null)
        .x((i) => x(dates[i])).y0((i) => y(o.f10[i] as number)).y1((i) => y(o.f90[i] as number));
      fr.g.append("path").style("fill", "var(--band)").attr("d", band(idx) ?? "");
      const lineOf = (v: Num[]) => d3line<number>().defined((i) => v[i] != null).x((i) => x(dates[i])).y((i) => y(v[i] as number));
      fr.g.append("path").attr("class", "line").style("stroke", "var(--s2)").attr("d", lineOf(o.fitted)(idx) ?? "");
      fr.g.append("path").attr("class", "line").style("stroke", "var(--s1)").attr("d", lineOf(o.f)(idx) ?? "");

      // labels for the largest quarters, biggest first, on up to three rows above the plot: a label may not
      // overlap a label on its row, and no leader line may cross another label's text
      const ROWS = 3;
      const placed: { row: number; l: number; r: number; px: number }[] = [];
      const take = fr.width < 520 ? Math.min(4, labelled.length) : labelled.length;
      for (const i of labelled.slice(0, take)) {
        const px = x(dates[i]);
        const t = fr.g.append("text").attr("class", "b-annot halo").attr("text-anchor", "middle").text(o.events[o.quarters[i]]);
        const w = (t.node() as SVGTextElement).getComputedTextLength();
        const cx = Math.min(Math.max(px, w / 2), fr.width - w / 2);
        const l = cx - w / 2 - 4;
        const r = cx + w / 2 + 4;
        let row = -1;
        for (let k = 0; k < ROWS && row < 0; k++) {
          const clash = placed.some((p) => (p.row === k && !(r < p.l || l > p.r))
            || (p.row > k && px >= p.l && px <= p.r) || (p.row < k && p.px >= l && p.px <= r));
          if (!clash) row = k;
        }
        if (row < 0) { t.remove(); continue; }
        placed.push({ row, l, r, px });
        const ty = -fr.margin.top + 11 + row * 14;
        t.attr("x", cx).attr("y", ty);
        fr.g.append("line").attr("class", "b-leader").attr("x1", px).attr("x2", px).attr("y1", ty + 4)
          .attr("y2", y(o.f[i] as number) - 6);
      }

      const cross = fr.g.append("g").attr("class", "crosshair").style("display", "none");
      const vline = cross.append("line").attr("y1", 0).attr("y2", fr.height);
      const d1 = cross.append("circle").attr("class", "dot").attr("r", 4).style("fill", "var(--s1)");
      const d2 = cross.append("circle").attr("class", "dot").attr("r", 4).style("fill", "var(--s2)");
      const showAt = (i: number) => {
        cross.style("display", null);
        vline.attr("x1", x(dates[i])).attr("x2", x(dates[i]));
        for (const [dot, v] of [[d1, o.f[i]], [d2, o.fitted[i]]] as const) {
          if (v == null) dot.style("display", "none");
          else dot.style("display", null).attr("cx", x(dates[i])).attr("cy", y(v));
        }
      };
      const unsub = o.store.on(["hoverQuarter"], (st) => {
        if (!fr.svg.node()?.isConnected) { unsub(); return; }
        const i = st.hoverQuarter ? o.quarters.indexOf(st.hoverQuarter) : -1;
        if (i >= first && i <= last) showAt(i);
        else cross.style("display", "none");
      });
      fr.g.append("rect").attr("class", "hit").attr("width", fr.width).attr("height", fr.height).style("cursor", "crosshair")
        .on("pointermove", (ev: PointerEvent) => {
          const [px] = pointer(ev);
          const i = Math.min(last, Math.max(first, nearestIndex(dates, x.invert(px))));
          o.store.set({ hoverQuarter: o.quarters[i] });
          showAt(i);
          const f = o.f[i];
          const fit = o.fitted[i];
          const rows2: TipRow[] = [
            { color: "var(--s1)", name: "Industry shock (model)", value: fmtSigma(f), strong: true },
            { name: "80% interval", value: `${fmtSigma(o.f10[i])} to ${fmtSigma(o.f90[i])}` },
            { color: "var(--s2)", name: "Predicted from US perils", value: fit == null ? "no peril data" : fmtSigma(fit) },
          ];
          if (f != null && fit != null) rows2.push({ name: "Not explained by US perils", value: fmtSigma(f - fit) });
          const ev2 = o.events[o.quarters[i]];
          showTip(ev.clientX, ev.clientY, quarterLabel(o.quarters[i]), rows2, ev2 ? `Coincides with ${ev2}` : undefined);
        })
        .on("pointerleave", () => {
          hideTip();
          cross.style("display", "none");
          o.store.set({ hoverQuarter: null });
        });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return draw;
}

// ---------------------------------------------------------------- coefficients
export interface CoefRow {
  key: string;
  label: string; // full, for the tooltip
  short: string; // on the chart
  coef: number;
  se: number;
  r: number | null;
}

/** Standardized coefficients with 95% intervals (one row per peril index), the simple correlation at the right. */
export function coefChart(o: { card: Card; rows: CoefRow[] }): () => void {
  const ROW = 46;
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, {
      height: o.rows.length * ROW + 34, label: "How much each peril index moves the industry shock",
      margin: (w) => ({ left: Math.min(150, w * 0.4), right: 16, top: 8, bottom: 26 }),
    }, (fr) => {
      const ext = o.rows.flatMap((r) => [r.coef - 1.96 * r.se, r.coef + 1.96 * r.se]);
      const x = scaleLinear().domain([Math.min(0, ...ext), Math.max(0, ...ext)]).range([0, fr.width]).nice();
      const nT = Math.max(2, Math.min(5, Math.floor(fr.width / 64)));
      const fmtT = (t: number) => (t > 0 ? "+" : t < 0 ? "−" : "") + Math.abs(t).toFixed(x.ticks(nT).some((v) => !Number.isInteger(v * 2)) ? 2 : 1) + "σ";
      fr.g.append("g").attr("class", "grid").call((g) => {
        for (const t of x.ticks(nT)) {
          g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", 0).attr("y2", o.rows.length * ROW);
        }
      });
      const ax = fr.g.append("g").attr("class", "axis").attr("transform", `translate(0,${o.rows.length * ROW + 4})`);
      for (const t of x.ticks(nT)) ax.append("text").attr("x", x(t)).attr("y", 12).attr("text-anchor", "middle").text(fmtT(t));
      fr.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", o.rows.length * ROW)
        .style("stroke", "var(--ink-3)");
      o.rows.forEach((r, k) => {
        const cy = k * ROW + ROW / 2;
        const lab = fr.g.append("text").attr("class", "label").attr("x", -10).attr("y", cy - 6).attr("text-anchor", "end");
        lab.text(r.short);
        fr.g.append("text").attr("class", "label").attr("x", -10).attr("y", cy + 9).attr("text-anchor", "end")
          .style("fill", "var(--ink-3)").text(r.r == null ? "" : `alone: r = ${r.r.toFixed(2).replace("-", "−")}`);
        const lo = r.coef - 1.96 * r.se;
        const hi = r.coef + 1.96 * r.se;
        fr.g.append("line").attr("x1", x(lo)).attr("x2", x(hi)).attr("y1", cy).attr("y2", cy)
          .style("stroke", "var(--s1)").style("stroke-width", 3).style("stroke-linecap", "round").style("opacity", 0.45);
        fr.g.append("circle").attr("class", "dot").attr("cx", x(r.coef)).attr("cy", cy).attr("r", 5.5).style("fill", "var(--s1)");
        fr.g.append("rect").attr("class", "hit").attr("x", -fr.margin.left).attr("y", k * ROW)
          .attr("width", fr.width + fr.margin.left).attr("height", ROW)
          .on("pointermove", (ev: PointerEvent) => {
            showTip(ev.clientX, ev.clientY, r.label, [
              { color: "var(--s1)", name: "Shock per 1 SD of the index", value: fmtSigma(r.coef), strong: true },
              { name: "95% interval", value: `${fmtSigma(lo)} to ${fmtSigma(hi)}` },
              { name: "Correlation with the shock alone", value: r.r == null ? "–" : r.r.toFixed(2).replace("-", "−") },
            ], "Holding the other three indices fixed");
          })
          .on("pointerleave", hideTip);
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return draw;
}
