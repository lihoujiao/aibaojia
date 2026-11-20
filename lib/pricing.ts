import { COMMISSION_RULE } from "./rules";

export const PRICE_RULE_STATUS = "已确认公式；按分四舍五入为建议默认" as const;

export function roundHalfUpDiv(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || numerator < 0) {
    throw new Error("分子必须是非负整数");
  }
  if (!Number.isInteger(denominator) || denominator <= 0) {
    throw new Error("分母必须是正整数");
  }
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

export function commissionCents(floorPriceCents: number, commissionBps: number): number {
  if (!Number.isInteger(floorPriceCents) || floorPriceCents < 0) {
    throw new Error("底价必须是非负整数分");
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0) {
    throw new Error("佣金比例必须是非负整数基点");
  }
  return roundHalfUpDiv(floorPriceCents * commissionBps, 10_000);
}

export function platformPriceCents(floorPriceCents: number, commissionBps: number): number {
  return floorPriceCents + commissionCents(floorPriceCents, commissionBps);
}

export function formatYuanFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${yuan}.${frac}`;
}

export function parseYuanToCents(input: unknown): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0 || input > 10_000_000) return null;
    const scaled = input * 100;
    const cents = Math.round(scaled);
    if (Math.abs(scaled - cents) > 1e-6) return null;
    return cents;
  }
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

export function parsePercentToBps(input: unknown): number | null {
  const bps = parseYuanToCents(input);
  if (bps === null || bps > 10_000) return null;
  return bps;
}

export function breakdown(quoteId: string, floorPriceCents: number, commissionBps: number) {
  const fee = commissionCents(floorPriceCents, commissionBps);
  const platform = floorPriceCents + fee;
  return {
    quoteId,
    floorPriceCents,
    floorPriceYuan: formatYuanFromCents(floorPriceCents),
    commissionBps,
    commissionPercent: formatYuanFromCents(commissionBps),
    commissionCents: fee,
    commissionYuan: formatYuanFromCents(fee),
    platformPriceCents: platform,
    platformPriceYuan: formatYuanFromCents(platform),
    ruleStatus: PRICE_RULE_STATUS,
    formula: COMMISSION_RULE,
  };
}
