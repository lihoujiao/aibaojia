import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { one } from "../lib/db";
import { confirmOutbound, getActorByPhone, placeOrder, releaseReservation } from "../lib/domain";
import { handleCancelOrder, handlePutTimeoutConfig, handleTimeoutEvent } from "../lib/http/handlers";
import { authed, login, PHONES, readJson, tempDb } from "./helpers";
import { convertToBase } from "../lib/convert";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

async function appleOrder(key: string, qty = 10) {
  const actor = await getActorByPhone(PHONES.merchantA);
  if (!actor) throw new Error("缺少商家甲");
  const sku = await one<{ id: string; product_id: string }>((await import("../lib/db")).getPool(), "SELECT id, product_id FROM skus WHERE spec_name = '一级果'");
  const unit = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM product_units WHERE product_id = $1 AND is_base", [sku?.product_id]);
  const order = await placeOrder(actor, { skuId: sku!.id, unitId: unit!.id, qty, buyerLabel: "示例采购方", idempotencyKey: key });
  if (!order.ok) throw new Error(order.message);
  return { actor, skuId: sku!.id, order };
}

test("部分出库只减已出数量，重放不双扣，累计不能超过订单", async () => {
  await ctxPromise;
  const { actor, skuId, order } = await appleOrder("part-order", 10);
  const before = await one<{ on_hand_base: number; reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [skuId]);
  const first = await confirmOutbound(actor, order.data.id, { qty: 4, idempotencyKey: "ship-4" });
  const replay = await confirmOutbound(actor, order.data.id, { qty: 4, idempotencyKey: "ship-4" });
  assert.equal(first.ok && replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.docId, first.data.docId);
  const mid = await one<{ on_hand_base: number; reserved_base: number; qty_fulfilled_base: number; status: string }>((await import("../lib/db")).getPool(), "SELECT i.on_hand_base, i.reserved_base, o.qty_fulfilled_base, o.status FROM inventory i JOIN orders o ON o.sku_id = i.sku_id WHERE o.id = $1", [order.data.id]);
  assert.equal(mid?.on_hand_base, (before?.on_hand_base ?? 0) - 4);
  assert.equal(mid?.reserved_base, (before?.reserved_base ?? 0) - 4);
  assert.equal(mid?.qty_fulfilled_base, 4);
  assert.equal(mid?.status, "reserved");
  const tooMuch = await confirmOutbound(actor, order.data.id, { qty: 7, idempotencyKey: "ship-7" });
  assert.equal(tooMuch.ok, false);
  if (tooMuch.ok) return;
  assert.equal(tooMuch.code, "EXCEEDS_ORDER");
  const afterReject = await one<{ on_hand_base: number; reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [skuId]);
  assert.equal(afterReject?.on_hand_base, mid?.on_hand_base);
  assert.equal(afterReject?.reserved_base, mid?.reserved_base);
  const rest = await confirmOutbound(actor, order.data.id, { qty: 6, idempotencyKey: "ship-6" });
  assert.equal(rest.ok, true);
  const done = await one<{ on_hand_base: number; reserved_base: number; status: string }>((await import("../lib/db")).getPool(), "SELECT i.on_hand_base, i.reserved_base, o.status FROM inventory i JOIN orders o ON o.sku_id = i.sku_id WHERE o.id = $1", [order.data.id]);
  assert.equal(done?.status, "fulfilled");
  assert.equal(done?.reserved_base, (before?.reserved_base ?? 0) - 10);
  assert.equal(done?.on_hand_base, (before?.on_hand_base ?? 0) - 10);
});

test("取消和已判定超时都会立即释放未出预占，重复事件不二次释放", async () => {
  await ctxPromise;
  const cancelCase = await appleOrder("cancel-order", 5);
  const cancelled = await releaseReservation(cancelCase.actor, cancelCase.order.data.id, "cancelled");
  const cancelledAgain = await releaseReservation(cancelCase.actor, cancelCase.order.data.id, "cancelled");
  assert.equal(cancelled.ok && cancelledAgain.ok, true);
  if (!cancelled.ok || !cancelledAgain.ok) return;
  assert.equal(cancelled.data.releasedBase, 5);
  assert.equal(cancelledAgain.data.alreadyReleased, true);
  assert.equal(cancelledAgain.data.releasedBase, 0);
  const stock = await one<{ on_hand_base: number; reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [cancelCase.skuId]);
  assert.equal(stock?.reserved_base, 0);
  const timeoutCase = await appleOrder("timeout-order", 3);
  const timed = await releaseReservation(timeoutCase.actor, timeoutCase.order.data.id, "timed_out");
  const timedAgain = await releaseReservation(timeoutCase.actor, timeoutCase.order.data.id, "timed_out");
  assert.equal(timed.ok && timedAgain.ok, true);
  if (!timed.ok || !timedAgain.ok) return;
  assert.equal(timed.data.status, "timed_out");
  assert.equal(timedAgain.data.alreadyReleased, true);
});

test("部分出库后取消只释放剩余预占，越权取消被拒绝", async () => {
  await ctxPromise;
  const { actor, skuId, order } = await appleOrder("partial-cancel", 8);
  const shipped = await confirmOutbound(actor, order.data.id, { qty: 3, idempotencyKey: "pc-3" });
  assert.equal(shipped.ok, true);
  const other = await getActorByPhone(PHONES.merchantB);
  if (!other) throw new Error("缺少商家乙");
  const denied = await releaseReservation(other, order.data.id, "cancelled");
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, "FORBIDDEN");
  const cookie = await login(PHONES.merchantA);
  const cancel = await readJson(await handleCancelOrder(authed(`/api/orders/${order.data.id}/cancel`, cookie), order.data.id));
  assert.equal(cancel.status, 200);
  const row = await one<{ on_hand_base: number; reserved_base: number; status: string }>((await import("../lib/db")).getPool(), "SELECT i.on_hand_base, i.reserved_base, o.status FROM inventory i JOIN orders o ON o.sku_id = i.sku_id WHERE o.id = $1", [order.data.id]);
  assert.equal(row?.status, "cancelled");
  assert.equal(row?.reserved_base, 0);
  assert.ok((row?.on_hand_base ?? 0) > 0);
  void skuId;
});

test("取消与出库并发后库存不出现双扣", async () => {
  await ctxPromise;
  const { skuId, order } = await appleOrder("race-order", 6);
  const dbUrl = process.env.DATABASE_URL!;
  const results = await Promise.all([
    runRace(dbUrl, order.data.id, "ship"),
    runRace(dbUrl, order.data.id, "cancel"),
  ]);
  assert.equal(results.filter((item) => item.ok).length >= 1, true, JSON.stringify(results));
  const stock = await one<{ on_hand_base: number; reserved_base: number; status: string; qty_fulfilled_base: number }>((await import("../lib/db")).getPool(), "SELECT i.on_hand_base, i.reserved_base, o.status, o.qty_fulfilled_base FROM inventory i JOIN orders o ON o.sku_id = i.sku_id WHERE o.id = $1", [order.data.id]);
  assert.ok(stock);
  assert.equal(stock.on_hand_base >= 0 && stock.reserved_base >= 0, true);
  if (stock.status === "fulfilled") {
    assert.equal(stock.qty_fulfilled_base, 6);
  }
  if (stock.status === "cancelled") {
    assert.equal(stock.qty_fulfilled_base, 0);
  }
  void skuId;
});

test("四舍五入按整数除法计算，不使用浮点截断", () => {
  assert.equal(convertToBase(1, 1, 2), 1);
  assert.equal(convertToBase(1, 5, 2), 3);
  assert.equal(convertToBase(2, 1, 2), 1);
  assert.equal(convertToBase(1, 1, 3), null);
});

test("超时时长未配置时没有默认值，非法值和跨商家写入被拒绝", async () => {
  await ctxPromise;
  const cookieA = await login(PHONES.merchantA);
  const cookieB = await login(PHONES.merchantB);
  const cookiePlatform = await login(PHONES.platform);
  const empty = await readJson(await (await import("../lib/http/handlers")).handleGetTimeoutConfig(authed("/api/order-timeout", cookieA)));
  assert.equal(empty.status, 200);
  assert.equal((empty.body.data as { configured: boolean; durationValue: number | null }).configured, false);
  assert.equal((empty.body.data as { durationValue: number | null }).durationValue, null);
  const zero = await readJson(await handlePutTimeoutConfig(authed("/api/order-timeout", cookieA, { method: "PUT", body: { durationValue: 0, durationUnit: "hour" } })));
  assert.equal(zero.status, 400);
  const missingUnit = await readJson(await handlePutTimeoutConfig(authed("/api/order-timeout", cookieA, { method: "PUT", body: { durationValue: 2 } })));
  assert.equal(missingUnit.status, 400);
  const cross = await readJson(await handlePutTimeoutConfig(authed("/api/order-timeout", cookieA, { method: "PUT", body: { merchantId: "merchant-b", durationValue: 2, durationUnit: "hour" } })));
  assert.equal(cross.status, 400);
  const platform = await readJson(await handlePutTimeoutConfig(authed("/api/order-timeout", cookiePlatform, { method: "PUT", body: { durationValue: 2, durationUnit: "hour" } })));
  assert.equal(platform.status, 409);
  assert.equal(platform.body.code, "TIMEOUT_CONFIG_ROLE_UNCONFIRMED");
  const saved = await readJson(await handlePutTimeoutConfig(authed("/api/order-timeout", cookieB, { method: "PUT", body: { durationValue: 3, durationUnit: "hour" } })));
  assert.equal(saved.status, 200);
  const mine = await readJson(await (await import("../lib/http/handlers")).handleGetTimeoutConfig(authed("/api/order-timeout", cookieA)));
  assert.equal((mine.body.data as { configured: boolean }).configured, false);
  const rows = await one<{ c: string }>((await import("../lib/db")).getPool(), "SELECT COUNT(*)::text AS c FROM order_timeout_config");
  assert.equal(rows?.c, "1");
  void handleTimeoutEvent;
});

function runRace(dbUrl: string, orderId: string, action: "ship" | "cancel"): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fulfillment-worker.ts", import.meta.url), { workerData: { dbUrl, orderId, action } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}
