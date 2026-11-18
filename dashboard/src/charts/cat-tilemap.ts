// US tile-grid map: one rounded square per state (plus DC and Puerto Rico) on a fixed grid that keeps neighbors
// roughly where they are. Color is one sequential hue in 8 equal-count bins of the non-zero values (zero = the
// neutral "none" tile), so a few huge states do not wash out the rest; the legend shows each bin's lower edge.
import { scaleBand } from "d3-scale";
import type { Num } from "../types";
import type { Card } from "../ui";
import { el, hideTip, showTip, type TipRow } from "../ui";
import { responsive } from "./common";

// [column, row] on a 12 x 8 grid
export const TILES: Record<string, [number, number]> = {
  AK: [0, 0], ME: [11, 0],
  WI: [6, 1], VT: [10, 1], NH: [11, 1],
  WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], MI: [7, 2], NY: [9, 2], MA: [10, 2],
  OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3],
  CT: [10, 3], RI: [11, 3],
  CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4],
  DE: [10, 4],
  AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
  OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6],
  HI: [0, 7], TX: [4, 7], FL: [9, 7], PR: [11, 7],
};

export interface TileMapOpts {
  card: Card;
  label: string;
  codes: string[];
  names: string[];
  getValues: () => Num[];
  fmt: (v: number) => string;
  metricLabel: () => string;
  extraRows?: (i: number) => TipRow[];
}

export function binsOf(values: number[]): number[] {
  const pos = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!pos.length) return [];
  const edges: number[] = [];
  for (let k = 0; k < 8; k++) edges.push(pos[Math.min(pos.length - 1, Math.floor((k / 8) * pos.length))]);
  return edges; // lower edge of bins 1..8
}

export function binOf(v: number, edges: number[]): number {
  if (!(v > 0) || !edges.length) return 0;
  let k = 0;
  for (let j = 0; j < edges.length; j++) if (v >= edges[j]) k = j;
  return k + 1;
}

export function tileMap(o: TileMapOpts): () => void {
  const draw = () => {
    if (o.card.showingTable()) return;
    const vals = o.getValues();
    const nums = vals.map((v) => (v == null ? NaN : v));
    const edges = binsOf(nums.filter((v) => Number.isFinite(v)));
    const order = o.codes.map((_, i) => i).filter((i) => Number.isFinite(nums[i]))
      .sort((p, q) => nums[q] - nums[p]);
    const rank = new Map(order.map((i, k) => [i, k + 1]));
    // the scale key under the map
    o.card.legend.replaceChildren();
    const ramp = el("span", { class: "b-ramp" });
    for (let k = 1; k <= 8; k++) {
      const s = el("span", { title: edges[k - 1] != null ? `from ${o.fmt(edges[k - 1])}` : "" });
      s.style.background = `var(--seq-${k})`;
      ramp.append(s);
    }
    o.card.legend.append(el("div", { class: "b-scale" },
      el("span", { text: o.metricLabel() + ":" }),
      el("span", { text: edges.length ? o.fmt(edges[0]) : "–" }), ramp,
      el("span", { text: order.length ? o.fmt(nums[order[0]]) : "–" }),
      el("span", { class: "b-none" }), el("span", { text: "none" })));
    responsive(o.card.body, {
      height: (w) => Math.round(Math.min(w, 600) * 8 / 12) + 6, label: o.label,
      margin: { top: 2, right: 2, bottom: 2, left: 2 },
    }, (f) => {
      const size = Math.min(f.width / 12, (f.height) / 8);
      const x = scaleBand<number>().domain([...Array(12).keys()]).range([0, size * 12]).padding(0.08);
      const y = scaleBand<number>().domain([...Array(8).keys()]).range([0, size * 8]).padding(0.08);
      const ox = (f.width - size * 12) / 2;
      const g = f.g.append("g").attr("transform", `translate(${ox},0)`);
      o.codes.forEach((code, i) => {
        const pos = TILES[code];
        if (!pos) return;
        const v = nums[i];
        const k = Number.isFinite(v) ? binOf(v, edges) : -1;
        const tile = g.append("g").attr("class", "cat-tile").attr("transform", `translate(${x(pos[0])},${y(pos[1])})`);
        tile.append("rect").attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 4)
          .style("fill", k < 0 ? "var(--surface-2)" : k === 0 ? "var(--seq-none)" : `var(--seq-${k})`);
        tile.append("text").attr("class", "cat-code halo").attr("x", x.bandwidth() / 2)
          .attr("y", y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "middle")
          .style("font-size", `${Math.max(9, Math.min(13, size * 0.3))}px`).text(code);
        tile.append("rect").attr("class", "hit").attr("width", x.bandwidth()).attr("height", y.bandwidth())
          .on("pointermove", (ev: PointerEvent) => {
            tile.select("rect").classed("cat-hot", true);
            const rows: TipRow[] = [{ name: o.metricLabel(), value: Number.isFinite(v) ? o.fmt(v) : "no data", strong: true }];
            if (rank.has(i)) rows.push({ name: "Rank", value: `${rank.get(i)} of ${order.length}` });
            showTip(ev.clientX, ev.clientY, o.names[i], [...rows, ...(o.extraRows?.(i) ?? [])]);
          })
          .on("pointerleave", () => {
            tile.select("rect").classed("cat-hot", false);
            hideTip();
          });
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return draw;
}
