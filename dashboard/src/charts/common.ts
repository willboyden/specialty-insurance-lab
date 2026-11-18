// Shared chart plumbing: responsive SVG frames, axes in the recessive style, color tokens read from CSS.
import { axisBottom, axisLeft } from "d3-axis";
import type { ScaleLinear, ScaleTime } from "d3-scale";
import { select, type Selection } from "d3-selection";
import { utcFormat } from "d3-time-format";
import { utcYear } from "d3-time";

export type SVGSel = Selection<SVGSVGElement, unknown, null, undefined>;
export type GSel = Selection<SVGGElement, unknown, null, undefined>;

export interface Frame {
  svg: SVGSel;
  g: GSel;
  width: number; // inner
  height: number; // inner
  margin: { top: number; right: number; bottom: number; left: number };
}

/** Calls draw(frame) now and whenever the host's width changes. Returns a redraw function. */
export function responsive(
  host: HTMLElement,
  opts: {
    height: number | ((w: number) => number);
    margin?: Partial<Frame["margin"]> | ((w: number) => Partial<Frame["margin"]>);
    label: string;
  },
  draw: (f: Frame) => void,
): () => void {
  const render = () => {
    const w = Math.max(280, host.clientWidth);
    const e = observed.get(host);
    if (e) e.lastW = w;
    const margin = { top: 12, right: 16, bottom: 28, left: 44, ...(typeof opts.margin === "function" ? opts.margin(w) : opts.margin) };
    const h = typeof opts.height === "function" ? opts.height(w) : opts.height;
    host.replaceChildren();
    const svg = select(host)
      .append("svg")
      .attr("class", "chart")
      .attr("width", w)
      .attr("height", h)
      .attr("viewBox", `0 0 ${w} ${h}`)
      .attr("role", "img")
      .attr("aria-label", opts.label);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    draw({ svg, g, width: w - margin.left - margin.right, height: h - margin.top - margin.bottom, margin });
  };
  // one observer per host: a redraw replaces the render function instead of adding another observer
  let entry = observed.get(host);
  if (!entry) {
    const e: { render: () => void; lastW: number; ro: ResizeObserver } = {
      render, lastW: -1,
      ro: new ResizeObserver(() => {
        if (Math.abs(host.clientWidth - e.lastW) > 2 && host.offsetParent !== null) e.render();
      }),
    };
    e.ro.observe(host);
    observed.set(host, e);
    entry = e;
  }
  entry.render = render;
  render();
  return render;
}

const observed = new WeakMap<HTMLElement, { render: () => void; lastW: number; ro: ResizeObserver }>();

export function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

export const yearFmt = utcFormat("%Y");

export function timeAxis(g: GSel, x: ScaleTime<number, number>, height: number, width: number) {
  // ticks on January 1st only, every k years so labels never repeat and never crowd
  const [a, b] = x.domain();
  const years = Math.max(1, b.getUTCFullYear() - a.getUTCFullYear());
  const fit = Math.max(2, Math.min(12, Math.floor(width / 64)));
  const step = [1, 2, 4, 5, 10].find((k) => years / k <= fit) ?? 10;
  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${height})`)
    .call(axisBottom(x).ticks(utcYear.every(step)!).tickFormat((d) => yearFmt(d as Date)).tickSizeOuter(0));
}

export function valueAxis(
  g: GSel, y: ScaleLinear<number, number>, width: number, fmt: (v: number) => string, ticks = 5,
) {
  g.append("g")
    .attr("class", "grid")
    .call(axisLeft(y).ticks(ticks).tickSize(-width).tickFormat(() => ""))
    .call((s) => s.select(".domain").remove());
  g.append("g")
    .attr("class", "axis")
    .call(axisLeft(y).ticks(ticks).tickFormat((d) => fmt(Number(d))).tickSizeOuter(0))
    .call((s) => s.select(".domain").remove())
    .call((s) => s.selectAll(".tick line").remove());
}

export function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** nearest index in a sorted array of dates */
export function nearestIndex(dates: Date[], t: Date): number {
  let lo = 0;
  let hi = dates.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(+dates[lo] - +t) <= Math.abs(+dates[hi] - +t) ? lo : hi;
}
