// Accident-year views of one line of business from a 10-K's claims-development disclosure (ASU 2015-09):
//  - triangleHeat: accident year (rows) x development age (columns), each cell the cumulative incurred estimate
//    relative to the first one (diverging: an estimate that fell is favorable blue, one that rose is adverse red)
//  - ayColumns:    one value per accident year (reported claims, average severity, or IBNR share)
//  - payoutChart:  the average share of an accident year's claims paid in development year n, and the cumulative
import { scaleBand, scaleDiverging, scaleLinear } from "d3-scale";
import { interpolateRgbBasis } from "d3-interpolate";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import type { ClaimsLine } from "../domains/claims";
import type { Num } from "../types";
import type { Card, TipRow } from "../ui";
import { hideTip, showTip } from "../ui";
import { css, responsive, valueAxis } from "./common";
import { colPath } from "./claims-devbars";

/** cumulative incurred at each age relative to the first (age 1) estimate, per accident year */
export function developmentVsFirst(line: ClaimsLine): Num[][] {
  return line.incurred.map((row) => {
    const first = row.find((v) => v != null) ?? null;
    return row.map((v) => (v == null || first == null || first === 0 ? null : v / first - 1));
  });
}

/** volume-weighted age-to-age factors of the incurred triangle: sum(age k+1) / sum(age k) over the same accident years */
export function ageToAge(m: Num[][]): Num[] {
  const ages = Math.max(0, ...m.map((r) => r.length));
  const out: Num[] = [];
  for (let k = 0; k < ages - 1; k++) {
    let a = 0;
    let b = 0;
    for (const r of m) {
      if (r[k] != null && r[k + 1] != null) { a += r[k] as number; b += r[k + 1] as number; }
    }
    out.push(a > 0 ? b / a : null);
  }
  return out;
}

export function latestOf(row: Num[]): Num {
  for (let i = row.length - 1; i >= 0; i--) if (row[i] != null) return row[i];
  return null;
}

export function triangleHeat(o: {
  card: Card; label: string; getLine: () => ClaimsLine | null; money: (v: number) => string;
  change: (v: number) => string; ratio: (v: number) => string;
}) {
  const draw = () => {
    if (o.card.showingTable()) return;
    const line = o.getLine();
    const nAy = line?.ays.length ?? 0;
    const rowH = 20;
    responsive(o.card.body, { height: () => Math.max(3, nAy) * rowH + 40, label: o.label, margin: { left: 44, right: 8, top: 22, bottom: 14 } }, (f) => {
      if (!line) return;
      const dev = developmentVsFirst(line);
      const ages = Math.max(...line.incurred.map((r) => r.length));
      const x = scaleBand<number>().domain(Array.from({ length: ages }, (_, i) => i)).range([0, f.width]).paddingInner(0.06);
      const y = scaleBand<number>().domain(line.ays.map((_, i) => i)).range([0, nAy * rowH]).paddingInner(0.1);
      const sc = scaleDiverging(interpolateRgbBasis([css("--div-neg"), css("--div-mid"), css("--div-pos")])).domain([-0.25, 0, 0.25]).clamp(true);
      line.ays.forEach((ay, r) => {
        f.g.append("text").attr("x", -6).attr("y", y(r)! + y.bandwidth() / 2).attr("dy", "0.32em").attr("text-anchor", "end")
          .attr("class", "label").style("font-size", "10.5px").text(String(ay));
        for (let c = 0; c < ages; c++) {
          const v = dev[r]?.[c];
          if (v == null) continue;
          f.g.append("rect").attr("x", x(c)!).attr("y", y(r)!).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 1.5)
            .style("fill", c === 0 ? "var(--surface-2)" : sc(v));
        }
      });
      const every = ages * 26 <= f.width ? 1 : 2;
      f.g.append("g").selectAll("text").data(Array.from({ length: ages }, (_, i) => i).filter((i) => (i + 1) % every === 0 || i === 0)).join("text")
        .attr("x", (i) => x(i)! + x.bandwidth() / 2).attr("y", -8).attr("text-anchor", "middle").attr("class", "label")
        .style("font-size", "10.5px").text((i) => (i === 0 ? "yr 1" : String(i + 1)));
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", nAy * rowH)
        .on("pointermove", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const c = Math.max(0, Math.min(ages - 1, Math.floor(mx / x.step())));
          const r = Math.max(0, Math.min(nAy - 1, Math.floor(my / y.step())));
          const inc = line.incurred[r]?.[c];
          if (inc == null) { hideTip(); return; }
          const paid = line.paid[r]?.[c];
          const rows: TipRow[] = [
            { name: "Incurred, cumulative", value: o.money(inc), strong: true },
            { name: "Change vs first estimate", value: c === 0 ? "first estimate" : o.change(dev[r][c] as number) },
          ];
          if (paid != null) rows.push({ name: "Paid, cumulative", value: o.money(paid) }, { name: "Paid / incurred", value: o.ratio(paid / inc) });
          showTip(ev.clientX, ev.clientY, `Accident year ${line.ays[r]}, development year ${c + 1}`, rows,
            `Evaluated at the end of ${line.ays[r] + c}`);
        })
        .on("pointerleave", hideTip);
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}

export function ayColumns(o: {
  card: Card; label: string; getLine: () => ClaimsLine | null; getValues: (l: ClaimsLine) => Num[]; fmt: (v: number) => string;
  name: () => string;
}) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: 230, label: o.label, margin: { left: 52, right: 8, bottom: 24, top: 10 } }, (f) => {
      const line = o.getLine();
      if (!line) return;
      const vals = o.getValues(line);
      const n = line.ays.length;
      const x = scaleBand<number>().domain(Array.from({ length: n }, (_, i) => i)).range([0, f.width]).paddingInner(0.3);
      const hi = Math.max(0, ...vals.filter((v): v is number => v != null));
      const y = scaleLinear().domain([0, hi || 1]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, o.fmt, 4);
      const bw = Math.min(24, x.bandwidth());
      vals.forEach((v, i) => {
        if (v == null) return;
        f.g.append("path").attr("d", colPath(x(i)! + (x.bandwidth() - bw) / 2, bw, y(0), y(v))).style("fill", "var(--s1)");
      });
      const every = n * 34 <= f.width ? 1 : 2;
      f.g.append("g").selectAll("text").data(line.ays.map((_, i) => i).filter((i) => i % every === (n - 1) % every)).join("text")
        .attr("x", (i) => x(i)! + x.bandwidth() / 2).attr("y", f.height + 16).attr("text-anchor", "middle").attr("class", "label")
        .style("font-size", "10.5px").text((i) => `'${String(line.ays[i]).slice(2)}`);
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const i = Math.max(0, Math.min(n - 1, Math.floor(pointer(ev)[0] / x.step())));
          showTip(ev.clientX, ev.clientY, `Accident year ${line.ays[i]}`, [{ name: o.name(), value: vals[i] == null ? "not disclosed" : o.fmt(vals[i] as number), strong: true }]);
        })
        .on("pointerleave", hideTip);
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}

export function payoutChart(o: { card: Card; label: string; getLine: () => ClaimsLine | null; pct: (v: number) => string }) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: 230, label: o.label, margin: { left: 44, right: 10, bottom: 24, top: 10 } }, (f) => {
      const line = o.getLine();
      const pay = (line?.payout ?? []).map((v) => v ?? 0);
      if (!line || !pay.length) {
        f.g.append("text").attr("x", 0).attr("y", 20).text("No payout pattern disclosed for this line.");
        return;
      }
      const cum: number[] = [];
      pay.reduce((a, v, i) => (cum[i] = a + v), 0);
      const n = pay.length;
      const x = scaleBand<number>().domain(Array.from({ length: n }, (_, i) => i)).range([0, f.width]).paddingInner(0.3);
      const y = scaleLinear().domain([0, Math.max(1, ...cum)]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, (v) => o.pct(v), 4);
      const bw = Math.min(24, x.bandwidth());
      pay.forEach((v, i) => f.g.append("path").attr("d", colPath(x(i)! + (x.bandwidth() - bw) / 2, bw, y(0), y(v))).style("fill", "var(--s1)"));
      const ln = d3line<number>().x((_, i) => x(i)! + x.bandwidth() / 2).y((v) => y(v));
      f.g.append("path").attr("class", "line").style("stroke", "var(--s2)").attr("d", ln(cum) ?? "");
      f.g.append("g").selectAll("circle").data(cum).join("circle").attr("class", "dot").attr("r", 3.5)
        .attr("cx", (_, i) => x(i)! + x.bandwidth() / 2).attr("cy", (v) => y(v)).style("fill", "var(--s2)");
      f.g.append("g").selectAll("text").data(pay.map((_, i) => i)).join("text")
        .attr("x", (i) => x(i)! + x.bandwidth() / 2).attr("y", f.height + 16).attr("text-anchor", "middle").attr("class", "label")
        .style("font-size", "10.5px").text((i) => String(i + 1));
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const i = Math.max(0, Math.min(n - 1, Math.floor(pointer(ev)[0] / x.step())));
          showTip(ev.clientX, ev.clientY, `Development year ${i + 1}`, [
            { color: "var(--s1)", name: "Paid in that year", value: o.pct(pay[i]), strong: true },
            { color: "var(--s2)", name: "Paid by then, cumulative", value: o.pct(cum[i]) },
          ], "Average over the accident years disclosed");
        })
        .on("pointerleave", hideTip);
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
