// Number and date formatting. Every displayed value goes through here, so units stay consistent.
import { format } from "d3-format";

const pct1 = format(".1f");
const pct0 = format(".0f");
const comma0 = format(",.0f");

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return (digits === 0 ? pct0(v * 100) : pct1(v * 100)) + "%";
}

/** signed percentage points, e.g. "+2.4 pts" */
export function pts(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const s = (v * 100).toFixed(digits);
  return (v > 0 ? "+" : v < 0 ? "−" : "") + s.replace("-", "") + " pts";
}

export function signedPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const s = Math.abs(v * 100).toFixed(digits);
  return (v > 0 ? "+" : v < 0 ? "−" : "±") + s + "%";
}

export function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  return `${sign}$${comma0(a)}`;
}

export function times(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return v.toFixed(digits) + "×";
}

export function num(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return v.toFixed(digits);
}

export function count(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return comma0(v);
}

/** "2026-09-30" -> "Q3 2026" */
export function quarterLabel(iso: string): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  return `Q${Math.ceil(m / 3)} ${y}`;
}

export function shortQuarter(iso: string): string {
  const y = iso.slice(2, 4);
  const m = Number(iso.slice(5, 7));
  return `Q${Math.ceil(m / 3)} '${y}`;
}

export function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
