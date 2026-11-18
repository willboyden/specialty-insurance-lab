// ENSO and the Atlantic season: each season's accumulated cyclone energy against the Aug-Oct Oceanic Nino Index,
// with the least-squares line, the +/-0.5 C thresholds NOAA uses for El Nino / La Nina, and the latest ONI reading
// as a reference line. Hovering a season highlights its year everywhere (store.hoverQuarter = "<year>-12-31").
import { scaleLinear } from "d3-scale";
import { Delaunay } from "d3-delaunay";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";

export interface EnsoPoint {
  year: number;
  oni: number;
  ace: number;
  landfalls: number | null;
}

export interface EnsoOpts {
  card: Card;
  store: Store;
  points: EnsoPoint[];
  slope: number;
  intercept: number;
  now: { oni: number; label: string } | null;
}

export function ensoChart(o: EnsoOpts): () => void {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, {
      height: (w) => (w < 640 ? 300 : 330), label: "Atlantic hurricane season energy against the ENSO index",
      margin: { top: 22, right: 14, bottom: 40, left: 44 },
    }, (f) => {
      const xs = [...o.points.map((p) => p.oni), o.now?.oni ?? 0];
      const x = scaleLinear().domain([Math.min(-2.2, ...xs), Math.max(2.2, ...xs)]).range([0, f.width]).nice();
      const y = scaleLinear().domain([0, Math.max(...o.points.map((p) => p.ace))]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, (v) => String(v), 5);
      f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
        .call(axisBottom(x).ticks(Math.max(4, Math.floor(f.width / 70))).tickFormat((d) => {
          const v = Number(d);
          return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + "°";
        }).tickSizeOuter(0));
      f.g.append("text").attr("x", f.width).attr("y", f.height + 34).attr("text-anchor", "end")
        .text("Oceanic Niño Index, Aug–Oct (°C)");
      f.g.append("text").attr("x", 0).attr("y", -8).text("Season ACE (10⁴ kt²)");
      // ENSO phase thresholds
      const refs = f.g.append("g").attr("class", "ref");
      for (const [v, lab, anchor] of [[-0.5, "La Niña", "end"], [0.5, "El Niño", "start"]] as const) {
        refs.append("line").attr("x1", x(v)).attr("x2", x(v)).attr("y1", 0).attr("y2", f.height)
          .style("stroke-dasharray", "2 3");
        refs.append("text").attr("x", x(v) + (anchor === "end" ? -4 : 4)).attr("y", 10).attr("text-anchor", anchor).text(lab);
      }
      const [x0, x1] = x.domain();
      f.g.append("line").attr("x1", x(x0)).attr("x2", x(x1))
        .attr("y1", y(Math.max(0, o.intercept + o.slope * x0))).attr("y2", y(Math.max(0, o.intercept + o.slope * x1)))
        .style("stroke", "var(--s2)").style("stroke-width", 2);
      if (o.now) {
        const g = f.g.append("g");
        g.append("line").attr("x1", x(o.now.oni)).attr("x2", x(o.now.oni)).attr("y1", 14).attr("y2", f.height)
          .style("stroke", "var(--ink-2)").style("stroke-width", 1.5);
        g.append("text").attr("class", "label strong halo").attr("x", x(o.now.oni) - 4).attr("y", 26)
          .attr("text-anchor", "end").text(o.now.label);
      }
      const dots = f.g.append("g").selectAll("circle").data(o.points).join("circle").attr("class", "dot")
        .attr("cx", (p) => x(p.oni)).attr("cy", (p) => y(p.ace)).attr("r", 4.5)
        .style("fill", "var(--s1)").style("fill-opacity", 0.55);
      const hot = f.g.append("circle").attr("class", "dot").attr("r", 6.5).style("fill", "var(--s1)").style("display", "none");
      const lab = f.g.append("text").attr("class", "label strong halo");
      const showYear = (yr: number | null) => {
        const p = yr == null ? undefined : o.points.find((d) => d.year === yr);
        if (!p) { hot.style("display", "none"); lab.text(""); return; }
        hot.style("display", null).attr("cx", x(p.oni)).attr("cy", y(p.ace));
        lab.attr("x", x(p.oni) + 9).attr("y", y(p.ace)).attr("dy", "0.32em").text(String(p.year));
      };
      const unsub = o.store.on(["hoverQuarter"], (st) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        showYear(st.hoverQuarter ? Number(st.hoverQuarter.slice(0, 4)) : null);
      });
      dots.style("fill-opacity", 0.55);
      const del = Delaunay.from(o.points, (p) => x(p.oni), (p) => y(p.ace));
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const p = o.points[del.find(mx, my)];
          if (!p || Math.hypot(x(p.oni) - mx, y(p.ace) - my) > 26) { hideTip(); showYear(null); o.store.set({ hoverQuarter: null }); return; }
          showYear(p.year);
          o.store.set({ hoverQuarter: `${p.year}-12-31` });
          showTip(ev.clientX, ev.clientY, `${p.year} Atlantic season`, [
            { color: "var(--s1)", name: "Accumulated cyclone energy", value: p.ace.toFixed(0), strong: true },
            { name: "ONI, Aug–Oct", value: `${p.oni > 0 ? "+" : p.oni < 0 ? "−" : ""}${Math.abs(p.oni).toFixed(2)} °C` },
            { name: "US hurricane landfalls", value: p.landfalls == null ? "–" : String(p.landfalls) },
          ], p.oni >= 0.5 ? "El Niño season" : p.oni <= -0.5 ? "La Niña season" : "ENSO-neutral season");
        })
        .on("pointerleave", () => { hideTip(); showYear(null); o.store.set({ hoverQuarter: null }); });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return draw;
}
