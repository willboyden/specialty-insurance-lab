// DOM building blocks. Text from data always goes in through textContent (never innerHTML).

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------------------------------------------------------------- chart card with a table-view twin
export interface TableSpec {
  columns: string[];
  rows: (string | number)[][];
  caption?: string;
}

export interface Card {
  root: HTMLElement;
  body: HTMLElement;
  legend: HTMLElement;
  caption: HTMLElement;
  setTitle(title: string, sub?: string): void;
  setTable(fn: () => TableSpec): void;
  showingTable(): boolean;
  onRedraw(fn: () => void): void;
}

let cardSeq = 0;

export function card(parent: HTMLElement, opts: { title: string; sub?: string; span?: number; id?: string }): Card {
  const id = opts.id ?? `card-${++cardSeq}`;
  const h3 = el("h3", { id: `${id}-title`, text: opts.title });
  const sub = el("p", { class: "sub", text: opts.sub ?? "" });
  const tableBtn = el("button", { type: "button", "aria-pressed": "false", text: "Table" });
  const header = el("header", {}, el("div", {}, h3, sub), el("div", { class: "tools" }, tableBtn));
  const legend = el("div", { class: "legend" });
  const body = el("div", { class: "body" });
  const tableHost = el("div", { class: "table-view", hidden: true, tabindex: 0 });
  const caption = el("figcaption");
  const root = el("figure", { class: `card span-${opts.span ?? 12}`, id, "aria-labelledby": `${id}-title` },
    header, legend, body, tableHost, caption);
  parent.append(root);
  let tableFn: (() => TableSpec) | null = null;
  const redraws: (() => void)[] = [];
  const renderTable = () => {
    tableHost.replaceChildren();
    if (!tableFn) return;
    tableHost.append(table(tableFn()));
  };
  tableBtn.addEventListener("click", () => {
    const on = tableBtn.getAttribute("aria-pressed") !== "true";
    tableBtn.setAttribute("aria-pressed", String(on));
    tableHost.hidden = !on;
    body.hidden = on;
    legend.hidden = on;
    if (on) renderTable();
    else redraws.forEach((f) => f());
  });
  return {
    root, body, legend, caption,
    setTitle(title, subtitle) {
      h3.textContent = title;
      if (subtitle !== undefined) sub.textContent = subtitle;
    },
    setTable(fn) {
      tableFn = fn;
      if (!tableHost.hidden) renderTable();
    },
    showingTable: () => !tableHost.hidden,
    onRedraw(fn) {
      redraws.push(fn);
    },
  };
}

export function table(spec: TableSpec): HTMLTableElement {
  const t = el("table");
  if (spec.caption) t.append(el("caption", { class: "sr-only", text: spec.caption }));
  const thead = el("thead");
  const tr = el("tr");
  for (const c of spec.columns) tr.append(el("th", { scope: "col", text: c }));
  thead.append(tr);
  const tbody = el("tbody");
  for (const row of spec.rows) {
    const r = el("tr");
    row.forEach((v, i) => r.append(el(i === 0 ? "th" : "td", i === 0 ? { scope: "row", text: String(v) } : { text: String(v) })));
    tbody.append(r);
  }
  t.append(thead, tbody);
  return t;
}

// ---------------------------------------------------------------- legend
// outline / ring: a dashed border in the given color (pending marks), the others a filled swatch
export type KeyShape = "line" | "box" | "dot" | "outline" | "ring";

export function legend(host: HTMLElement, items: { label: string; color: string; shape?: KeyShape; dash?: boolean }[]) {
  host.replaceChildren();
  for (const it of items) {
    const sw = el("span", { class: `swatch-${it.shape ?? "line"}`, "aria-hidden": "true" });
    if (it.shape === "outline" || it.shape === "ring") sw.style.borderColor = it.color;
    else sw.style.background = it.color;
    host.append(el("span", { class: "key" }, sw, el("span", { text: it.label })));
  }
}

// ---------------------------------------------------------------- tooltip (one for the page)
export interface TipRow {
  color?: string;
  name: string;
  value: string;
  strong?: boolean;
}

let tipNode: HTMLDivElement | null = null;

function tipEl(): HTMLDivElement {
  if (!tipNode) {
    tipNode = el("div", { class: "tooltip", role: "status", "aria-live": "polite" });
    document.body.append(tipNode);
  }
  return tipNode;
}

export function showTip(x: number, y: number, title: string, rows: TipRow[], note?: string) {
  const t = tipEl();
  t.replaceChildren(el("div", { class: "t-title", text: title }));
  for (const r of rows) {
    const k = el("span", { class: "k" });
    if (r.color) k.style.background = r.color;
    const v = el("span", { class: "v", text: r.value });
    const n = el("span", { class: "n", text: r.name });
    if (r.strong) n.style.color = "var(--ink)";
    t.append(el("div", { class: "t-row" }, k, v, n));
  }
  if (note) t.append(el("div", { class: "t-note", text: note }));
  t.classList.add("on");
  const pad = 14;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  let left = x + pad;
  let top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top + h > window.innerHeight - 8) top = y - h - pad;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  tipNode?.classList.remove("on");
}

// ---------------------------------------------------------------- stat tiles
export interface Tile {
  label: string;
  value: string;
  delta?: string;
  tone?: "up-good" | "up-bad" | "down-good" | "down-bad" | "";
  title?: string;
}

export function tiles(host: HTMLElement, items: Tile[]) {
  host.replaceChildren();
  host.classList.add("tiles");
  for (const t of items) {
    const node = el("div", { class: "tile", title: t.title },
      el("div", { class: "t-label", text: t.label }),
      el("div", { class: "t-value", text: t.value }));
    if (t.delta) node.append(el("div", { class: `t-delta ${t.tone ?? ""}`, text: t.delta }));
    host.append(node);
  }
}

// ---------------------------------------------------------------- controls
export function segmented<T extends string | number>(
  label: string, options: { value: T; label: string }[], current: T, onChange: (v: T) => void,
): { root: HTMLElement; set(v: T): void } {
  const group = el("div", { class: "seg", role: "group", "aria-label": label });
  const buttons = options.map((o) => {
    const b = el("button", { type: "button", "aria-pressed": String(o.value === current), text: o.label });
    b.addEventListener("click", () => onChange(o.value));
    group.append(b);
    return b;
  });
  const root = el("div", { class: "control" }, el("span", { class: "label", text: label }), group);
  return {
    root,
    set(v) {
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(options[i].value === v)));
    },
  };
}

export function selectControl(
  label: string, options: { value: string; label: string; group?: string }[], current: string,
  onChange: (v: string) => void, id: string,
): { root: HTMLElement; select: HTMLSelectElement; set(v: string): void } {
  const select = el("select", { id });
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const o of options) {
    const opt = el("option", { value: o.value, text: o.label });
    if (o.group) {
      let g = groups.get(o.group);
      if (!g) {
        g = el("optgroup", { label: o.group });
        groups.set(o.group, g);
        select.append(g);
      }
      g.append(opt);
    } else select.append(opt);
  }
  select.value = current;
  select.addEventListener("change", () => onChange(select.value));
  const root = el("div", { class: "control" }, el("label", { for: id, text: label }), select);
  return { root, select, set: (v) => (select.value = v) };
}
