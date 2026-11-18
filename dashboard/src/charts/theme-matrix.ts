// Matrix heatmap (rows x columns, sequential one-hue ramp). Used for company x theme and theme x year.
// Rows may carry a group (segment); a group label row is inserted where the group changes. The whole grid is one
// hit layer that resolves the nearest cell, so small cells stay easy to hover. Row click selects, the selected
// row is outlined, and a column can be highlighted from the shared crosshair.
import { select } from "d3-selection";
import type { AppState, Store } from "../state";
import { hideTip, showTip, type TipRow } from "../ui";
import { seqFill } from "./b-style";

export interface MatrixRow {
  id: string;
  label: string;
  short?: string;
  group?: string;
  selectable?: boolean;
}

export interface MatrixCol {
  id: string;
  label: string;
}

export interface MatrixOpts {
  host: HTMLElement;
  store: Store;
  rows: MatrixRow[];
  cols: MatrixCol[];
  value: (r: number, c: number) => number | null;
  tip: (r: number, c: number) => { title: string; rows: TipRow[]; note?: string };
  label: string;
  selectedId?: () => string | null;
  onRowClick?: (r: number) => void;
  onRowHover?: (r: number | null) => void;
  colFromState?: (st: AppState) => number | null;
  onColHover?: (c: number | null) => void;
  rowHeight?: number;
  maxCell?: number;
  rotate?: number; // column-label angle in degrees (negative = up-right)
  labelEvery?: (w: number) => number; // show every n-th column label
}

export function matrix(o: MatrixOpts): () => void {
  let lastW = -1;
  const RH = o.rowHeight ?? 18;
  const render = () => {
    const W = Math.max(280, o.host.clientWidth);
    lastW = W;
    o.host.replaceChildren();
    const narrow = W < 520;
    // layout: row positions with group headers
    const ys: number[] = [];
    const groups: { label: string; y: number }[] = [];
    let yy = 0;
    let prev: string | undefined;
    o.rows.forEach((r) => {
      if (r.group && r.group !== prev) {
        groups.push({ label: r.group, y: yy });
        yy += RH;
        prev = r.group;
      }
      ys.push(yy);
      yy += RH;
    });
    const gridH = yy;

    const svg = select(o.host).append("svg").attr("class", "chart").attr("role", "img").attr("aria-label", o.label);
    // measure labels
    const probe = svg.append("g");
    const rowText = (r: MatrixRow) => (narrow && r.short ? r.short : r.label);
    let gutter = 0;
    for (const r of o.rows) {
      const t = probe.append("text").attr("class", "b-rowlabel").text(rowText(r));
      gutter = Math.max(gutter, (t.node() as SVGTextElement).getComputedTextLength());
    }
    gutter = Math.min(narrow ? 92 : Math.max(190, Math.floor(W * 0.42)), Math.ceil(gutter) + 10);
    const angle = o.rotate ?? -40;
    let colLen = 0;
    for (const c of o.cols) {
      const t = probe.append("text").text(c.label);
      colLen = Math.max(colLen, (t.node() as SVGTextElement).getComputedTextLength());
    }
    probe.remove();
    const rad = (Math.abs(angle) * Math.PI) / 180;
    const header = Math.ceil(colLen * Math.sin(rad) + 16);
    const rightPad = Math.ceil(colLen * Math.cos(rad) * 0.15) + 8;
    const avail = W - gutter - rightPad;
    const cw = Math.max(6, Math.min(o.maxCell ?? 40, Math.floor(avail / o.cols.length)));
    const gridW = cw * o.cols.length;
    const H = header + gridH + 6;
    svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
    const g = svg.append("g").attr("transform", `translate(${gutter},${header})`);

    // column labels
    const every = o.labelEvery ? o.labelEvery(W) : 1;
    const colG = svg.append("g").attr("transform", `translate(${gutter},${header - 6})`);
    o.cols.forEach((c, j) => {
      // the last label is forced only when it does not crowd the previous labeled column
      const last = j === o.cols.length - 1 && (o.cols.length - 1) % every > every / 2;
      if (j % every !== 0 && !last) return;
      colG.append("text").attr("transform", `translate(${j * cw + cw / 2},0) rotate(${angle})`)
        .attr("text-anchor", "start").style("font-size", "11px").text(c.label);
    });
    // group labels
    for (const gr of groups) {
      g.append("text").attr("class", "b-seg-label").attr("x", -gutter + 2).attr("y", gr.y + RH / 2).attr("dy", "0.32em")
        .text(gr.label);
    }
    const hotRow = g.append("rect").attr("class", "b-rowhot").attr("x", -gutter).attr("width", gutter + gridW)
      .attr("height", RH).style("display", "none");
    const colHot = g.append("rect").attr("x", 0).attr("y", -2).attr("width", cw).attr("height", gridH + 4)
      .style("fill", "none").style("stroke", "var(--ink-3)").style("stroke-width", 1).style("display", "none");
    // row labels
    const sel = o.selectedId?.() ?? null;
    o.rows.forEach((r, i) => {
      g.append("text").attr("class", `b-rowlabel${r.id === sel ? " sel" : ""}`).attr("x", -8).attr("y", ys[i] + RH / 2)
        .attr("dy", "0.32em").attr("text-anchor", "end").text(rowText(r));
    });
    // cells (1px surface gap via inset)
    const cells = g.append("g");
    o.rows.forEach((_, i) => {
      o.cols.forEach((__, j) => {
        const fill = seqFill(o.value(i, j));
        if (!fill) return;
        cells.append("rect").attr("class", "b-cell").attr("x", j * cw + 0.5).attr("y", ys[i] + 0.5)
          .attr("width", Math.max(1, cw - 1)).attr("height", RH - 1).style("fill", fill);
      });
    });
    if (sel) {
      const si = o.rows.findIndex((r) => r.id === sel);
      if (si >= 0) {
        g.append("rect").attr("class", "b-rowsel").attr("x", -0.5).attr("y", ys[si] - 0.5)
          .attr("width", gridW + 1).attr("height", RH + 1).attr("rx", 2);
      }
    }
    const locate = (px: number, py: number): [number, number] | null => {
      const j = Math.floor(px / cw);
      if (j < 0 || j >= o.cols.length || py < 0 || py > gridH) return null;
      let i = -1;
      for (let k = 0; k < ys.length; k++) if (py >= ys[k] && py < ys[k] + RH) { i = k; break; }
      return i < 0 ? null : [i, j];
    };
    let hoverRow: number | null = null;
    const setRow = (i: number | null) => {
      if (i === hoverRow) return;
      hoverRow = i;
      if (i == null) hotRow.style("display", "none");
      else hotRow.style("display", null).attr("y", ys[i]).lower();
      o.onRowHover?.(i);
    };
    const showCol = (j: number | null) => {
      if (j == null || j < 0) colHot.style("display", "none");
      else colHot.style("display", null).attr("x", j * cw);
    };
    if (o.colFromState) {
      const unsub = o.store.on(["hoverQuarter"], (st) => {
        if (!svg.node()?.isConnected) { unsub(); return; }
        showCol(o.colFromState!(st));
      });
    }
    g.append("rect").attr("class", "hit").attr("x", -gutter).attr("width", gutter + gridW).attr("height", gridH)
      .style("cursor", o.onRowClick ? "pointer" : "default")
      .on("pointermove", (ev: PointerEvent) => {
        const rect = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
        const px = ev.clientX - rect.left - gutter;
        const py = ev.clientY - rect.top;
        const hit = locate(Math.max(0, px), py);
        if (!hit) { hideTip(); setRow(null); return; }
        const [i, j] = hit;
        setRow(i);
        if (px >= 0) {
          showCol(j);
          o.onColHover?.(j);
        }
        const t = o.tip(i, px >= 0 ? j : -1);
        showTip(ev.clientX, ev.clientY, t.title, t.rows, t.note);
      })
      .on("pointerleave", () => {
        hideTip();
        setRow(null);
        showCol(null);
        o.onColHover?.(null);
      })
      .on("click", (ev: MouseEvent) => {
        const rect = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
        const hit = locate(Math.max(0, ev.clientX - rect.left - gutter), ev.clientY - rect.top);
        if (hit && o.rows[hit[0]].selectable !== false) o.onRowClick?.(hit[0]);
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
