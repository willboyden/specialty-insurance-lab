// The scenario engine: an exact port of sil/model/simulate.py, run in the browser.
//
// Same inputs (dashboard/public/data/model.json), same random numbers (mulberry32 + Box-Muller, one stream per
// posterior draw and company), same arithmetic in the same order. tests/engine.test.ts checks it against the
// Python reference on a fixture written by scripts/make_engine_fixture.py.
//
// Two Python details are reproduced on purpose:
//  * CPython 3.12+ sums floats with Neumaier compensation, but only while the items are exact Python floats;
//    simulated loss ratios are numpy scalars, so after the first one the sum continues left to right.
//  * numpy's linear quantile interpolates from the nearer end, and numpy rounds by multiply-rint-divide while
//    Python's round() works on the exact decimal value of the double.

import type { ModelCompany, ModelData, Scenario } from "./types";

export const H = 8;
const MASK32 = 4294967296;

// ---------------------------------------------------------------- random numbers
export class Mulberry32 {
  private a: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
  }

  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    const a = this.a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / MASK32;
  }

  normal(): number {
    const u1 = 1.0 - this.next();
    const u2 = this.next();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  studentT5(): number {
    const z = this.normal();
    // Python: sum(normal() ** 2 for _ in range(5)), every item an exact float -> compensated sum
    const sq = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) {
      const n = this.normal();
      sq[i] = n * n;
    }
    const chi2 = pySum(sq, ALL_EXACT_5);
    return z / Math.sqrt(chi2 / 5.0);
  }
}

export function streamSeed(seedBase: number, draw: number, companyIndex: number): number {
  return (seedBase + draw * 7919 + companyIndex * 104729) >>> 0;
}

// ---------------------------------------------------------------- CPython's sum()
const ALL_EXACT_5 = [true, true, true, true, true];

/**
 * CPython 3.13 builtin sum(values) with start 0, where exact[i] says whether values[i] is an exact Python float
 * (true) or a numpy float64 (false). Exact floats are summed with Neumaier compensation; at the first numpy
 * scalar the compensated total is collapsed and the remaining items are added left to right.
 */
export function pySum(values: number[], exact: boolean[]): number {
  const n = values.length;
  if (n === 0) return 0;
  if (!exact[0]) {
    let acc = 0 + values[0];
    for (let i = 1; i < n; i++) acc = acc + values[i];
    return acc;
  }
  let hi = values[0];
  let lo = 0.0;
  for (let i = 1; i < n; i++) {
    const x = values[i];
    if (exact[i]) {
      const t = hi + x;
      if (Math.abs(hi) >= Math.abs(x)) lo += hi - t + x;
      else lo += x - t + hi;
      hi = t;
    } else {
      let acc = lo !== 0 && Number.isFinite(lo) ? hi + lo : hi;
      for (let j = i; j < n; j++) acc = acc + values[j];
      return acc;
    }
  }
  return lo !== 0 && Number.isFinite(lo) ? hi + lo : hi;
}

// ---------------------------------------------------------------- inputs
export interface Overlay {
  exposure: string;
  points: number[];
  key?: string;
}

export interface ShockInput {
  features: number[][]; // K x H, z units
  f: number[];
  ust5y: number[];
  nfci: number[];
  equity: number[];
  growth: number[];
  overlays: Overlay[];
}

export interface BaseInput {
  features: number[][][]; // K x P x H
  f: number[][]; // P x H
  ust5y: number[][];
  nfci: number[][];
  equity: number[][];
  start: { ust5y: number; nfci: number };
}

export function zeroShock(K: number): ShockInput {
  const z = () => new Array<number>(H).fill(0);
  return {
    features: Array.from({ length: K }, z), f: z(), ust5y: z(), nfci: z(), equity: z(), growth: z(), overlays: [],
  };
}

/** Shock inputs for a scenario key, or all zeros for null / "baseline". */
export function scenarioInputs(model: ModelData, key: string | null): ShockInput {
  const s = key && key !== "baseline" ? model.scenarios.find((x) => x.key === key) : undefined;
  if (!s) return zeroShock(model.features.length);
  return shockFromScenario(s);
}

export function shockFromScenario(s: Pick<Scenario, "shock" | "overlays">): ShockInput {
  return {
    features: s.shock.features, f: s.shock.f, ust5y: s.shock.ust5y, nfci: s.shock.nfci,
    equity: s.shock.equity, growth: s.shock.growth, overlays: s.overlays,
  };
}

// ---------------------------------------------------------------- the simulation
export interface Sim {
  D: number;
  /** row-major [d * H + h] */
  lr: Float64Array;
  cr: Float64Array;
  roe: Float64Array;
  bvx: Float64Array;
  cap: Float64Array;
  npe: Float64Array;
}

export interface SimOptions {
  seedBase: number;
  tax: number;
  severity: number;
  overlays: boolean;
}

/** model.json companies carry the industry shock of their last four quarters (lastF, aligned with lastLrs) */
export type EngineCompany = ModelCompany & { lastF?: number[] };

export function simulateCompany(c: EngineCompany, base: BaseInput, shock: ShockInput, o: SimOptions): Sim {
  const D = c.mu.length;
  const K = c.beta[0]?.length ?? 0;
  const P = base.f.length;
  const sev = o.severity;
  const out: Sim = {
    D, lr: new Float64Array(D * H), cr: new Float64Array(D * H), roe: new Float64Array(D * H),
    bvx: new Float64Array(D * H), cap: new Float64Array(D * H), npe: new Float64Array(D * H),
  };
  const startLr = c.lastLrs.slice(-4);
  const startF = (c.lastF ?? c.lastLrs.map(() => 0)).slice(-4);
  if (startF.length !== startLr.length) throw new Error(`lastLrs and lastF differ in length for ${c.cik}`);
  for (let d = 0; d < D; d++) {
    const rng = new Mulberry32(streamSeed(o.seedBase, d, c.stream));
    const path = d % P;
    let bv = c.equity;
    let npe = c.npeQ;
    let y = c.niiYield;
    let rPrev = base.start.ust5y;
    let bPrev = base.start.nfci;
    let generated = 0.0;
    const mu = c.mu[d];
    const rho = c.rho[d];
    const beta = c.beta[d];
    const lam = c.lam[d];
    const sigma = c.sigma[d];
    // the level the loss ratio reverts toward is ATTRITIONAL: each quarter's loss ratio minus its catastrophe
    // part (lam * industry shock), so a catastrophe quarter does not raise the next four quarters
    const attr = startLr.map((lr, i) => lr - lam * startF[i]);
    for (let h = 0; h < H; h++) {
      let xb = 0.0;
      for (let k = 0; k < K; k++) {
        const xk = base.features[k][path][h] + sev * shock.features[k][h];
        xb += beta[k] * xk;
      }
      const f = base.f[path][h] + sev * shock.f[h];
      let ov = 0.0;
      if (o.overlays) {
        for (const ol of shock.overlays) ov += ((c.exposures[ol.exposure] ?? 0.0) * ol.points[h]) / 100.0;
      }
      const eps = sigma * rng.studentT5();
      // reference: sum(attr[-4:]) / len(attr[-4:]); every item is a numpy scalar, so CPython adds left to right
      const win = attr.slice(-4);
      const level = pySum(win, win.map(() => false)) / win.length;
      const lr = mu * (1 - rho) + rho * level + xb + lam * f + eps + sev * ov;
      attr.push(lr - lam * f);
      const cr = lr + c.expenseRatio;
      const g = c.growth + (sev * shock.growth[h]) / 100.0;
      npe = npe * (1.0 + Math.max(g, -0.9)) ** 0.25;
      const r = base.ust5y[path][h] + sev * shock.ust5y[h];
      const b = base.nfci[path][h] + sev * shock.nfci[h];
      y = y + c.kappa * (r / 100.0 - y) + c.kappaC;
      const inv = bv * c.invToEquity;
      const eqRet = (base.equity[path][h] + sev * shock.equity[h]) / 100.0;
      const pretax = (1.0 - cr) * npe + (y * inv) / 4.0 + c.eqSecToEquity * bv * eqRet + c.otherIncomeQ;
      const ni = (1.0 - o.tax) * pretax;
      const oci = (c.dRate * (r - rPrev) + c.dFin * (b - bPrev)) * bv;
      const div = c.payout * Math.max(ni, 0.0);
      const roe = (4.0 * ni) / bv;
      generated += ni + oci;
      bv = bv + ni - div + oci;
      rPrev = r;
      bPrev = b;
      const i = d * H + h;
      out.lr[i] = lr;
      out.cr[i] = cr;
      out.roe[i] = roe;
      out.bvx[i] = bv / c.equity;
      out.cap[i] = generated / c.equity;
      out.npe[i] = npe;
    }
  }
  return out;
}

// ---------------------------------------------------------------- statistics (numpy-compatible)
export const QS = [0.05, 0.25, 0.5, 0.75, 0.95];

/** numpy.quantile(sorted, q) with the default 'linear' method, on an ascending-sorted array */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const vi = (n - 1) * q;
  if (vi >= n - 1) return sorted[n - 1];
  if (vi < 0) return sorted[0];
  const lo = Math.floor(vi);
  const hi = Math.min(lo + 1, n - 1);
  const g = vi - lo;
  const a = sorted[lo];
  const b = sorted[hi];
  const diff = b - a;
  return g >= 0.5 ? b - diff * (1 - g) : a + diff * g;
}

export function column(arr: Float64Array, D: number, h: number): Float64Array {
  const col = new Float64Array(D);
  for (let d = 0; d < D; d++) col[d] = arr[d * H + h];
  return col;
}

/** quantiles over draws for every quarter: [QS.length][H] */
export function quantilesByQuarter(arr: Float64Array, D: number, qs: number[] = QS): number[][] {
  const out = qs.map(() => new Array<number>(H).fill(NaN));
  for (let h = 0; h < H; h++) {
    const col = column(arr, D, h).sort();
    qs.forEach((q, i) => (out[i][h] = quantileSorted(col, q)));
  }
  return out;
}

export function quantiles(values: Float64Array, qs: number[] = QS): number[] {
  const s = Float64Array.from(values).sort();
  return qs.map((q) => quantileSorted(s, q));
}

/** premium-weighted combined ratio of forecast year 1 (quarters 1-4) or 2 (5-8), per draw.
 *  weights: npe of the same run by default, or another run's npe (baseline weights for exact attributions). */
export function yearCr(sim: Sim, year: 1 | 2, weights: Float64Array = sim.npe): Float64Array {
  const out = new Float64Array(sim.D);
  const h0 = year === 1 ? 0 : 4;
  for (let d = 0; d < sim.D; d++) {
    const i = d * H + h0;
    // numpy: (cr * npe).sum(1) / npe.sum(1), each row summed left to right
    const num = sim.cr[i] * weights[i] + sim.cr[i + 1] * weights[i + 1] + sim.cr[i + 2] * weights[i + 2]
      + sim.cr[i + 3] * weights[i + 3];
    const den = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
    out[d] = num / den;
  }
  return out;
}

function rint(y: number): number {
  const fl = Math.floor(y);
  const diff = y - fl;
  if (diff > 0.5) return fl + 1;
  if (diff < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

/** numpy's round(x, decimals) for decimals >= 0: multiply, round half to even, divide */
export function npRound(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return rint(x * f) / f;
}

/** Python's round(x, nd): correctly rounded on the exact binary value, exact ties to even (|x| < 1e21) */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  const exactStr = Math.abs(x).toFixed(100);
  const dot = exactStr.indexOf(".");
  const tail = exactStr.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {
    const kept = exactStr.slice(0, dot + 1 + nd);
    const last = Number(kept[kept.length - 1]);
    const down = Number(kept);
    const up = Number((down + 10 ** -nd).toFixed(nd));
    const r = last % 2 === 0 ? down : up;
    return x < 0 ? -r : r;
  }
  return Number(x.toFixed(nd));
}

export interface Summary {
  lr: number[][];
  cr: number[][];
  roe: number[][];
  bvx: number[][];
  cap: number[][];
  p_cr_over_100: number[];
  p_year_cr_over_100: number[];
  bv_8q: number[];
  p_bv_down_10: number;
  cap_8q: number[];
  p_cap_negative: number;
}

/** sil/model/simulate.py summarize(), including its rounding */
export function summarize(sim: Sim): Summary {
  const D = sim.D;
  const r5 = (m: number[][]) => m.map((row) => row.map((v) => npRound(v, 5)));
  const pOver: number[] = [];
  for (let h = 0; h < H; h++) {
    let n = 0;
    for (let d = 0; d < D; d++) if (sim.cr[d * H + h] > 1.0) n++;
    pOver.push(npRound(n / D, 4));
  }
  const share = (a: Float64Array, test: (v: number) => boolean) => {
    let n = 0;
    for (const v of a) if (test(v)) n++;
    return n / a.length;
  };
  const y1 = yearCr(sim, 1);
  const y2 = yearCr(sim, 2);
  const lastBv = column(sim.bvx, D, H - 1);
  const lastCap = column(sim.cap, D, H - 1);
  return {
    lr: r5(quantilesByQuarter(sim.lr, D)),
    cr: r5(quantilesByQuarter(sim.cr, D)),
    roe: r5(quantilesByQuarter(sim.roe, D)),
    bvx: r5(quantilesByQuarter(sim.bvx, D)),
    cap: r5(quantilesByQuarter(sim.cap, D)),
    p_cr_over_100: pOver,
    p_year_cr_over_100: [pyRound(share(y1, (v) => v > 1), 4), pyRound(share(y2, (v) => v > 1), 4)],
    bv_8q: quantiles(lastBv).map((v) => npRound(v, 5)),
    p_bv_down_10: pyRound(share(lastBv, (v) => v < 0.9), 4),
    cap_8q: quantiles(lastCap).map((v) => npRound(v, 5)),
    p_cap_negative: pyRound(share(lastCap, (v) => v < 0), 4),
  };
}

// ---------------------------------------------------------------- runs over the whole model
export interface RunSettings {
  scenario: string; // key or "baseline"
  severity: number;
  overlays: boolean;
}

export function baseInput(model: ModelData): BaseInput {
  return model.base;
}

export function simOptions(model: ModelData, severity: number, overlays: boolean): SimOptions {
  return { seedBase: model.seedBase, tax: model.tax, severity, overlays };
}

/** Simulate every modeled company: Map cik -> Sim */
export function runAll(model: ModelData, settings: RunSettings): Map<number, Sim> {
  const shock = scenarioInputs(model, settings.scenario);
  const opts = simOptions(model, settings.scenario === "baseline" ? 0 : settings.severity, settings.overlays);
  const out = new Map<number, Sim>();
  for (const c of model.companies) out.set(c.cik, simulateCompany(c, model.base, shock, opts));
  return out;
}

// ---------------------------------------------------------------- exact attribution of a CR change
export interface Contribution {
  key: string;
  label: string;
  delta: number; // change in the year's mean combined ratio vs baseline (fraction; 0.01 = 1 point)
}

/**
 * Change in forecast year N's mean combined ratio vs the baseline, split by component. Each component is run
 * alone (same posterior draws, same noise), and every year average uses the BASELINE premium weights, so the
 * components add up exactly to the total (the loss ratio is linear in every shock given the draws).
 */
export function contributions(
  model: ModelData, c: ModelCompany, scenarioKey: string, severity: number, overlays: boolean, year: 1 | 2,
  baseline?: Sim,
): { parts: Contribution[]; total: number; baselineMean: number; scenarioMean: number } {
  const K = model.features.length;
  const base = baseline ?? simulateCompany(c, model.base, zeroShock(K), simOptions(model, 0, false));
  const w = base.npe;
  const meanYear = (s: Sim) => {
    const v = yearCr(s, year, w);
    let acc = 0;
    for (const x of v) acc += x;
    return acc / v.length;
  };
  const baseMean = meanYear(base);
  const full = scenarioInputs(model, scenarioKey);
  const opts = simOptions(model, severity, overlays);
  const parts: Contribution[] = [];
  const run = (shock: ShockInput, o: SimOptions = opts) => meanYear(simulateCompany(c, model.base, shock, o)) - baseMean;
  for (let k = 0; k < K; k++) {
    const s = zeroShock(K);
    s.features[k] = full.features[k];
    parts.push({ key: model.features[k], label: model.featureLabels[model.features[k]] ?? model.features[k], delta: run(s) });
  }
  const fs = zeroShock(K);
  fs.f = full.f;
  parts.push({ key: "f", label: "Industry (catastrophe) shock", delta: run(fs) });
  const os = zeroShock(K);
  os.overlays = full.overlays;
  parts.push({ key: "overlays", label: "Assumption overlays", delta: overlays ? run(os) : 0 });
  const scenarioMean = meanYear(simulateCompany(c, model.base, full, opts));
  return { parts, total: scenarioMean - baseMean, baselineMean: baseMean, scenarioMean };
}

// ---------------------------------------------------------------- the specialty peer aggregate
/**
 * Premium-weighted combined ratio across the given companies, per draw and quarter: the shared driver paths
 * and industry shock keep the correlation between carriers. Returns quantiles by quarter.
 */
export function peerAggregate(sims: Sim[], qs: number[] = QS): { quantiles: number[][]; perDraw: Float64Array } {
  if (!sims.length) return { quantiles: qs.map(() => new Array<number>(H).fill(NaN)), perDraw: new Float64Array(0) };
  const D = Math.min(...sims.map((s) => s.D));
  const agg = new Float64Array(D * H);
  for (let d = 0; d < D; d++) {
    for (let h = 0; h < H; h++) {
      let num = 0;
      let den = 0;
      for (const s of sims) {
        const i = d * H + h;
        num += s.cr[i] * s.npe[i];
        den += s.npe[i];
      }
      agg[d * H + h] = num / den;
    }
  }
  return { quantiles: quantilesByQuarter(agg, D, qs), perDraw: agg };
}

/** share of draws with year-N premium-weighted combined ratio above 100% */
export function probYearOver100(sim: Sim, year: 1 | 2): number {
  const v = yearCr(sim, year);
  let n = 0;
  for (const x of v) if (x > 1) n++;
  return n / v.length;
}

export function median(values: Float64Array): number {
  return quantiles(values, [0.5])[0];
}
