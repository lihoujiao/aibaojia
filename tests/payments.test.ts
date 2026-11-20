import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { one } from "../lib/db";
import { confirmOutbound, createProduct, createQuote, createSku, getActorByPhone, placeOrder, receiveInbound } from "../lib/domain";
import { halfUpYuanToFen, simpleInterestProbe, termWindow } from "../lib/interest-rule";
import { explainInterest, percentToBasisPoints, postRepayment, registerPaymentTerms, shanghaiDate } from "../lib/payments";
import { handleInterest, handleRepayment } from "../lib/http/handlers";
import { authed, login, PHONES, readJson, tempDb } from "./helpers";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

async function stocked(name: string) {
  const actor = await getActorByPhone(PHONES.merchantA);
  if (!actor) throw new Error("缺少商家");
  const pool = (await import("../lib/db")).getPool();
  const product = await createProduct(actor, { name, baseUnitLabel: "件" });
  if (!product.ok) throw new Error(product.message);
  const sku = await createSku(actor, { productId: product.data.productId, specName: "统货" });
  if (!sku.ok) throw new Error(sku.message);
  const unit = await one<{ id: string }>(pool, "SELECT id FROM product_units WHERE product_id = $1 AND is_base", [product.data.productId]);
  if (!(await receiveInbound(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 10 })).ok) throw new Error("入库失败");
  if (!(await createQuote(actor, {
    skuId: sku.data.id,
    floorPriceCents: 100,
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
  })).ok) throw new Error("报价失败");
  return { actor, skuId: sku.data.id, unitId: unit!.id, pool };
}

test("付款方式不默认，限期必须显式给天数和两套年利率", async () => {
  await ctxPromise;
  const { actor, skuId, unitId } = await stocked("付款青菜");
  const plain = await placeOrder(actor, { skuId, unitId, qty: 2, buyerLabel: "未登记", idempotencyKey: "pay-plain" });
  assert.equal(plain.ok, true);
  if (!plain.ok) return;
  const row = await one<{ payment_method: string | null; principal_cents: number | null }>((await import("../lib/db")).getPool(), "SELECT payment_method, principal_cents FROM orders WHERE id = $1", [plain.data.id]);
  assert.equal(row?.payment_method, null);
  assert.equal(row?.principal_cents, null);
  const missing = await registerPaymentTerms(actor, plain.data.id, { method: "term", termDays: 10 });
  assert.equal(missing.ok, false);
  const missingAgreement = await registerPaymentTerms(actor, plain.data.id, { method: "cash" });
  assert.equal(missingAgreement.ok, false);
  if (missingAgreement.ok) return;
  assert.equal(missingAgreement.code, "AGREEMENT_PRICE_REQUIRED");
  const cash = await registerPaymentTerms(actor, plain.data.id, { method: "cash", agreementPriceCents: 4321 });
  assert.equal(cash.ok, true);
  const stored = await one<{ agreement_price_cents: number; principal_cents: number; platform_price_cents: number; source: string }>((await import("../lib/db")).getPool(), "SELECT agreement_price_cents, principal_cents, platform_price_cents, agreement_price_source AS source FROM orders WHERE id = $1", [plain.data.id]);
  assert.equal(stored?.agreement_price_cents, 4321);
  assert.equal(stored?.principal_cents, 4321);
  assert.notEqual(stored?.platform_price_cents, 4321);
  assert.equal(stored?.source, "order_time_explicit");
  const rewrite = await registerPaymentTerms(actor, plain.data.id, { method: "barter", agreementPriceCents: 4321 });
  assert.equal(rewrite.ok, false);
  if (rewrite.ok) return;
  assert.equal(rewrite.code, "PAYMENT_ALREADY_SET");
});

test("正式利息不返回 0，上海日历日不按 UTC 切日", async () => {
  await ctxPromise;
  const { actor, skuId, unitId, pool } = await stocked("计息萝卜");
  const order = await placeOrder(actor, {
    skuId,
    unitId,
    qty: 4,
    buyerLabel: "限期采购方",
    idempotencyKey: "pay-term",
    payment: { method: "term", termDays: 15, capitalCostAnnualPercent: "5.25", overdueAnnualPercent: "0.01", agreementPriceCents: 8000 },
  });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  const saved = await one<{ term_days: number; capital: string; overdue: string; legacy: string | null; principal_cents: number; agreement_price_cents: number; platform_price_cents: number }>(pool, "SELECT term_days, capital_cost_annual_percent::text AS capital, overdue_annual_percent::text AS overdue, capital_cost_annual_bps::text AS legacy, principal_cents, agreement_price_cents, platform_price_cents FROM orders WHERE id = $1", [order.data.id]);
  assert.equal(saved?.term_days, 15);
  assert.equal(saved?.capital, "5.25");
  assert.equal(saved?.overdue, "0.01");
  assert.equal(saved?.legacy, null);
  assert.equal(percentToBasisPoints("5.25"), "525.00");
  assert.equal(percentToBasisPoints("0.01"), "1.00");
  assert.equal(percentToBasisPoints("5"), "500.00");
  assert.equal(saved?.agreement_price_cents, 8000);
  assert.equal(saved?.principal_cents, 8000);
  assert.notEqual(saved?.platform_price_cents, 8000);
  const tooFine = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "过精", idempotencyKey: "pay-fine", payment: { method: "term", termDays: 15, capitalCostAnnualPercent: "5.251", overdueAnnualPercent: "0.01", agreementPriceCents: 8000 } });
  assert.equal(tooFine.ok, false);
  const negative = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "负利率", idempotencyKey: "pay-neg", payment: { method: "term", termDays: 15, capitalCostAnnualPercent: "-1", overdueAnnualPercent: "0", agreementPriceCents: 8000 } });
  assert.equal(negative.ok, false);
  const zero = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "零利率", idempotencyKey: "pay-zero", payment: { method: "term", termDays: 15, capitalCostAnnualPercent: "0", overdueAnnualPercent: "10000", agreementPriceCents: 1 } });
  assert.equal(zero.ok, true);
  const overCap = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "超上限", idempotencyKey: "pay-cap", payment: { method: "term", termDays: 15, capitalCostAnnualPercent: "10000.01", overdueAnnualPercent: "0", agreementPriceCents: 1 } });
  assert.equal(overCap.ok, false);
  const interest = await explainInterest(actor, order.data.id);
  assert.equal(interest.ok, true);
  if (!interest.ok) return;
  assert.equal(interest.data.calculable, false);
  assert.equal(interest.data.officialInterestCents, null);
  const reasons = interest.data.reasons as string[];
  assert.equal(reasons.includes("TERM_COUNT_BOUNDARY_UNCONFIRMED"), false);
  assert.equal(reasons.includes("OVERDUE_MONTH_ANCHOR_UNCONFIRMED"), true);
  assert.equal(reasons.includes("OVERDUE_PARTIAL_MONTH_UNCONFIRMED"), true);
  assert.equal(reasons.includes("AMOUNT_ROUNDING_UNCONFIRMED"), false);
  const rounding = interest.data.facts as { roundingStage: string; roundingPrecision: string; roundingPriority: string };
  assert.equal(rounding.roundingStage, "when_calculating_interest");
  assert.equal(rounding.roundingPrecision, "fen");
  assert.equal(rounding.roundingPriority, "half_up_overrides_sub_fen_discard");
  assert.equal(reasons.includes("DAY_COUNT_DENOMINATOR_UNCONFIRMED"), false);
  assert.equal(reasons.includes("BATCH_PRINCIPAL_ALLOCATION_UNCONFIRMED"), true);
  const facts = interest.data.facts as { capitalCost: string; dayCountDenominator: number; overdueRollover: string; overlapAfterDue: string };
  assert.equal(facts.capitalCost, "simple");
  assert.equal(facts.dayCountDenominator, 365);
  assert.equal(facts.overdueRollover, "monthly");
  assert.equal(facts.overlapAfterDue, "both");
  assert.equal(await shanghaiDate(pool, "2026-11-16T15:30:00Z"), "2026-11-16");
  assert.equal(await shanghaiDate(pool, "2026-11-16T16:30:00Z"), "2026-11-17");
  const shipped = await confirmOutbound(actor, order.data.id, { qty: 1, idempotencyKey: "pay-ship-1" });
  assert.equal(shipped.ok, true);
  const batch = await one<{ ship_date: string; c: string }>(pool, "SELECT ship_date::text, COUNT(*)::text AS c FROM shipment_batches WHERE order_id = $1 GROUP BY ship_date", [order.data.id]);
  assert.equal(batch?.c, "1");
  assert.match(batch?.ship_date ?? "", /^\d{4}-\d{2}-\d{2}$/);
});

test("部分还款先冲本金，超出部分不跨单，重复提交不双记", async () => {
  await ctxPromise;
  const { actor, skuId, unitId, pool } = await stocked("还款白菜");
  const first = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "甲单", idempotencyKey: "pay-a", payment: { method: "term", termDays: 7, capitalCostAnnualPercent: "1", overdueAnnualPercent: "2.05", agreementPriceCents: 9000 } });
  const second = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "乙单", idempotencyKey: "pay-b", payment: { method: "cash", agreementPriceCents: 3000 } });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  const principal = 9000;
  const partial = await postRepayment(actor, first.data.id, { amountCents: 1, paidOn: "2026-11-17", idempotencyKey: "repay-1" });
  const replay = await postRepayment(actor, first.data.id, { amountCents: 1, paidOn: "2026-11-17", idempotencyKey: "repay-1" });
  assert.equal(partial.ok && replay.ok, true);
  if (!partial.ok || !replay.ok) return;
  assert.equal(partial.data.appliedPrincipalCents, 1);
  assert.equal(partial.data.unallocatedCents, 0);
  assert.equal(replay.data.replayed, true);
  const paid = await one<{ principal_paid_cents: number }>(pool, "SELECT principal_paid_cents FROM orders WHERE id = $1", [first.data.id]);
  assert.equal(paid?.principal_paid_cents, 1);
  const other = await getActorByPhone(PHONES.merchantB);
  if (!other) throw new Error("缺少商家乙");
  const denied = await postRepayment(other, first.data.id, { amountCents: 1, paidOn: "2026-11-17", idempotencyKey: "repay-cross" });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, "FORBIDDEN");
  const cookiePlatform = await login(PHONES.platform);
  const platform = await readJson(await handleRepayment(authed(`/api/orders/${first.data.id}/repayments`, cookiePlatform, { method: "POST", body: { amountCents: 1, paidOn: "2026-11-17", idempotencyKey: "plat" } }), first.data.id));
  assert.equal(platform.status, 409);
  assert.equal(platform.body.code, "PAYMENT_ROLE_UNCONFIRMED");
  const excess = await postRepayment(actor, first.data.id, { amountCents: principal + 50, paidOn: "2026-11-18", idempotencyKey: "repay-excess" });
  assert.equal(excess.ok, true);
  if (!excess.ok) return;
  assert.equal(excess.data.appliedPrincipalCents, principal - 1);
  assert.equal(excess.data.unallocatedCents, 51);
  assert.equal(excess.data.principalRemainingCents, 0);
  const otherPaid = await one<{ principal_paid_cents: number }>(pool, "SELECT principal_paid_cents FROM orders WHERE id = $1", [second.data.id]);
  assert.equal(otherPaid?.principal_paid_cents, 0);
  const crossKey = await postRepayment(actor, second.data.id, { amountCents: 1, paidOn: "2026-11-18", idempotencyKey: "repay-excess" });
  assert.equal(crossKey.ok, false);
  if (crossKey.ok) return;
  assert.equal(crossKey.code, "IDEMPOTENCY_CONFLICT");
  const cookie = await login(PHONES.merchantA);
  const view = await readJson(await handleInterest(authed(`/api/orders/${first.data.id}/interest`, cookie), first.data.id));
  assert.equal(view.status, 200);
  assert.equal((view.body.data as { officialInterestCents: number | null }).officialInterestCents, null);
});

test("并发还款不会把本金还成负数", async () => {
  await ctxPromise;
  const { actor, skuId, unitId } = await stocked("并发付款");
  const order = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "并发", idempotencyKey: "pay-race", payment: { method: "barter", agreementPriceCents: 6400 } });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  const dbUrl = process.env.DATABASE_URL!;
  const results = await Promise.all([
    runPay(dbUrl, order.data.id, "race-a", 6400),
    runPay(dbUrl, order.data.id, "race-b", 6400),
  ]);
  assert.equal(results.every((item) => item.ok), true);
  const row = await one<{ principal_paid_cents: number; principal_cents: number }>((await import("../lib/db")).getPool(), "SELECT principal_paid_cents, principal_cents FROM orders WHERE id = $1", [order.data.id]);
  assert.equal(row?.principal_paid_cents, row?.principal_cents);
  const applied = await one<{ s: string }>((await import("../lib/db")).getPool(), "SELECT COALESCE(SUM(applied_principal_cents),0)::text AS s FROM repayments WHERE order_id = $1", [order.data.id]);
  assert.equal(applied?.s, String(row?.principal_cents));
});

test("下单后改价不回写协议价，缺协议价不回退到标价", async () => {
  await ctxPromise;
  const { actor, skuId, unitId, pool } = await stocked("协议价菠菜");
  const order = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "协议", idempotencyKey: "agree-1", payment: { method: "term", termDays: 9, capitalCostAnnualPercent: "1.5", overdueAnnualPercent: "1.50", agreementPriceCents: 8000 } });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  assert.notEqual(order.data.platform_price_cents, 8000);
  const { updateCommission } = await import("../lib/domain");
  assert.equal((await updateCommission(actor, null, 900)).ok, true);
  const still = await one<{ agreement_price_cents: number; principal_cents: number; platform_price_cents: number; capital: string }>(pool, "SELECT agreement_price_cents, principal_cents, platform_price_cents, capital_cost_annual_percent::text AS capital FROM orders WHERE id = $1", [order.data.id]);
  assert.equal(still?.agreement_price_cents, 8000);
  assert.equal(still?.principal_cents, 8000);
  assert.equal(still?.capital, "1.50");
  await pool.query("UPDATE orders SET capital_cost_annual_percent = NULL, overdue_annual_percent = NULL, capital_cost_annual_bps = 500.25, overdue_annual_bps = 1.00 WHERE id = $1", [order.data.id]);
  const legacy = await explainInterest(actor, order.data.id);
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  const legacyFacts = legacy.data.facts as { capitalCostAnnualPercent: string | null; legacyCapitalCostAnnualBps: string | null };
  assert.equal(legacyFacts.capitalCostAnnualPercent, null);
  assert.equal(legacyFacts.legacyCapitalCostAnnualBps, "500.25");
  assert.equal((legacy.data.reasons as string[]).includes("LEGACY_BASIS_POINT_NOT_MIGRATED"), true);
  await pool.query("UPDATE orders SET agreement_price_cents = NULL, agreement_price_source = NULL, principal_cents = platform_price_cents WHERE id = $1", [order.data.id]);
  const blocked = await postRepayment(actor, order.data.id, { amountCents: 1, paidOn: "2026-11-17", idempotencyKey: "agree-missing" });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.code, "AGREEMENT_PRICE_MISSING");
  const interest = await explainInterest(actor, order.data.id);
  assert.equal(interest.ok, true);
  if (!interest.ok) return;
  assert.equal(interest.data.officialInterestCents, null);
  assert.equal((interest.data.reasons as string[]).includes("AGREEMENT_PRICE_MISSING"), true);
  assert.equal((interest.data.facts as { principalCents: number | null }).principalCents, null);
  const untouched = await one<{ platform_price_cents: number }>(pool, "SELECT platform_price_cents FROM orders WHERE id = $1", [order.data.id]);
  assert.equal(untouched?.platform_price_cents, order.data.platform_price_cents);
});

test("单利按 365 折算，计息时只做一次四舍五入到分", () => {
  const exact = simpleInterestProbe(36_500, "10.00", 365);
  assert.equal(exact?.enabledAsOfficial, false);
  assert.equal(exact?.exactCents, 3_650);
  assert.equal(exact?.halfUpFen, 3_650);
  assert.equal(exact?.rounding, "half_up_to_fen");
  const uneven = simpleInterestProbe(36_500, "5.25", 365);
  assert.equal(uneven?.exactCents, null);
  assert.equal(uneven?.halfUpFen, 1_916);
  assert.equal(uneven?.enabledAsOfficial, false);
  assert.equal(percentToBasisPoints("5.25"), "525.00");
  assert.equal(percentToBasisPoints("0.01"), "1.00");
  assert.equal(halfUpYuanToFen(BigInt(0), BigInt(1)), BigInt(0));
  assert.equal(halfUpYuanToFen(BigInt(1), BigInt(100)), BigInt(1));
  assert.equal(halfUpYuanToFen(BigInt(16), BigInt(1000)), BigInt(2));
  assert.equal(halfUpYuanToFen(BigInt(15), BigInt(1000)), BigInt(2));
  assert.equal(halfUpYuanToFen(BigInt(14), BigInt(1000)), BigInt(1));
  assert.equal(halfUpYuanToFen(BigInt(5), BigInt(1000)), BigInt(1));
  assert.equal(halfUpYuanToFen(BigInt(4), BigInt(1000)), BigInt(0));
  const scale = BigInt(10) ** BigInt(18);
  assert.equal(halfUpYuanToFen(BigInt(16) * scale, BigInt(1000) * scale), BigInt(2));
  assert.equal(halfUpYuanToFen(BigInt(-16), BigInt(1000)), null);
});

test("发货当天是限期第 1 天，付款当天不计息但不改到期日", async () => {
  assert.deepEqual(termWindow("2026-03-15", 1), { shipDate: "2026-03-15", termDays: 1, termEnd: "2026-03-15", overdueStart: "2026-03-16" });
  assert.deepEqual(termWindow("2026-01-31", 2), { shipDate: "2026-01-31", termDays: 2, termEnd: "2026-02-01", overdueStart: "2026-02-02" });
  assert.deepEqual(termWindow("2026-12-31", 2), { shipDate: "2026-12-31", termDays: 2, termEnd: "2027-01-01", overdueStart: "2027-01-02" });
  assert.equal(termWindow("2024-02-28", 2)?.termEnd, "2024-02-29");
  assert.equal(termWindow("2024-02-29", 1)?.overdueStart, "2024-03-01");
  assert.equal(termWindow("2025-02-28", 2)?.termEnd, "2025-03-01");
  await ctxPromise;
  const pool = (await import("../lib/db")).getPool();
  const utcBoundary = await shanghaiDate(pool, "2026-11-16T16:30:00Z");
  assert.equal(utcBoundary, "2026-11-17");
  assert.equal(termWindow(utcBoundary, 1)?.termEnd, "2026-11-17");
  assert.equal(termWindow(utcBoundary, 1)?.overdueStart, "2026-11-18");
  assert.equal(termWindow(await shanghaiDate(pool, "2026-11-16T15:30:00Z"), 3)?.termEnd, "2026-11-18");
  const onTermEnd = termWindow("2026-03-15", 10);
  assert.equal(onTermEnd?.termEnd, "2026-03-24");
  assert.equal(onTermEnd?.overdueStart, "2026-03-25");
  const { actor, skuId, unitId } = await stocked("首日限期");
  const order = await placeOrder(actor, { skuId, unitId, qty: 1, buyerLabel: "首日", idempotencyKey: "day-one", payment: { method: "term", termDays: 10, capitalCostAnnualPercent: "5.25", overdueAnnualPercent: "8.00", agreementPriceCents: 5000 } });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  assert.equal((await confirmOutbound(actor, order.data.id, { qty: 1, idempotencyKey: "day-one-ship" })).ok, true);
  await pool.query("UPDATE shipment_batches SET ship_date = '2026-03-15' WHERE order_id = $1", [order.data.id]);
  const paidOnEnd = await postRepayment(actor, order.data.id, { amountCents: 1, paidOn: "2026-03-24", idempotencyKey: "pay-term-end" });
  const paidOnNext = await postRepayment(actor, order.data.id, { amountCents: 1, paidOn: "2026-03-25", idempotencyKey: "pay-overdue-start" });
  assert.equal(paidOnEnd.ok && paidOnNext.ok, true);
  const interest = await explainInterest(actor, order.data.id);
  assert.equal(interest.ok, true);
  if (!interest.ok) return;
  assert.equal(interest.data.officialInterestCents, null);
  const batch = (interest.data.facts as { batches: Array<{ termEnd: string; overdueStart: string }> }).batches[0];
  assert.equal(batch?.termEnd, "2026-03-24");
  assert.equal(batch?.overdueStart, "2026-03-25");
});

test("并发登记付款只保留一笔，出库中途失败不留批次", async () => {
  await ctxPromise;
  const { actor, skuId, unitId, pool } = await stocked("并发登记");
  const order = await placeOrder(actor, { skuId, unitId, qty: 4, buyerLabel: "并发登记", idempotencyKey: "reg-race" });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  const dbUrl = process.env.DATABASE_URL!;
  const results = await Promise.all([
    runRegister(dbUrl, order.data.id, 1111),
    runRegister(dbUrl, order.data.id, 2222),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok && item.code === "PAYMENT_ALREADY_SET").length, 1);
  const saved = await one<{ agreement_price_cents: number; audits: string }>(pool, "SELECT agreement_price_cents, (SELECT COUNT(*)::text FROM payment_audit a WHERE a.order_id = orders.id AND a.action = 'register_terms') AS audits FROM orders WHERE id = $1", [order.data.id]);
  assert.equal(saved?.agreement_price_cents === 1111 || saved?.agreement_price_cents === 2222, true);
  assert.equal(saved?.audits, "1");
  const before = await one<{ on_hand_base: number }>(pool, "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [skuId]);
  const env = process.env as Record<string, string | undefined>;
  env.OUTBOUND_FAIL_AFTER_BATCH = order.data.id;
  await assert.rejects(() => confirmOutbound(actor, order.data.id, { qty: 1, idempotencyKey: "abort-ship" }));
  delete env.OUTBOUND_FAIL_AFTER_BATCH;
  const after = await one<{ on_hand_base: number; batches: string; ledgers: string }>(pool, "SELECT i.on_hand_base, (SELECT COUNT(*)::text FROM shipment_batches b WHERE b.order_id = $2) AS batches, (SELECT COUNT(*)::text FROM ledger l WHERE l.ref_doc_id LIKE 'out_%' AND l.sku_id = $1 AND l.movement_type = 'sale_out') AS ledgers FROM inventory i WHERE i.sku_id = $1", [skuId, order.data.id]);
  assert.equal(after?.on_hand_base, before?.on_hand_base);
  assert.equal(after?.batches, "0");
  assert.equal(after?.ledgers, "0");
  const shipped = await confirmOutbound(actor, order.data.id, { qty: 1, idempotencyKey: "once-ship" });
  const replay = await confirmOutbound(actor, order.data.id, { qty: 1, idempotencyKey: "once-ship" });
  assert.equal(shipped.ok && replay.ok, true);
  if (!shipped.ok || !replay.ok) return;
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.onHandBase, shipped.data.onHandBase);
  const batches = await one<{ c: string }>(pool, "SELECT COUNT(*)::text AS c FROM shipment_batches WHERE order_id = $1", [order.data.id]);
  assert.equal(batches?.c, "1");
});

function runRegister(dbUrl: string, orderId: string, agreementPriceCents: number): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./payment-register-worker.ts", import.meta.url), { workerData: { dbUrl, orderId, agreementPriceCents } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

function runPay(dbUrl: string, orderId: string, key: string, amountCents: number): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./payments-worker.ts", import.meta.url), { workerData: { dbUrl, orderId, key, amountCents } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}
