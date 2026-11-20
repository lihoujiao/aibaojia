import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { one } from "../lib/db";
import { createProduct, createQuote, createSku, getActorByPhone, placeOrder, receiveInbound, setTimeoutConfig } from "../lib/domain";
import { TIMEOUT_SCAN_INTERVAL_MS, startTimeoutJudgeLoop, stopTimeoutJudgeLoop, timeoutJudgeSettled } from "../lib/timeout-judge";
import { PHONES, tempDb } from "./helpers";

const ctxPromise = tempDb();
after(async () => {
  stopTimeoutJudgeLoop();
  await timeoutJudgeSettled();
  await (await ctxPromise).cleanup();
});

test("15 秒扫描周期会在测试不直接调用判定函数时释放已到期快照，且不是业务超时时长", async () => {
  await ctxPromise;
  assert.equal(TIMEOUT_SCAN_INTERVAL_MS, 15_000);
  const actor = await getActorByPhone(PHONES.merchantA);
  if (!actor) throw new Error("缺少示例商家");
  const pool = (await import("../lib/db")).getPool();
  const saved = await setTimeoutConfig(actor, null, 1, "hour");
  assert.equal(saved.ok, true);
  const product = await createProduct(actor, { name: "定时菠菜", baseUnitLabel: "把" });
  assert.equal(product.ok, true);
  if (!product.ok) return;
  const sku = await createSku(actor, { productId: product.data.productId, specName: "鲜" });
  assert.equal(sku.ok, true);
  if (!sku.ok) return;
  const unit = await one<{ id: string }>(pool, "SELECT id FROM product_units WHERE product_id = $1 AND is_base", [product.data.productId]);
  assert.equal((await receiveInbound(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 8 })).ok, true);
  assert.equal((await createQuote(actor, {
    skuId: sku.data.id,
    floorPriceCents: 50,
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
  })).ok, true);

  startTimeoutJudgeLoop();
  await timeoutJudgeSettled();
  const order = await placeOrder(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 5, buyerLabel: "定时采购方", idempotencyKey: "timer-order" });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  const snap = await one<{ value: number; unit: string; status: string }>(pool, "SELECT timeout_duration_value AS value, timeout_duration_unit AS unit, status FROM orders WHERE id = $1", [order.data.id]);
  assert.equal(snap?.value, 1);
  assert.equal(snap?.unit, "hour");
  assert.equal(snap?.status, "reserved");
  await pool.query("UPDATE orders SET timeout_at = NOW() - interval '1 second' WHERE id = $1", [order.data.id]);
  const started = Date.now();
  await delay(1_000);
  const early = await one<{ status: string; reserved_base: number }>(pool, "SELECT o.status, i.reserved_base FROM orders o JOIN inventory i ON i.sku_id = o.sku_id WHERE o.id = $1", [order.data.id]);
  assert.equal(early?.status, "reserved");
  assert.equal(early?.reserved_base, 5);

  let status = "reserved";
  while (Date.now() - started < 22_000) {
    const row = await one<{ status: string }>(pool, "SELECT status FROM orders WHERE id = $1", [order.data.id]);
    status = row?.status ?? "";
    if (status === "timed_out") break;
    await delay(500);
  }
  const elapsed = Date.now() - started;
  assert.equal(status, "timed_out");
  assert.ok(elapsed >= 1_000 && elapsed < 22_000, `扫描等待 ${elapsed}ms`);
  const judged = await one<{ source: string; on_hand_base: number; reserved_base: number; events: string; value: number }>(
    pool,
    `SELECT o.timeout_judge_source AS source, o.timeout_duration_value AS value, i.on_hand_base, i.reserved_base,
            (SELECT COUNT(*)::text FROM timeout_judge_events e WHERE e.order_id = o.id) AS events
     FROM orders o JOIN inventory i ON i.sku_id = o.sku_id WHERE o.id = $1`,
    [order.data.id],
  );
  assert.equal(judged?.source, "automatic");
  assert.equal(judged?.value, 1);
  assert.equal(judged?.on_hand_base, 8);
  assert.equal(judged?.reserved_base, 0);
  assert.equal(judged?.events, "1");
  await delay(2_000);
  const again = await one<{ events: string }>(pool, "SELECT COUNT(*)::text AS events FROM timeout_judge_events WHERE order_id = $1", [order.data.id]);
  assert.equal(again?.events, "1");

  stopTimeoutJudgeLoop();
  await timeoutJudgeSettled();
  const restartOrder = await placeOrder(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 2, buyerLabel: "重启采购方", idempotencyKey: "restart-order" });
  assert.equal(restartOrder.ok, true);
  if (!restartOrder.ok) return;
  await pool.query("UPDATE orders SET timeout_at = NOW() - interval '1 second' WHERE id = $1", [restartOrder.data.id]);
  await delay(1_500);
  const whileStopped = await one<{ status: string }>(pool, "SELECT status FROM orders WHERE id = $1", [restartOrder.data.id]);
  assert.equal(whileStopped?.status, "reserved");
  startTimeoutJudgeLoop();
  await timeoutJudgeSettled();
  const restarted = await one<{ status: string; source: string; reserved_base: number; events: string }>(
    pool,
    `SELECT o.status, o.timeout_judge_source AS source, i.reserved_base,
            (SELECT COUNT(*)::text FROM timeout_judge_events e WHERE e.order_id = o.id) AS events
     FROM orders o JOIN inventory i ON i.sku_id = o.sku_id WHERE o.id = $1`,
    [restartOrder.data.id],
  );
  assert.equal(restarted?.status, "timed_out");
  assert.equal(restarted?.source, "automatic");
  assert.equal(restarted?.reserved_base, 0);
  assert.equal(restarted?.events, "1");
  assert.equal(restarted?.reserved_base === 0 && judged?.on_hand_base === 8, true);
});
