// Universe timeline: one row per carrier, a bar for the quarters it reported premium data, colored by what
// happened to it (active / acquired / exited) with a status icon at the year it happened. Grouped by segment.
// Row hover lights the company up everywhere (store.hover); click focuses it (comparable companies only).
import { scaleUtc } from "d3-scale";
import { select } from "d3-selection";
import { axisBottom, axisTop } from "d3-axis";
import type { Company } from "../types";
import type { Store } from "../state";
import { hideTip, showTip } from "../ui";
import { isoToDate, yearFmt } from "./common";
import { quarterLabel } from "../format";

export const STATUS_STYLE: Record<Company["status"], { color: string; label: string; icon: "dot" | "diamond" | "cross" }> = {
  active: { color: "var(--s1)", label: "Active (still reporting)", icon: "dot" },
  acquired: { color: "var(--s2)", label: "Acquired", icon: "diamond" },
  exited: { color: "var(--critical)", label: "Stopped reporting", icon: "cross" },
};

export function iconPath(icon: "dot" | "diamond" | "cross", cx: number, cy: number, r = 5): string {
  if (icon === "diamond") return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
  if (icon === "cross") {
    const a = r * 0.75;
    return `M${cx - a},${cy - a}L${cx + a},${cy + a}M${cx + a},${cy - a}L${cx - a},${cy + a}`;
  }
  return `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
}

export interface TimelineOpts {
  host: HTMLElement;
  store: Store;
  companies: Company[]; // already ordered, with group labels
  groupOf: (c: Company) => string;
  start: string;
  end: string;
  label: string;
}

export function timeline(o: TimelineOpts): () => void {
  const RH = 18;
  let lastW = -1;
  const render = () => {
    const W = Math.max(300, o.host.clientWidth);
    lastW = W;
    o.host.replaceChildren();
    const narrow = W < 560;
    const ys: number[] = [];
    const groups: { label: string; y: number }[] = [];
    let yy = 0;
    let prev = "";
    for (const c of o.companies) {
      const gname = o.groupOf(c);
      if (gname !== prev) {
        groups.push({ label: gname, y: yy + 4 });
        yy += RH + 4;
        prev = gname;
      }
      ys.push(yy);
      yy += RH;
    }
    const top = 26;
    const bottom = 26;
    const gutter = narrow ? 64 : 178;
    const right = 14;
    const H = top + yy + bottom;
    const svg = select(o.host).append("svg").attr("class", "chart").attr("width", W).attr("height", H)
      .attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", o.label);
    const g = svg.append("g").attr("transform", `translate(${gutter},${top})`);
    const iw = W - gutter - right;
    const x = scaleUtc().domain([isoToDate(o.start), isoToDate(o.end)]).range([0, iw]);
    const ticks = Math.max(3, Math.min(10, Math.floor(iw / 70)));
    g.append("g").attr("class", "grid")
      .call(axisBottom(x).ticks(ticks).tickSize(yy).tickFormat(() => ""))
      .call((s) => s.select(".domain").remove());
    g.append("g").attr("class", "axis").call(axisTop(x).ticks(ticks).tickFormat((d) => yearFmt(d as Date)).tickSizeOuter(0))
      .call((s) => s.select(".domain").remove());
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${yy})`)
      .call(axisBottom(x).ticks(ticks).tickFormat((d) => yearFmt(d as Date)).tickSizeOuter(0))
      .call((s) => s.select(".domain").remove());

    for (const gr of groups) {
      g.append("text").attr("class", "b-seg-label").attr("x", -gutter + 2).attr("y", gr.y + RH / 2).attr("dy", "0.32em")
        .text(gr.label);
    }
    const hot = g.append("rect").attr("class", "b-rowhot").attr("x", -gutter).attr("width", gutter + iw)
      .attr("height", RH).style("display", "none");
    const sel = o.store.get().selected;
    const selRow = g.append("rect").attr("class", "b-rowhot").attr("x", -gutter).attr("width", gutter + iw)
      .attr("height", RH).style("display", "none");
    const bars = g.append("g");
    o.companies.forEach((c, i) => {
      const st = STATUS_STYLE[c.status];
      const yMid = ys[i] + RH / 2;
      if (c.cik === sel) selRow.style("display", null).attr("y", ys[i]);
      g.append("text").attr("class", `b-rowlabel${c.cik === sel ? " sel" : ""}`).attr("x", -8).attr("y", yMid)
        .attr("dy", "0.32em").attr("text-anchor", "end").text(narrow ? c.ticker : `${c.name} (${c.ticker})`);
      if (!c.firstQuarter || !c.lastQuarter) return;
      const a = isoToDate(c.firstQuarter);
      a.setUTCMonth(a.getUTCMonth() - 3);
      const b = isoToDate(c.lastQuarter);
      const x0 = Math.max(0, x(a));
      const x1 = Math.min(iw, x(b));
      bars.append("rect").attr("x", x0).attr("y", yMid - 4).attr("width", Math.max(2, x1 - x0)).attr("height", 8)
        .attr("rx", 4).style("fill", st.color).style("opacity", c.comparable ? 1 : 0.45);
      if (c.status !== "active" && c.statusYear) {
        const sx = Math.min(iw, Math.max(0, x(isoToDate(`${c.statusYear}-07-01`))));
        if (st.icon === "cross") {
          // a surface halo first, so the cross stays visible on top of its own bar
          bars.append("path").attr("d", iconPath(st.icon, sx, yMid, 5))
            .style("stroke", "var(--surface)").style("stroke-width", 6).style("fill", "none").style("stroke-linecap", "round");
          bars.append("path").attr("d", iconPath(st.icon, sx, yMid, 5))
            .style("stroke", st.color).style("stroke-width", 2.5).style("fill", "none").style("stroke-linecap", "round");
        } else {
          bars.append("path").attr("d", iconPath(st.icon, sx, yMid, 5))
            .style("fill", st.color).style("stroke", "var(--surface)").style("stroke-width", 2);
        }
      }
    });
    const rowAt = (py: number) => {
      for (let k = 0; k < ys.length; k++) if (py >= ys[k] && py < ys[k] + RH) return k;
      return -1;
    };
    let hov = -1;
    g.append("rect").attr("class", "hit").attr("x", -gutter).attr("width", gutter + iw).attr("height", yy)
      .style("cursor", "pointer")
      .on("pointermove", (ev: PointerEvent) => {
        const rect = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
        const i = rowAt(ev.clientY - rect.top);
        if (i < 0) { hideTip(); hot.style("display", "none"); return; }
        const c = o.companies[i];
        if (i !== hov) {
          hov = i;
          hot.style("display", null).attr("y", ys[i]).lower();
          o.store.set({ hover: c.cik });
        }
        const st = STATUS_STYLE[c.status];
        const rows = [
          { name: "Segment", value: c.segment },
          { color: st.color, name: "Status", value: c.status === "active" ? "active" : `${c.status}${c.statusYear ? ` ${c.statusYear}` : ""}`, strong: true },
          { name: "Premium data", value: c.firstQuarter && c.lastQuarter ? `${quarterLabel(c.firstQuarter)} – ${quarterLabel(c.lastQuarter)}` : "none" },
          { name: "10-K / 10-Q filed", value: `${c.n10k} / ${c.n10q}` },
        ];
        const notes = [c.statusNote, c.note, !c.comparable ? "Not comparable: kept out of models and averages" : null,
          c.comparable ? "Click to focus this company" : null].filter(Boolean).join(" · ");
        showTip(ev.clientX, ev.clientY, `${c.name} (${c.ticker})`, rows, notes || undefined);
      })
      .on("pointerleave", () => {
        hideTip();
        hov = -1;
        hot.style("display", "none");
        o.store.set({ hover: null });
      })
      .on("click", (ev: MouseEvent) => {
        const rect = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
        const i = rowAt(ev.clientY - rect.top);
        if (i >= 0 && o.companies[i].comparable) o.store.set({ selected: o.companies[i].cik });
      });
  };
  // one observer per host: re-creating the chart on the same host must not leave a stale renderer behind
  OBSERVERS.get(o.host)?.disconnect();
  const ro = new ResizeObserver(() => {
    if (Math.abs(o.host.clientWidth - lastW) > 2 && o.host.offsetParent !== null) render();
  });
  OBSERVERS.set(o.host, ro);
  ro.observe(o.host);
  render();
  return render;
}

const OBSERVERS = new WeakMap<HTMLElement, ResizeObserver>();
