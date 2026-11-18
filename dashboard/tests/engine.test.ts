// Parity of the browser engine (src/engine.ts) with the Python reference (sil/model/simulate.py).
// The fixture (tests/fixtures/engine.json) is written by scripts/make_engine_fixture.py; it embeds the exact
// inputs it used, so this test does not break when model.json is re-exported. Regenerate it only when the
// simulation arithmetic changes:  .venv/bin/python -I scripts/make_engine_fixture.py
import { describe, expect, it } from "vitest";
import fixtureText from "./fixtures/engine.json?raw";
import modelText from "../public/data/model.json?raw";
import {
  H, Mulberry32, contributions, npRound, peerAggregate, pyRound, pySum, quantilesByQuarter, runAll,
  scenarioInputs, shockFromScenario, simOptions, simulateCompany, streamSeed, summarize, zeroShock,
  type BaseInput, type Sim,
} from "../src/engine";
import type { ModelCompany, ModelData, Overlay } from "../src/types";

interface FixtureRun {
  ticker: string;
  cik: number;
  scenario: string;
  severity: number;
  overlays: boolean;
  out: Record<"lr" | "cr" | "roe" | "bvx" | "cap" | "npe", number[][]>;
  summary: ReturnType<typeof summarize>;
  raw: Record<"lr" | "cr" | "roe" | "bvx" | "cap", number[][]> & { p_cr_over_100_count: number[] };
}

interface Fixture {
  seedBase: number;
  draws: number;
  storedDraws: number;
  features: string[];
  base: BaseInput;
  scenario: { key: string; shock: ModelData["scenarios"][number]["shock"]; overlays: Overlay[] };
  companies: ModelCompany[];
  runs: FixtureRun[];
}

const fixture = JSON.parse(fixtureText) as Fixture;
const model = JSON.parse(modelText) as ModelData;

function runFixture(run: FixtureRun): Sim {
  const c = fixture.companies.find((x) => x.cik === run.cik)!;
  const shock = run.scenario === "baseline"
    ? zeroShock(fixture.features.length)
    : shockFromScenario({ shock: fixture.scenario.shock, overlays: fixture.scenario.overlays });
  return simulateCompany(c, fixture.base, shock, {
    seedBase: fixture.seedBase, tax: 0.21, severity: run.severity, overlays: run.overlays,
  });
}

let worstAbs = 0;

describe("random numbers and Python arithmetic", () => {
  it("mulberry32 matches the Python port bit for bit", () => {
    expect(streamSeed(20261117, 5, 3)).toBe(20614899);
    const r = new Mulberry32(streamSeed(20261117, 5, 3));
    const u = [0.6475584753789008, 0.10218400997109711, 0.5388550849165767, 0.7621232108213007, 0.31479012640193105];
    for (const v of u) expect(r.next()).toBe(v);
  });

  it("normal and Student-t draws match Python", () => {
    const r = new Mulberry32(123456789);
    const n = [0.7591867812298841, 0.4770723819937893, -0.01566465839321832];
    for (const v of n) expect(Math.abs(r.normal() - v)).toBeLessThanOrEqual(1e-15);
    const t = [-0.5072390006870611, 1.1302821181557328, -2.9125231878056685];
    for (const v of t) expect(Math.abs(r.studentT5() - v)).toBeLessThanOrEqual(1e-14);
  });

  it("pySum reproduces CPython's compensated and mixed float/numpy sums", () => {
    const v = [0.8668944481951217, 1.0136791852679572, 0.3847111106062966, 0.5730611363620729];
    expect(pySum(v, [true, true, true, true])).toBe(2.8383458804314485); // Neumaier
    expect(pySum(v, [true, true, false, false])).toBe(2.838345880431448);
    expect(pySum(v, [false, false, false, false])).toBe(2.838345880431448); // left to right
  });

  it("rounding follows numpy (multiply-rint-divide) and Python (exact value, ties to even)", () => {
    expect(pyRound(5 / 160, 4)).toBe(0.0312);
    expect(pyRound(1 / 160, 4)).toBe(0.0063);
    expect(npRound(1 / 160, 4)).toBe(0.0062);
    expect(pyRound(3 / 160, 4)).toBe(0.0187);
    expect(npRound(0.123455, 5)).toBe(0.12346);
    expect(npRound(2.5e-5, 5)).toBe(2e-5);
  });
});

describe("parity with sil/model/simulate.py", () => {
  for (const run of fixture.runs) {
    it(`${run.ticker} ${run.scenario} severity ${run.severity}: every stored value within 1e-9`, () => {
      const sim = runFixture(run);
      const stored = fixture.storedDraws;
      for (const key of ["lr", "cr", "roe", "bvx", "cap"] as const) {
        for (let d = 0; d < stored; d++) {
          for (let h = 0; h < H; h++) {
            const diff = Math.abs(sim[key][d * H + h] - run.out[key][d][h]);
            worstAbs = Math.max(worstAbs, diff);
            expect(diff).toBeLessThanOrEqual(1e-9);
          }
        }
      }
      for (let d = 0; d < stored; d++) {
        for (let h = 0; h < H; h++) {
          const want = run.out.npe[d][h];
          expect(Math.abs(sim.npe[d * H + h] - want) / Math.abs(want)).toBeLessThanOrEqual(1e-12);
        }
      }
    });

    it(`${run.ticker} ${run.scenario}: summaries over all ${fixture.draws} draws match`, () => {
      const sim = runFixture(run);
      expect(summarize(sim)).toEqual(run.summary);
      for (const key of ["lr", "cr", "roe", "bvx", "cap"] as const) {
        const q = quantilesByQuarter(sim[key], sim.D);
        q.forEach((row, i) => row.forEach((v, h) => expect(Math.abs(v - run.raw[key][i][h])).toBeLessThanOrEqual(1e-9)));
      }
    });
  }

  it("worst absolute difference is at the level of floating-point rounding", () => {
    // log/cos/pow may differ by one unit in the last place between libm and V8; nothing more
    console.log(`worst absolute difference vs Python: ${worstAbs.toExponential(2)}`);
    expect(worstAbs).toBeLessThan(1e-12);
  });
});

describe("engine properties on the exported model", () => {
  it("every modeled company simulates to finite values", () => {
    const sims = runAll(model, { scenario: "polycrisis", severity: 2, overlays: true });
    expect(sims.size).toBe(model.companies.length);
    for (const s of sims.values()) {
      for (const k of ["lr", "cr", "roe", "bvx", "cap", "npe"] as const) {
        expect(s[k].every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  });

  it("severity 0 reproduces the baseline exactly", () => {
    const K = model.features.length;
    for (const c of model.companies.slice(0, 8)) {
      const base = simulateCompany(c, model.base, zeroShock(K), simOptions(model, 0, false));
      const zero = simulateCompany(c, model.base, scenarioInputs(model, "polycrisis"), simOptions(model, 0, true));
      expect(Array.from(zero.cr)).toEqual(Array.from(base.cr));
      expect(Array.from(zero.cap)).toEqual(Array.from(base.cap));
    }
  });

  it("contributions add up to the total change", () => {
    for (const key of model.scenarios.map((s) => s.key)) {
      for (const c of model.companies) {
        for (const year of [1, 2] as const) {
          const res = contributions(model, c, key, 1.3, true, year);
          const sum = res.parts.reduce((a, p) => a + p.delta, 0);
          expect(Math.abs(sum - res.total)).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });

  it("the peer aggregate is a premium-weighted average of its members", () => {
    const sims = [...runAll(model, { scenario: "climate", severity: 1, overlays: true }).values()].slice(0, 5);
    const agg = peerAggregate(sims);
    for (let h = 0; h < H; h++) {
      const lo = Math.min(...sims.map((s) => Math.min(...Array.from({ length: s.D }, (_, d) => s.cr[d * H + h]))));
      const hi = Math.max(...sims.map((s) => Math.max(...Array.from({ length: s.D }, (_, d) => s.cr[d * H + h]))));
      expect(agg.quantiles[2][h]).toBeGreaterThanOrEqual(lo);
      expect(agg.quantiles[2][h]).toBeLessThanOrEqual(hi);
    }
  });

  it("a full recompute of every company is fast", () => {
    const t0 = performance.now();
    runAll(model, { scenario: "polycrisis", severity: 1, overlays: true });
    runAll(model, { scenario: "baseline", severity: 0, overlays: false });
    const ms = performance.now() - t0;
    console.log(`full recompute (scenario + baseline, ${model.companies.length} companies x ${model.draws} draws): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
