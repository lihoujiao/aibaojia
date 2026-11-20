export const INTEREST_RULE = {
  capitalCost: "simple",
  dayCountDenominator: 365,
  overdueRollover: "monthly",
  overlapAfterDue: "both",
  paymentDayAccruesInterest: false,
  termDayOne: "ship_date",
  roundingStage: "when_calculating_interest",
  roundingPrecision: "fen",
  roundingPriority: "half_up_overrides_sub_fen_discard",
} as const;

export type TermWindow = {
  shipDate: string;
  termDays: number;
  termEnd: string;
  overdueStart: string;
};

function shiftDate(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error("日期必须是 YYYY-MM-DD");
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

export function termWindow(shipDate: string, termDays: number): TermWindow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)) return null;
  if (!Number.isInteger(termDays) || termDays < 1) return null;
  const termEnd = shiftDate(shipDate, termDays - 1);
  return { shipDate, termDays, termEnd, overdueStart: shiftDate(termEnd, 1) };
}

export type SimpleInterestProbe = {
  enabledAsOfficial: false;
  exactCents: number | null;
  halfUpFen: number;
  numerator: string;
  denominator: string;
  rounding: "half_up_to_fen";
};

export function halfUpYuanToFen(numerator: bigint, denominator: bigint): bigint | null {
  if (numerator < BigInt(0) || denominator <= BigInt(0)) return null;
  const fenNumerator = numerator * BigInt(100);
  const quotient = fenNumerator / denominator;
  const remainder = fenNumerator % denominator;
  if (remainder * BigInt(2) >= denominator) return quotient + BigInt(1);
  return quotient;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < BigInt(0) ? -a : a;
  let y = b < BigInt(0) ? -b : b;
  while (y !== BigInt(0)) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

export function simpleInterestProbe(principalCents: number, annualPercent: string, days: number): SimpleInterestProbe | null {
  if (!Number.isInteger(principalCents) || principalCents < 0) return null;
  if (!Number.isInteger(days) || days < 0) return null;
  if (!/^\d+\.\d{2}$/.test(annualPercent)) return null;
  const [whole, frac] = annualPercent.split(".");
  const percentHundredths = BigInt(whole) * BigInt(100) + BigInt(frac);
  if (percentHundredths > BigInt(1_000_000)) return null;
  const numerator = BigInt(principalCents) * percentHundredths * BigInt(days);
  const denominator = BigInt(10_000) * BigInt(365);
  const divisor = gcd(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;
  const exact = reducedDenominator === BigInt(1);
  const halfUp = halfUpYuanToFen(reducedNumerator, reducedDenominator * BigInt(100));
  if (halfUp == null) return null;
  return {
    enabledAsOfficial: false,
    exactCents: exact ? Number(reducedNumerator) : null,
    halfUpFen: Number(halfUp),
    numerator: reducedNumerator.toString(),
    denominator: reducedDenominator.toString(),
    rounding: "half_up_to_fen",
  };
}
