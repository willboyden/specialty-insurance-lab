// Claims section helpers: accident-year development, age-to-age factors, year-label thinning, captions' statistics.
import { describe, expect, it } from "vitest";
import { ageToAge, developmentVsFirst, latestOf } from "../src/charts/claims-triangle";
import { thinYearLabels } from "../src/charts/claims-devbars";
import { _test } from "../src/sections/claims";
import type { ClaimsLine } from "../src/domains/claims";

const line: ClaimsLine = {
  name: "Casualty", ays: [2021, 2022, 2023],
  incurred: [[100, 110, 121], [200, 190, null], [300, null, null]],
  paid: [[10, 50, 90], [20, 80, null], [30, null, null]],
  ibnr: [5, 20, 60], claims: [10, 12, 15], payout: [0.2, 0.4, 0.2], size: 611,
};

describe("accident-year development", () => {
  it("measures each estimate against the first one", () => {
    const d = developmentVsFirst(line);
    expect(d[0]).toEqual([0, 0.10000000000000009, 0.20999999999999996]);
    expect(d[1][1]).toBeCloseTo(-0.05, 12);
    expect(d[2]).toEqual([0, null, null]);
  });
  it("computes volume-weighted age-to-age factors over the accident years present at both ages", () => {
    const f = ageToAge(line.incurred);
    expect(f[0]).toBeCloseTo((110 + 190) / (100 + 200), 12);
    expect(f[1]).toBeCloseTo(121 / 110, 12);
  });
  it("reads the latest value of a row", () => {
    expect(latestOf([1, 2, null])).toBe(2);
    expect(latestOf([null, null])).toBeNull();
  });
});

describe("year labels", () => {
  const years = Array.from({ length: 17 }, (_, i) => 2009 + i);
  it("always keeps the chosen year and never puts two labels closer than the gap", () => {
    const center = (i: number) => i * 20; // 20px per year
    const keep = thinYearLabels(years, center, 34, 16);
    expect(keep).toContain(16);
    for (let k = 1; k < keep.length; k++) expect(center(keep[k]) - center(keep[k - 1])).toBeGreaterThanOrEqual(34);
  });
  it("labels every year when there is room", () => {
    expect(thinYearLabels(years, (i) => i * 60, 34, -1)).toHaveLength(17);
  });
});

describe("caption statistics", () => {
  it("pearson correlation", () => {
    expect(_test.pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(_test.pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(_test.pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });
  it("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(_test.ordinal)).toEqual(
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
  });
});
