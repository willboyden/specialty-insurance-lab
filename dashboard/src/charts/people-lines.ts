// Annual emphasis lines: every company as a thin gray context line, the focus company in the accent, optional
// reference series. Log or linear y. The year under the pointer is shared through store.hoverQuarter (a year
// maps to its December quarter, as the other annual charts do); the nearest peer line lights up and a click
// selects it.
import { scaleLinear, scaleLog } from "d3-scale";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import { axisBottom, axisLeft } from "d3-axis";
import type { Num } from "../types";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { responsive, valueAxis } from "./common";

export interface YearLine {
  id: string; // cik as string for companies, a key for references
  label: string;
  values: Num[];
  role: "context" | "focus" | "ref";
  color?: string;
}

export interface YearLinesChartOpts {
  card: Card;
  store: Store;
  years: number[];
  label: string;
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  log?: () => boolean;
  height?: number | ((w: number) => number);
  getSeries: () => YearLine[];
  note?: (year: number) => string | undefined;
}

export function peopleLines(o: YearLinesChartOpts) {
  let hot: string | null = null;
  const draw = () => {
    if (o.card.showingTable()) return;
    const narrow = (w: number) => w < 520;
    responsive(o.card.body, { height: o.height ?? 340, label: o.label, margin: (w) => ({ right: narrow(w) ? 14 : 92, left: 52 }) }, (f) => {
      const showEnds = f.width + f.margin.left + f.margin.right >= 520;
      const all = o.getSeries();
      const yrs = o.years;
      const x = scaleLinear().domain([yrs[0], yrs[yrs.length - 1]]).range([0, f.width]);
      const vals = all.flatMap((s) => s.values).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
      const lo = vals.length ? Math.min(...vals) : 1;
      const hi = vals.length ? Math.max(...vals) : 10;
      const useLog = o.log?.() ?? false;
      const yLog = useLog ? scaleLog().domain([Math.max(1, lo * 0.85), hi * 1.15]).range([f.height, 0]).nice() : null;
      const yLin = yLog ? null : scaleLinear().domain([0, hi * 1.06]).range([f.height, 0]).nice();
      const y = (v: number) => (yLog ? yLog(v) : yLin!(v));
      if (yLog) {
        const ticks = yLog.ticks().filter((t) => {
          const m = t / 10 ** Math.floor(Math.log10(t));
          return Math.abs(m - 1) < 1e-9 || Math.abs(m - 3) < 1e-9;
        });
        f.g.append("g").attr("class", "grid")
          .call(axisLeft(yLog).tickValues(ticks).tickSize(-f.width).tickFormat(() => ""))
          .call((s) => s.select(".domain").remove());
        f.g.append("g").attr("class", "axis")
          .call(axisLeft(yLog).tickValues(ticks).tickFormat((d) => (o.axisFmt ?? o.fmt)(Number(d))).tickSizeOuter(0))
          .call((s) => s.select(".domain").remove())
          .call((s) => s.selectAll(".tick line").remove());
      } else {
        valueAxis(f.g, yLin!, f.width, o.axisFmt ?? o.fmt);
      }
      const step = yrs.length > 12 && f.width < 520 ? 4 : yrs.length > 8 ? 2 : 1;
      f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
        .call(axisBottom(x).tickValues(yrs.filter((yr) => (yr - yrs[0]) % step === 0)).tickFormat((d) => String(d)).tickSizeOuter(0));

      const path = (s: YearLine) => d3line<number>()
        .defined((i) => s.values[i] != null && (s.values[i] as number) > 0)
        .x((i) => x(yrs[i])).y((i) => y(s.values[i] as number))(yrs.map((_, i) => i)) ?? "";
      const ctx = all.filter((s) => s.role === "context");
      const refs = all.filter((s) => s.role !== "context");
      const ctxPaths = f.g.append("g").selectAll("path").data(ctx).join("path")
        .attr("class", (s) => `ctx${s.id === hot ? " hot" : ""}`).attr("d", path);
      f.g.append("g").selectAll("path").data(refs).join("path").attr("class", "line")
        .style("stroke", (s) => s.color ?? "var(--s1)").attr("d", path);
      // single-year points (a series with one value has no line): a dot keeps it visible
      f.g.append("g").selectAll("circle").data(refs.flatMap((s) => s.values.map((v, i) => ({ s, v, i }))
        .filter((d) => d.v != null && (d.s.values[d.i - 1] == null) && (d.s.values[d.i + 1] == null))))
        .join("circle").attr("class", "dot").attr("r", 3.5).attr("cx", (d) => x(yrs[d.i])).attr("cy", (d) => y(d.v as number))
        .style("fill", (d) => d.s.color ?? "var(--s1)");

      const ends = refs.map((s) => {
        let j = -1;
        for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) { j = i; break; }
        return { s, j, yv: j >= 0 ? y(s.values[j] as number) : NaN };
      }).filter((e) => e.j >= 0).sort((a, b) => a.yv - b.yv);
      for (let k = 1; k < ends.length; k++) if (ends[k].yv - ends[k - 1].yv < 13) ends[k].yv = ends[k - 1].yv + 13;
      for (const e of showEnds ? ends : []) {
        f.g.append("circle").attr("class", "dot").attr("r", 4).attr("cx", x(yrs[e.j])).attr("cy", y(e.s.values[e.j] as number))
          .style("fill", e.s.color ?? "var(--s1)");
        f.g.append("text").attr("class", e.s.role === "focus" ? "label strong" : "label")
          .attr("x", f.width + 8).attr("y", e.yv).attr("dy", "0.32em")
          .text(`${e.s.label.length > 12 ? e.s.label.slice(0, 11) + "…" : e.s.label} ${o.fmt(e.s.values[e.j] as number)}`);
      }

      const cross = f.g.append("g").attr("class", "crosshair").style("display", "none");
      const vline = cross.append("line").attr("y1", 0).attr("y2", f.height);
      const dots = cross.append("g");
      const showAt = (i: number) => {
        cross.style("display", null);
        vline.attr("x1", x(yrs[i])).attr("x2", x(yrs[i]));
        dots.selectAll("circle").data(refs.filter((s) => s.values[i] != null)).join("circle")
          .attr("class", "dot").attr("r", 4).attr("cx", x(yrs[i])).attr("cy", (s) => y(s.values[i] as number))
          .style("fill", (s) => s.color ?? "var(--s1)");
      };
      const unsub = o.store.on(["hoverQuarter", "hover"], (st, changed) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        if (changed.has("hoverQuarter")) {
          const i = st.hoverQuarter ? yrs.indexOf(Number(st.hoverQuarter.slice(0, 4))) : -1;
          if (i >= 0) showAt(i); else cross.style("display", "none");
        }
        if (changed.has("hover")) {
          const id = st.hover != null ? String(st.hover) : null;
          ctxPaths.attr("class", (s) => `ctx${s.id === id ? " hot" : ""}`);
          if (id) ctxPaths.filter((s) => s.id === id).raise();
        }
      });
      f.g.append("rect").attr("class", "hit").attr("x", -6).attr("width", f.width + 12).attr("height", f.height)
        .style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const [px, py] = pointer(ev);
          const i = Math.max(0, Math.min(yrs.length - 1, Math.round(x.invert(px)) - yrs[0]));
          o.store.set({ hoverQuarter: `${yrs[i]}-12-31` });
          showAt(i);
          let best: YearLine | null = null;
          let bestD = 14;
          for (const s of ctx) {
            const v = s.values[i];
            if (v == null) continue;
            const d = Math.abs(y(v) - py);
            if (d < bestD) { bestD = d; best = s; }
          }
          const id = best?.id ?? null;
          if (id !== hot) {
            hot = id;
            ctxPaths.attr("class", (s) => `ctx${s.id === hot ? " hot" : ""}`);
            ctxPaths.filter((s) => s.id === hot).raise();
            o.store.set({ hover: id ? Number(id) : null });
          }
          const rows: TipRow[] = refs.filter((s) => s.values[i] != null)
            .map((s) => ({ color: s.color ?? "var(--s1)", name: s.label, value: o.fmt(s.values[i] as number), strong: s.role === "focus" }));
          if (best && best.values[i] != null) rows.push({ color: "var(--context-strong)", name: best.label, value: o.fmt(best.values[i] as number) });
          showTip(ev.clientX, ev.clientY, String(yrs[i]), rows, o.note?.(yrs[i]) ?? (best ? "Click to focus this company" : undefined));
        })
        .on("pointerleave", () => {
          hideTip();
          cross.style("display", "none");
          o.store.set({ hoverQuarter: null, hover: null });
          if (hot) { hot = null; ctxPaths.attr("class", "ctx"); }
        })
        .on("click", () => { if (hot) o.store.set({ selected: Number(hot) }); });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
