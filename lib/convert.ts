import { roundHalfUpDiv } from "./pricing";

export const MAX_RATIO = 1_000_000;

export function parsePositiveInt(input: unknown, max = MAX_RATIO): number | null {
  const value = typeof input === "string" && /^\d+$/.test(input.trim()) ? Number(input.trim()) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) return null;
  return value;
}

export function convertToBase(qty: number, numerator: number, denominator: number): number | null {
  if (!Number.isInteger(qty) || qty <= 0) return null;
  if (!Number.isInteger(numerator) || numerator <= 0 || numerator > MAX_RATIO) return null;
  if (!Number.isInteger(denominator) || denominator <= 0 || denominator > MAX_RATIO) return null;
  if (qty > Math.floor(Number.MAX_SAFE_INTEGER / numerator)) return null;
  const base = roundHalfUpDiv(qty * numerator, denominator);
  return base > 0 ? base : null;
}
