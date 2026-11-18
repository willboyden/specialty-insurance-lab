// Annual peril series as small multiples: single columns, stacked columns (ordinal categories, 2px surface gaps,
// 4px rounded data end) or a 2px line. Hovering a year writes store.hoverQuarter = "<year>-12-31", the convention
// the drivers section uses, so every annual and quarterly view on the page highlights the same year.
import { scaleBand, scaleLinear } from "d3-scale";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { Num } from "../types";
import type { Store } from "../state";
import { hideTip, showTip, type TipRow } from "../ui";
import { responsive, valueAxis } from "./common";

export interface AnnualPart {
  key: string;
  label: string;
  color: string;
  values: Num[];
}

export interface AnnualOpts {
  host: HTMLElement;
  store: Store;
  years: number[];
  parts: AnnualPart[]; // one part = single series
  kind: "columns" | "line";
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  label: string;
  note?: (year: number) => string | undefined;
  ref?: { value: number; label: string };
  height?: number;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function annualMini(o: AnnualOpts): () => void {
  // drop leading and trailing years where every part is missing
  const has = o.years.map((_, i) => o.parts.some((p) => p.values[i] != null));
  const a = has.indexOf(true);
  const b = has.lastIndexOf(true);
  const years = a >= 0 ? o.years.slice(a, b + 1) : [];
  const parts = o.parts.map((p) => ({ ...p, values: a >= 0 ? p.values.slice(a, b + 1) : [] }));
  return responsive(o.host, {
    height: o.height ?? 140, label: o.label, margin: { top: 10, right: 12, bottom: 20, left: 42 },
  }, (f) => {
    if (!years.length) return;
    const x = scaleBand<number>().domain(years).range([0, f.width]).paddingInner(o.kind === "columns" ? 0.22 : 0)
      .paddingOuter(0.05);
    const totals = years.map((_, i) => parts.reduce((s, p) => s + ((p.values[i] as number | null) ?? 0), 0));
    const maxV = Math.max(1e-9, ...totals, o.ref?.value ?? 0);
    const y = scaleLinear().domain([0, maxV]).range([f.height, 0]).nice(3);
    valueAxis(f.g, y, f.width, o.axisFmt ?? o.fmt, 3);
    const every = Math.max(1, Math.ceil(years.length / Math.max(2, Math.floor(f.width / 46))));
    const ticks = years.filter((yr) => yr % (every >= 10 ? 10 : every >= 5 ? 5 : every) === 0);
    f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
      .call(axisBottom(x).tickValues(ticks.length >= 2 ? ticks : [years[0], years[years.length - 1]])
        .tickFormat((d) => String(d)).tickSizeOuter(0));
    const hot = f.g.append("rect").attr("class", "b-colhot").attr("y", 0).attr("height", f.height).style("display", "none");
    if (o.ref) {
      const g = f.g.append("g").attr("class", "ref");
      g.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(o.ref.value)).attr("y2", y(o.ref.value))
        .style("stroke-dasharray", "3 3");
      if (o.ref.label) {
        g.append("text").attr("class", "halo").attr("x", f.width).attr("y", y(o.ref.value) - 4).attr("text-anchor", "end")
          .text(o.ref.label);
      }
    }
    const cxOf = (yr: number) => (x(yr) ?? 0) + x.bandwidth() / 2;
    if (o.kind === "columns") {
      const bw = Math.max(1, Math.min(14, x.bandwidth()));
      years.forEach((yr, i) => {
        const visible = parts.filter((p) => ((p.values[i] as number | null) ?? 0) > 0);
        let acc = 0;
        visible.forEach((p, k) => {
          const v = p.values[i] as number;
          const y0 = y(acc);
          const y1 = y(acc + v);
          acc += v;
          const top = k === visible.length - 1;
          const gapBottom = k === 0 ? 0 : 1;
          const gapTop = top ? 0 : 1;
          const h = Math.max(0, y0 - y1 - gapBottom - gapTop);
          if (h <= 0) return;
          const xl = cxOf(yr) - bw / 2;
          const node = top ? f.g.append("path").attr("d", roundedTop(xl, y1 + gapTop, bw, h, Math.min(3, h, bw / 2)))
            : f.g.append("rect").attr("x", xl).attr("y", y1 + gapTop).attr("width", bw).attr("height", h);
          node.style("fill", p.color);
        });
      });
    } else {
      for (const p of parts) {
        const ln = d3line<number>().defined((i) => p.values[i] != null).x((i) => cxOf(years[i])).y((i) => y(p.values[i] as number));
        f.g.append("path").attr("class", "line").style("stroke", p.color).attr("d", ln(years.map((_, i) => i)) ?? "");
      }
    }
    const showYear = (yr: number | null) => {
      if (yr == null || !years.includes(yr)) { hot.style("display", "none"); return; }
      hot.style("display", null).attr("x", (x(yr) ?? 0) - (o.kind === "line" ? 2 : 0))
        .attr("width", Math.max(4, x.bandwidth() + (o.kind === "line" ? 4 : 0)));
    };
    const unsub = o.store.on(["hoverQuarter"], (st) => {
      if (!f.svg.node()?.isConnected) { unsub(); return; }
      showYear(st.hoverQuarter ? Number(st.hoverQuarter.slice(0, 4)) : null);
    });
    f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
      .on("pointermove", (ev: PointerEvent) => {
        const [px] = pointer(ev);
        const k = Math.max(0, Math.min(years.length - 1, Math.floor(px / (f.width / years.length))));
        const yr = years[k];
        showYear(yr);
        o.store.set({ hoverQuarter: `${yr}-12-31` });
        const rows: TipRow[] = parts.map((p) => ({
          color: p.color, name: p.label, value: p.values[k] == null ? "no data" : o.fmt(p.values[k] as number),
        }));
        if (parts.length > 1) rows.unshift({ name: "Total", value: o.fmt(totals[k]), strong: true });
        else rows[0].strong = true;
        showTip(ev.clientX, ev.clientY, String(yr), rows, o.note?.(yr));
      })
      .on("pointerleave", () => {
        hideTip();
        showYear(null);
        o.store.set({ hoverQuarter: null });
      });
  });
}
