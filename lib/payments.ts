import { randomBytes } from "node:crypto";
import type { Db } from "./db";
import { exec, getPool, one, query } from "./db";
import { INTEREST_RULE, termWindow } from "./interest-rule";
import type { Actor, Err, Result } from "./types";

export const PAYMENT_METHODS = ["cash", "barter", "term"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type PaymentInput = {
  method: string;
  termDays?: number | null;
  capitalCostAnnualPercent?: unknown;
  overdueAnnualPercent?: unknown;
  agreementPriceCents?: unknown;
};

export type PaymentSnapshot = {
  method: PaymentMethod | null;
  termDays: number | null;
  capitalCostAnnualPercent: string | null;
  overdueAnnualPercent: string | null;
  agreementPriceCents: number | null;
};

export const RATE_UNIT_NOTE = "年利率按百分比输入，最多两位小数。5.25 表示 5.25%，不是 5.25 基点。";
export const MAX_ANNUAL_PERCENT = "10000.00";

const BLOCKING_REASONS = [
  "OVERDUE_MONTH_ANCHOR_UNCONFIRMED",
  "OVERDUE_PARTIAL_MONTH_UNCONFIRMED",
] as const;

function nid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function fail(code: string, message: string, httpStatus: number): Err {
  return { ok: false, code, message, httpStatus };
}

function integerIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

export function parseAnnualPercent(value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === "string") text = value.trim();
  else if (typeof value === "number" && Number.isFinite(value)) {
    const scaled = value * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) return null;
    text = (rounded / 100).toFixed(2);
  }
  if (text == null || !/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 2) return null;
  const cents = (frac + "00").slice(0, 2);
  const canonical = `${String(Number(whole))}.${cents}`;
  const wholeNumber = Number(whole);
  if (!Number.isSafeInteger(wholeNumber) || wholeNumber > 10_000) return null;
  if (wholeNumber === 10_000 && cents !== "00") return null;
  return canonical;
}

export function percentToBasisPoints(percent: string): string {
  const canonical = parseAnnualPercent(percent);
  if (canonical == null) throw new Error("无法把非百分比年利率换成基点");
  const digits = canonical.replace(".", "").replace(/^0+(?=\d)/, "");
  return `${digits}.00`;
}

function emptySnapshot(): PaymentSnapshot {
  return { method: null, termDays: null, capitalCostAnnualPercent: null, overdueAnnualPercent: null, agreementPriceCents: null };
}

export function normalizePayment(input: PaymentInput | null | undefined): Result<PaymentSnapshot> {
  if (input == null) return { ok: true, data: emptySnapshot() };
  if (!PAYMENT_METHODS.includes(input.method as PaymentMethod)) {
    return fail("INVALID_INPUT", "付款方式只能是现金、易货或限期。没有预选默认方式。", 400);
  }
  const method = input.method as PaymentMethod;
  const agreement = integerIn(input.agreementPriceCents, 0, 1_000_000_000);
  if (agreement == null) {
    return fail("AGREEMENT_PRICE_REQUIRED", "请提交下单时的协议价，单位是分。不能改用标价或当前报价。", 400);
  }
  if (method !== "term") {
    if (input.termDays != null || input.capitalCostAnnualPercent != null || input.overdueAnnualPercent != null) {
      return fail("INVALID_INPUT", "现金和易货不保存限期天数或利率。这两类的结算细则仍待确认。", 400);
    }
    return { ok: true, data: { method, termDays: null, capitalCostAnnualPercent: null, overdueAnnualPercent: null, agreementPriceCents: agreement } };
  }
  const termDays = integerIn(input.termDays, 1, 36500);
  const capital = parseAnnualPercent(input.capitalCostAnnualPercent);
  const overdue = parseAnnualPercent(input.overdueAnnualPercent);
  if (termDays == null || capital == null || overdue == null) {
    return fail("INVALID_INPUT", `限期必须同时提交正整数天数，以及各自独立的资金成本年利率和逾期年利率。${RATE_UNIT_NOTE} 超过两位小数会拒绝，不会四舍五入。上限 10000.00%，等于原先 1000000 基点，不是把 1000000 当成百分比。不预填十天、二十天或任何利率。`, 400);
  }
  return { ok: true, data: { method, termDays, capitalCostAnnualPercent: capital, overdueAnnualPercent: overdue, agreementPriceCents: agreement } };
}

export function samePayment(left: PaymentSnapshot, right: PaymentSnapshot): boolean {
  return left.method === right.method && left.termDays === right.termDays && left.capitalCostAnnualPercent === right.capitalCostAnnualPercent && left.overdueAnnualPercent === right.overdueAnnualPercent && left.agreementPriceCents === right.agreementPriceCents;
}

type OrderPay = {
  id: string;
  merchant_id: string;
  qty_base: number;
  qty_fulfilled_base: number;
  payment_method: PaymentMethod | null;
  term_days: number | null;
  capital_cost_annual_bps: string | number | null;
  overdue_annual_bps: string | number | null;
  capital_cost_annual_percent: string | number | null;
  overdue_annual_percent: string | number | null;
  principal_cents: number | null;
  principal_paid_cents: number;
  platform_price_cents: number;
  agreement_price_cents: number | null;
  agreement_price_source: string | null;
};

async function loadOrder(db: Db, orderId: string, lock = false): Promise<OrderPay | null> {
  return one<OrderPay>(db, `SELECT id, merchant_id, qty_base, qty_fulfilled_base, payment_method, term_days, capital_cost_annual_bps::text, overdue_annual_bps::text, capital_cost_annual_percent::text, overdue_annual_percent::text, principal_cents, principal_paid_cents, platform_price_cents, agreement_price_cents, agreement_price_source FROM orders WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [orderId]);
}

function percentText(value: string | number | null): string | null {
  if (value == null || value === "") return null;
  return parseAnnualPercent(String(value));
}

function agreedPrincipal(order: OrderPay): number | null {
  if (order.agreement_price_cents == null || order.agreement_price_source !== "order_time_explicit") return null;
  return order.agreement_price_cents;
}

function canRead(actor: Actor, merchantId: string, groupId: string | null): Result<true> {
  if (actor.role === "customer_service") return fail("FORBIDDEN", "客服不默认查看付款。", 403);
  if (actor.role === "platform") return { ok: true, data: true };
  if (actor.role === "merchant") {
    if (actor.merchantId !== merchantId) return fail("FORBIDDEN", "不能查看其他商家的付款。", 403);
    return { ok: true, data: true };
  }
  if (actor.role === "group") {
    if (!actor.groupId || actor.groupId !== groupId) return fail("FORBIDDEN", "不能查看旗下以外的付款。", 403);
    return { ok: true, data: true };
  }
  return fail("PAYMENT_ROLE_UNCONFIRMED", "这个身份能否办理付款尚未确认，因此拒绝。", 409);
}

function canWrite(actor: Actor, merchantId: string): Result<true> {
  if (actor.role === "merchant" && actor.merchantId === merchantId) return { ok: true, data: true };
  if (actor.role === "merchant") return fail("FORBIDDEN", "不能修改其他商家的付款。", 403);
  return fail("PAYMENT_ROLE_UNCONFIRMED", "除本商家外，谁可以登记付款尚未确认，因此拒绝。", 409);
}

async function merchantGroup(db: Db, merchantId: string): Promise<string | null> {
  const row = await one<{ group_id: string | null }>(db, "SELECT group_id FROM merchants WHERE id = $1", [merchantId]);
  return row?.group_id ?? null;
}

export async function shanghaiDate(db: Db, instantIso: string): Promise<string> {
  const row = await one<{ d: string }>(db, "SELECT ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::text AS d", [instantIso]);
  if (!row?.d) throw new Error("无法按 Asia/Shanghai 取日历日");
  return row.d;
}

export async function recordShipmentBatch(client: Db, orderId: string, merchantId: string, outboundDocId: string, qtyBase: number): Promise<void> {
  await exec(
    client,
    `INSERT INTO shipment_batches (id, order_id, merchant_id, outbound_doc_id, qty_base, ship_date, created_at)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE 'Asia/Shanghai')::date, NOW())`,
    [nid("bat"), orderId, merchantId, outboundDocId, qtyBase],
  );
  await exec(
    client,
    `INSERT INTO payment_audit (id, merchant_id, order_id, action, actor_user_id, actor_name, note, created_at)
     VALUES ($1, $2, $3, 'shipment_batch', 'system:shipment', '出库确认', '记录发货批次。发货日取 Asia/Shanghai 日历日。本金仍按整单登记，不把金额拆到批次。', NOW())`,
    [nid("pau"), merchantId, orderId],
  );
}

export async function registerPaymentTerms(
  actor: Actor,
  orderId: string,
  input: PaymentInput,
): Promise<Result<PaymentSnapshot>> {
  const normalized = normalizePayment(input);
  if (!normalized.ok) return normalized;
  if (!normalized.data.method) return fail("INVALID_INPUT", "请明确选择现金、易货或限期。", 400);
  const order = await loadOrder(getPool(), orderId);
  if (!order) return fail("NOT_FOUND", "没有这张订单。", 404);
  const allowed = canWrite(actor, order.merchant_id);
  if (!allowed.ok) return allowed;
  const next = normalized.data;
  const { transaction } = await import("./db");
  return transaction(async (client) => {
    const locked = await loadOrder(client, orderId, true);
    if (!locked) return fail("NOT_FOUND", "没有这张订单。", 404);
    const current: PaymentSnapshot = {
      method: locked.payment_method,
      termDays: locked.term_days,
      capitalCostAnnualPercent: percentText(locked.capital_cost_annual_percent),
      overdueAnnualPercent: percentText(locked.overdue_annual_percent),
      agreementPriceCents: locked.agreement_price_cents,
    };
    if (current.method) {
      if (!samePayment(current, next)) return fail("PAYMENT_ALREADY_SET", "付款方式已经登记。是否允许改写尚未确认，因此不覆盖。", 409);
      return { ok: true, data: current };
    }
    const updated = await one<{ id: string }>(
      client,
      `UPDATE orders
       SET payment_method = $2, term_days = $3, capital_cost_annual_percent = $4, overdue_annual_percent = $5,
           agreement_price_cents = $6, agreement_price_source = 'order_time_explicit', principal_cents = $6
       WHERE id = $1 AND payment_method IS NULL AND agreement_price_cents IS NULL
       RETURNING id`,
      [orderId, next.method, next.termDays, next.capitalCostAnnualPercent, next.overdueAnnualPercent, next.agreementPriceCents],
    );
    if (!updated) return fail("PAYMENT_ALREADY_SET", "付款方式已经登记。是否允许改写尚未确认，因此不覆盖。", 409);
    await exec(
      client,
      `INSERT INTO payment_audit (id, merchant_id, order_id, action, actor_user_id, actor_name, note, created_at)
       VALUES ($1, $2, $3, 'register_terms', $4, $5, $6, NOW())`,
      [nid("pau"), locked.merchant_id, orderId, actor.userId, actor.displayName, `登记付款方式 ${next.method}。本金取下单时协议价 ${next.agreementPriceCents} 分，来源 order_time_explicit。不用标价代替。`],
    );
    return { ok: true, data: next };
  });
}

export async function postRepayment(
  actor: Actor,
  orderId: string,
  input: { amountCents: number; paidOn: string; idempotencyKey: string },
): Promise<Result<{ appliedPrincipalCents: number; unallocatedCents: number; principalRemainingCents: number; replayed: boolean }>> {
  const amount = integerIn(input.amountCents, 1, 1_000_000_000);
  if (amount == null || !input.idempotencyKey.trim()) return fail("INVALID_INPUT", "请填写正整数还款金额和幂等键。", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) return fail("INVALID_INPUT", "付款日必须是明确的日历日，格式 YYYY-MM-DD，不自动填今天。", 400);
  const order = await loadOrder(getPool(), orderId);
  if (!order) return fail("NOT_FOUND", "没有这张订单。", 404);
  const allowed = canWrite(actor, order.merchant_id);
  if (!allowed.ok) return allowed;
  if (!order.payment_method) return fail("PAYMENT_METHOD_UNSET", "这张订单还没有登记付款方式，不能记账。", 409);
  if (agreedPrincipal(order) == null) return fail("AGREEMENT_PRICE_MISSING", "这张订单没有下单时协议价。不能用标价、当前价或旧本金字段代替。历史补录流程尚未确认。", 409);
  const existing = await one<{ order_id: string; applied_principal_cents: number; unallocated_cents: number }>(
    getPool(),
    "SELECT order_id, applied_principal_cents, unallocated_cents FROM repayments WHERE merchant_id = $1 AND idempotency_key = $2",
    [order.merchant_id, input.idempotencyKey.trim()],
  );
  if (existing) {
    if (existing.order_id !== orderId) return fail("IDEMPOTENCY_CONFLICT", "这个幂等键已经用于另一张订单，不能跨单冲抵。", 409);
    const current = await loadOrder(getPool(), orderId);
    return {
      ok: true,
      data: {
        appliedPrincipalCents: existing.applied_principal_cents,
        unallocatedCents: existing.unallocated_cents,
        principalRemainingCents: current ? (agreedPrincipal(current) ?? 0) - current.principal_paid_cents : 0,
        replayed: true,
      },
    };
  }
  let applied = 0;
  let unallocated = 0;
  let remaining = 0;
  let replayed = false;
  const { transaction } = await import("./db");
  await transaction(async (client) => {
    const locked = await loadOrder(client, orderId, true);
    const basis = locked ? agreedPrincipal(locked) : null;
    if (!locked || basis == null) throw new Error("AGREEMENT_PRICE_MISSING");
    const again = await one<{ order_id: string; applied_principal_cents: number; unallocated_cents: number }>(
      client,
      "SELECT order_id, applied_principal_cents, unallocated_cents FROM repayments WHERE merchant_id = $1 AND idempotency_key = $2",
      [locked.merchant_id, input.idempotencyKey.trim()],
    );
    if (again) {
      if (again.order_id !== orderId) throw new Error("IDEMPOTENCY_CONFLICT");
      applied = again.applied_principal_cents;
      unallocated = again.unallocated_cents;
      remaining = basis - locked.principal_paid_cents;
      replayed = true;
      return;
    }
    const openPrincipal = basis - locked.principal_paid_cents;
    applied = Math.min(amount, openPrincipal);
    unallocated = amount - applied;
    remaining = openPrincipal - applied;
    await exec(client, "UPDATE orders SET principal_paid_cents = principal_paid_cents + $2 WHERE id = $1", [orderId, applied]);
    await exec(
      client,
      `INSERT INTO repayments (
         id, order_id, merchant_id, idempotency_key, amount_cents, applied_principal_cents, unallocated_cents, paid_on, actor_user_id, actor_name, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,NOW())`,
      [nid("pay"), orderId, locked.merchant_id, input.idempotencyKey.trim(), amount, applied, unallocated, input.paidOn, actor.userId, actor.displayName],
    );
    await exec(
      client,
      `INSERT INTO payment_audit (id, merchant_id, order_id, action, actor_user_id, actor_name, note, created_at)
       VALUES ($1,$2,$3,'repayment',$4,$5,$6,NOW())`,
      [
        nid("pau"),
        locked.merchant_id,
        orderId,
        actor.userId,
        actor.displayName,
        unallocated > 0
          ? `先还本金 ${applied} 分。超出的 ${unallocated} 分未冲减，因为余款如何处理尚未确认。付款日 ${input.paidOn} 当天不计息。`
          : `先还本金 ${applied} 分。付款日 ${input.paidOn} 当天不计息。`,
      ],
    );
  });
  return { ok: true, data: { appliedPrincipalCents: applied, unallocatedCents: unallocated, principalRemainingCents: remaining, replayed } };
}

export async function explainInterest(actor: Actor, orderId: string): Promise<Result<Record<string, unknown>>> {
  const order = await loadOrder(getPool(), orderId);
  if (!order) return fail("NOT_FOUND", "没有这张订单。", 404);
  const groupId = await merchantGroup(getPool(), order.merchant_id);
  const allowed = canRead(actor, order.merchant_id, groupId);
  if (!allowed.ok) return allowed;
  const batches = await query<{ id: string; qty_base: number; ship_date: string }>(
    getPool(),
    "SELECT id, qty_base, ship_date::text FROM shipment_batches WHERE order_id = $1 ORDER BY ship_date, id",
    [orderId],
  );
  const agreed = agreedPrincipal(order);
  const reasons: string[] = [];
  if (!order.payment_method) reasons.push("PAYMENT_METHOD_UNSET");
  if (agreed == null) reasons.push("AGREEMENT_PRICE_MISSING");
  if (order.payment_method === "term" && percentText(order.capital_cost_annual_percent) == null && order.capital_cost_annual_bps != null) reasons.push("LEGACY_BASIS_POINT_NOT_MIGRATED");
  if (order.payment_method === "cash" || order.payment_method === "barter") reasons.push("CASH_BARTER_SETTLEMENT_UNCONFIRMED");
  if (order.payment_method === "term") {
    reasons.push(...BLOCKING_REASONS);
    const fullSingleBatch = batches.length === 1 && batches[0]?.qty_base === order.qty_base && order.qty_fulfilled_base === order.qty_base;
    if (!fullSingleBatch) reasons.push("BATCH_PRINCIPAL_ALLOCATION_UNCONFIRMED");
    if (order.principal_paid_cents > 0) reasons.push("REMAINDER_INTEREST_UNCONFIRMED");
  }
  return {
    ok: true,
    data: {
      calculable: false,
      officialInterestCents: null,
      reasons,
      pricingNote: "标价沿用现有底价加佣金，只作对照，不是本金。底价不是已确认的真实采购成本。",
      rateUnit: RATE_UNIT_NOTE,
      facts: {
        paymentMethod: order.payment_method,
        termDays: order.term_days,
        capitalCostAnnualPercent: percentText(order.capital_cost_annual_percent),
        overdueAnnualPercent: percentText(order.overdue_annual_percent),
        legacyCapitalCostAnnualBps: order.capital_cost_annual_percent == null && order.capital_cost_annual_bps != null ? String(order.capital_cost_annual_bps) : null,
        legacyOverdueAnnualBps: order.overdue_annual_percent == null && order.overdue_annual_bps != null ? String(order.overdue_annual_bps) : null,
        ratesIndependent: true,
        annualRate: true,
        calendar: "Asia/Shanghai",
        calendarDay: true,
        paymentDayAccruesInterest: false,
        capitalCost: INTEREST_RULE.capitalCost,
        dayCountDenominator: INTEREST_RULE.dayCountDenominator,
        overdueRollover: INTEREST_RULE.overdueRollover,
        overlapAfterDue: INTEREST_RULE.overlapAfterDue,
        simpleInterestOfficial: false,
        roundingStage: INTEREST_RULE.roundingStage,
        roundingPrecision: INTEREST_RULE.roundingPrecision,
        roundingPriority: INTEREST_RULE.roundingPriority,
        agreementPriceCents: agreed,
        agreementPriceSource: agreed == null ? null : order.agreement_price_source,
        platformPriceCents: order.platform_price_cents,
        principalCents: agreed,
        principalPaidCents: order.principal_paid_cents,
        principalRemainingCents: agreed == null ? null : agreed - order.principal_paid_cents,
        termDayOne: INTEREST_RULE.termDayOne,
        batches: batches.map((batch) => {
          const window = order.term_days == null ? null : termWindow(batch.ship_date, order.term_days);
          return {
            id: batch.id,
            qtyBase: batch.qty_base,
            shipDate: batch.ship_date,
            termEnd: window?.termEnd ?? null,
            overdueStart: window?.overdueStart ?? null,
          };
        }),
      },
    },
  };
}

export async function listPayments(actor: Actor): Promise<Result<{ orders: Array<Record<string, unknown>> }>> {
  if (actor.role === "customer_service") return fail("FORBIDDEN", "客服不默认查看付款。", 403);
  const where = actor.role === "platform" ? { sql: "TRUE", params: [] as unknown[] } : actor.role === "merchant" ? { sql: "o.merchant_id = $1", params: [actor.merchantId] } : { sql: "m.group_id = $1", params: [actor.groupId] };
  if (actor.role === "group" && !actor.groupId) return fail("FORBIDDEN", "没有可查看的集团。", 403);
  const rows = await query<OrderPay & { product_name: string; spec_name: string }>(
    getPool(),
    `SELECT o.id, o.merchant_id, o.qty_base, o.qty_fulfilled_base, o.payment_method, o.term_days, o.capital_cost_annual_bps::text, o.overdue_annual_bps::text, o.capital_cost_annual_percent::text, o.overdue_annual_percent::text,
            o.principal_cents, o.principal_paid_cents, o.platform_price_cents, o.agreement_price_cents, o.agreement_price_source, p.name AS product_name, s.spec_name
     FROM orders o
     JOIN skus s ON s.id = o.sku_id
     JOIN products p ON p.id = o.product_id
     JOIN merchants m ON m.id = o.merchant_id
     WHERE ${where.sql}
     ORDER BY o.created_at DESC
     LIMIT 50`,
    where.params,
  );
  const orders = [];
  for (const row of rows) {
    const interest = await explainInterest(actor, row.id);
    const repayments = await query<{ id: string; amount_cents: number; applied_principal_cents: number; unallocated_cents: number; paid_on: string }>(
      getPool(),
      "SELECT id, amount_cents, applied_principal_cents, unallocated_cents, paid_on::text FROM repayments WHERE order_id = $1 ORDER BY created_at",
      [row.id],
    );
    orders.push({
      id: row.id,
      productName: row.product_name,
      specName: row.spec_name,
      paymentMethod: row.payment_method,
      termDays: row.term_days,
      capitalCostAnnualPercent: percentText(row.capital_cost_annual_percent),
      overdueAnnualPercent: percentText(row.overdue_annual_percent),
      legacyCapitalCostAnnualBps: row.capital_cost_annual_percent == null && row.capital_cost_annual_bps != null ? String(row.capital_cost_annual_bps) : null,
      agreementPriceCents: row.agreement_price_cents,
      platformPriceCents: row.platform_price_cents,
      principalCents: row.agreement_price_source === "order_time_explicit" ? row.agreement_price_cents : null,
      principalPaidCents: row.principal_paid_cents,
      interest: interest.ok ? interest.data : null,
      repayments,
    });
  }
  return { ok: true, data: { orders } };
}
