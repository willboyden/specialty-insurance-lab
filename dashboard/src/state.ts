// One small store for everything the views share. Views subscribe to the keys they read; the URL hash mirrors
// the shareable part (company, metric, scenario, severity) so any view can be linked to.

export type MetricKey =
  | "combined_ratio_ttm"
  | "loss_ratio_ttm"
  | "cy_loss_ratio_ttm"
  | "pyd_ratio_ttm"
  | "expense_ratio_ttm"
  | "roe_ttm"
  | "npe_growth_yoy"
  | "nii_yield"
  | "reserve_to_npe"
  | "npw_to_equity"
  | "equity_share_of_inv"
  | "bv_growth_yoy";

export interface AppState {
  selected: number; // cik of the company in focus
  hover: number | null; // cik under the pointer (any view)
  hoverQuarter: string | null; // quarter under the crosshair (any time view)
  metric: MetricKey;
  from: string; // first quarter shown (ISO date)
  segments: string[]; // visible segments
  historical: boolean; // include acquired / exited companies
  scenario: string; // scenario key or "baseline"
  severity: number; // 0..2
  overlays: boolean; // include the assumption overlays
  year: 1 | 2; // which forecast year the peer comparisons read
}

type Listener = (s: AppState, changed: Set<keyof AppState>) => void;

export function createStore(initial: AppState) {
  let state = initial;
  const listeners = new Set<{ keys: Set<keyof AppState> | null; fn: Listener }>();
  return {
    get: () => state,
    set(patch: Partial<AppState>) {
      const changed = new Set<keyof AppState>();
      for (const k of Object.keys(patch) as (keyof AppState)[]) {
        const a = state[k];
        const b = patch[k];
        if (Array.isArray(a) && Array.isArray(b) ? a.join("|") !== b.join("|") : a !== b) changed.add(k);
      }
      if (!changed.size) return;
      state = { ...state, ...patch };
      for (const l of listeners) {
        if (!l.keys || [...changed].some((k) => l.keys!.has(k))) l.fn(state, changed);
      }
    },
    on(keys: (keyof AppState)[] | null, fn: Listener) {
      const entry = { keys: keys ? new Set(keys) : null, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

const HASH_KEYS: Record<string, keyof AppState> = { c: "selected", m: "metric", s: "scenario", v: "severity", y: "year" };

export function readHash(defaults: AppState, tickerToCik: (t: string) => number | undefined): AppState {
  const out = { ...defaults };
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  for (const [short, key] of Object.entries(HASH_KEYS)) {
    const raw = params.get(short);
    if (raw == null) continue;
    if (key === "selected") {
      const cik = tickerToCik(raw.toUpperCase());
      if (cik) out.selected = cik;
    } else if (key === "severity") {
      const v = Number(raw);
      if (Number.isFinite(v)) out.severity = Math.min(2, Math.max(0, v));
    } else if (key === "year") {
      out.year = raw === "2" ? 2 : 1;
    } else if (key === "metric") {
      out.metric = raw as MetricKey;
    } else if (key === "scenario") {
      out.scenario = raw;
    }
  }
  return out;
}

export function writeHash(s: AppState, cikToTicker: (c: number) => string) {
  const params = new URLSearchParams();
  params.set("c", cikToTicker(s.selected));
  params.set("m", s.metric);
  params.set("s", s.scenario);
  params.set("v", String(s.severity));
  params.set("y", String(s.year));
  const next = "#" + params.toString();
  if (location.hash !== next) history.replaceState(null, "", next);
}
