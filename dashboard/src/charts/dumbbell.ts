// Dumbbell rows: one per company, a gray dot for the baseline, an accent dot for the scenario and a connector,
// on one shared value axis. The whole row is the hit target (hover links, click selects); rows are focusable.
import { axisTop } from "d3-axis";
import { scaleLinear } from "d3-scale";
import { select } from "d3-selection";
import { hideTip, showTip, type TipRow } from "../ui";

export interface DumbbellRow {
  key: number;
  label: string;
  muted?: boolean;
  a: number | null; // baseline
  b: number | null; // scenario
  right?: string; // right-aligned text column
  tip: () => { title: string; rows: TipRow[]; note?: string };
}

export interface DumbbellSpec {
  label: string;
  rows: DumbbellRow[];
  fmt: (v: number) => string;
  ref?: { value: number; label: string };
  rightHeader?: string;
  selected: number;
  hover: number | null;
  onHover: (key: number | null) => void;
  onSelect: (key: number) => void;
}

const ROW = 24;
const TOP = 34;

export interface Dumbbell {
  redraw(): void;
  highlight(selected: number, hover: number | null): void;
}

export function drawDumbbell(host: HTMLElement, getSpec: () => DumbbellSpec): Dumbbell {
  let rowsSel: ReturnType<typeof selectRows> | null = null;

  function selectRows(svg: SVGSVGElement) {
    return select(svg).selectAll<SVGGElement, DumbbellRow>("g.db-row");
  }

  const render = () => {
    const spec = getSpec();
    host.replaceChildren();
    const width = Math.max(300, host.clientWidth);
    const labelW = width < 480 ? 54 : 62;
    const rightW = spec.rightHeader ? (width < 480 ? 46 : 64) : 8;
    const margin = { top: TOP, right: rightW + 8, bottom: 8, left: labelW };
    const innerW = width - margin.left - margin.right;
    const height = margin.top + spec.rows.length * ROW + margin.bottom;
    const svg = select(host).append("svg").attr("class", "chart").attr("width", width).attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", spec.label);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const vals: number[] = [];
    for (const r of spec.rows) {
      if (r.a != null) vals.push(r.a);
      if (r.b != null) vals.push(r.b);
    }
    if (spec.ref) vals.push(spec.ref.value);
    if (!vals.length) return;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = (hi - lo) * 0.06 || 0.02;
    lo -= pad;
    hi += pad;
    const x = scaleLinear().domain([lo, hi]).nice(5).range([0, innerW]);
    const ticks = Math.max(3, Math.min(7, Math.floor(innerW / 80)));
    // grid + top axis
    g.append("g").attr("class", "grid")
      .selectAll("line").data(x.ticks(ticks)).join("line")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d)).attr("y1", 0).attr("y2", spec.rows.length * ROW);
    g.append("g").attr("class", "axis")
      .call(axisTop(x).ticks(ticks).tickFormat((d) => spec.fmt(Number(d))).tickSizeOuter(0))
      .call((s) => s.select(".domain").remove());
    if (spec.rightHeader) {
      svg.append("text").attr("class", "label").attr("x", width - 4).attr("y", 12).attr("text-anchor", "end")
        .text(spec.rightHeader);
    }
    if (spec.ref && spec.ref.value >= x.domain()[0] && spec.ref.value <= x.domain()[1]) {
      const rx = x(spec.ref.value);
      const ref = g.append("g").attr("class", "ref");
      ref.append("line").attr("x1", rx).attr("x2", rx).attr("y1", -4).attr("y2", spec.rows.length * ROW);
    }
    const rows = g.selectAll<SVGGElement, DumbbellRow>("g.db-row").data(spec.rows, (d) => String(d.key)).join("g")
      .attr("class", "db-row")
      .attr("transform", (_d, i) => `translate(0,${i * ROW})`)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (d) => `${d.label}: baseline ${d.a != null ? spec.fmt(d.a) : "n/a"}, scenario ${d.b != null ? spec.fmt(d.b) : "n/a"}${d.right ? `, ${spec.rightHeader ?? ""} ${d.right}` : ""}`);
    rows.append("rect").attr("class", "db-bg").attr("x", -margin.left).attr("y", 0).attr("width", width)
      .attr("height", ROW).attr("rx", 4).style("fill", "transparent");
    rows.append("text").attr("class", "label db-label").attr("x", -8).attr("y", ROW / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").text((d) => d.label)
      .style("fill", (d) => (d.muted ? "var(--ink-3)" : "var(--ink-2)"));
    rows.filter((d) => d.a != null && d.b != null).append("line")
      .attr("x1", (d) => x(d.a!)).attr("x2", (d) => x(d.b!)).attr("y1", ROW / 2).attr("y2", ROW / 2)
      .style("stroke", "var(--context-strong)").style("stroke-width", 2).style("stroke-linecap", "round");
    rows.filter((d) => d.a != null).append("circle").attr("class", "dot").attr("cx", (d) => x(d.a!))
      .attr("cy", ROW / 2).attr("r", 4.5).style("fill", "var(--context-strong)");
    rows.filter((d) => d.b != null).append("circle").attr("class", "dot db-b").attr("cx", (d) => x(d.b!))
      .attr("cy", ROW / 2).attr("r", 5).style("fill", "var(--s1)");
    if (spec.rightHeader) {
      rows.append("text").attr("class", "label db-right").attr("x", innerW + margin.right - 4).attr("y", ROW / 2)
        .attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d.right ?? "");
    }
    rows.append("rect").attr("class", "hit").attr("x", -margin.left).attr("y", 0).attr("width", width).attr("height", ROW)
      .on("pointerenter", (_ev, d) => spec.onHover(d.key))
      .on("pointermove", (ev: PointerEvent, d) => {
        const t = d.tip();
        showTip(ev.clientX, ev.clientY, t.title, t.rows, t.note);
      })
      .on("pointerleave", () => {
        spec.onHover(null);
        hideTip();
      })
      .on("click", (_ev, d) => spec.onSelect(d.key));
    rows.on("keydown", (ev: KeyboardEvent, d) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        spec.onSelect(d.key);
      }
    }).on("focus", (ev: FocusEvent, d) => {
      spec.onHover(d.key);
      const r = (ev.currentTarget as SVGGElement).getBoundingClientRect();
      const t = d.tip();
      showTip(r.left + r.width / 2, r.bottom, t.title, t.rows, t.note);
    }).on("blur", () => {
      spec.onHover(null);
      hideTip();
    });
    rowsSel = selectRows(svg.node()!);
    paint(spec.selected, spec.hover);
  };

  function paint(selected: number, hover: number | null) {
    if (!rowsSel) return;
    rowsSel.select<SVGRectElement>("rect.db-bg").style("fill", (d) =>
      d.key === selected ? "var(--band)" : d.key === hover ? "var(--surface-2)" : "transparent");
    rowsSel.select<SVGTextElement>("text.db-label")
      .style("font-weight", (d) => (d.key === selected ? "650" : "400"))
      .style("fill", (d) => (d.key === selected || d.key === hover ? "var(--ink)" : d.muted ? "var(--ink-3)" : "var(--ink-2)"));
  }

  let lastW = -1;
  const renderTracked = () => {
    lastW = host.clientWidth;
    render();
  };
  const ro = new ResizeObserver(() => {
    if (host.offsetParent !== null && Math.abs(host.clientWidth - lastW) > 2) renderTracked();
  });
  ro.observe(host);
  renderTracked();
  return { redraw: renderTracked, highlight: paint };
}
