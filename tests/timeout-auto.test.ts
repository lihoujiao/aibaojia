import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { one } from "../lib/db";
import { confirmOutbound, createProduct, createQuote, createSku, getActorByPhone, placeOrder, receiveInbound, releaseReservation, setTimeoutConfig } from "../lib/domain";
import { judgeDueTimeouts } from "../lib/timeout-judge";
import { PHONES, tempDb } from "./helpers";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

test("未配置不自动超时；显式配置只快照新订单，到期才判定并只释放剩余", async () => {
  await ctxPromise;
  const actor = await getActorByPhone(PHONES.merchantA);
  const other = await getActorByPhone(PHONES.merchantB);
  if (!actor || !other) throw new Error("缺少示例商家");
  const pool = (await import("../lib/db")).getPool();
  const beforeOther = await one<{ reserved_base: number }>(pool, "SELECT COALESCE(SUM(reserved_base),0)::int AS reserved_base FROM inventory i JOIN skus s ON s.id = i.sku_id WHERE s.merchant_id = 'merchant-b'");
  const product = await createProduct(actor, { name: "超时青菜", baseUnitLabel: "斤" });
  assert.equal(product.ok, true);
  if (!product.ok) return;
  const sku = await createSku(actor, { productId: product.data.productId, specName: "散装" });
  assert.equal(sku.ok, true);
  if (!sku.ok) return;
  const unit = await one<{ id: string }>(pool, "SELECT id FROM product_units WHERE product_id = $1 AND is_base", [product.data.productId]);
  const inbound = await receiveInbound(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 30 });
  assert.equal(inbound.ok, true);
  const quote = await createQuote(actor, {
    skuId: sku.data.id,
    floorPriceCents: 120,
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal(quote.ok, true);

  const bare = await placeOrder(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 4, buyerLabel: "未配置采购方", idempotencyKey: "bare-order" });
  assert.equal(bare.ok, true);
  if (!bare.ok) return;
  const bareRow = await one<{ timeout_at: Date | null; timeout_duration_value: number | null }>(pool, "SELECT timeout_at, timeout_duration_value FROM orders WHERE id = $1", [bare.data.id]);
  assert.equal(bareRow?.timeout_at, null);
  assert.equal(bareRow?.timeout_duration_value, null);

  const saved = await setTimeoutConfig(actor, null, 2, "hour");
  assert.equal(saved.ok, true);
  const stillBare = await one<{ timeout_at: Date | null }>(pool, "SELECT timeout_at FROM orders WHERE id = $1", [bare.data.id]);
  assert.equal(stillBare?.timeout_at, null);

  const snap = await placeOrder(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 10, buyerLabel: "快照采购方", idempotencyKey: "snap-order" });
  assert.equal(snap.ok, true);
  if (!snap.ok) return;
  const snapRow = await one<{ timeout_at: Date; timeout_duration_value: number; timeout_duration_unit: string; seconds: string }>(
    pool,
    "SELECT timeout_at, timeout_duration_value, timeout_duration_unit, EXTRACT(EPOCH FROM (timeout_at - created_at))::text AS seconds FROM orders WHERE id = $1",
    [snap.data.id],
  );
  assert.equal(snapRow?.timeout_duration_value, 2);
  assert.equal(snapRow?.timeout_duration_unit, "hour");
  assert.ok(Math.abs(Number(snapRow?.seconds) - 7200) < 5);

  const changed = await setTimeoutConfig(actor, null, 5, "minute");
  assert.equal(changed.ok, true);
  const snapAfterChange = await one<{ timeout_duration_value: number; timeout_duration_unit: string; timeout_at: Date }>(pool, "SELECT timeout_duration_value, timeout_duration_unit, timeout_at FROM orders WHERE id = $1", [snap.data.id]);
  assert.equal(snapAfterChange?.timeout_duration_value, 2);
  assert.equal(snapAfterChange?.timeout_duration_unit, "hour");
  assert.equal(new Date(snapAfterChange!.timeout_at).toISOString(), new Date(snapRow!.timeout_at).toISOString());

  const notDue = await judgeDueTimeouts(new Date(new Date(snapRow!.timeout_at).getTime() - 1000));
  assert.equal(notDue.skippedLock, false);
  assert.equal(notDue.judged.length, 0);
  const stillReserved = await one<{ status: string; reserved_base: number }>(pool, "SELECT o.status, i.reserved_base FROM orders o JOIN inventory i ON i.sku_id = o.sku_id WHERE o.id = $1", [snap.data.id]);
  assert.equal(stillReserved?.status, "reserved");
  assert.equal(stillReserved?.reserved_base, 14);

  const shipped = await confirmOutbound(actor, snap.data.id, { qty: 3, idempotencyKey: "snap-ship-3" });
  assert.equal(shipped.ok, true);
  const due = await judgeDueTimeouts(new Date(new Date(snapRow!.timeout_at).getTime() + 1000));
  assert.equal(due.judged.length, 1);
  assert.equal(due.judged[0]?.orderId, snap.data.id);
  assert.equal(due.judged[0]?.releasedBase, 7);
  const judged = await one<{ status: string; source: string; on_hand_base: number; reserved_base: number; events: string; note: string }>(
    pool,
    `SELECT o.status, o.timeout_judge_source AS source, i.on_hand_base, i.reserved_base,
            (SELECT COUNT(*)::text FROM timeout_judge_events e WHERE e.order_id = o.id) AS events,
            (SELECT note FROM ledger l WHERE l.ref_doc_id = o.id AND l.movement_type = 'reserve_release' ORDER BY l.created_at DESC LIMIT 1) AS note
     FROM orders o JOIN inventory i ON i.sku_id = o.sku_id WHERE o.id = $1`,
    [snap.data.id],
  );
  assert.equal(judged?.status, "timed_out");
  assert.equal(judged?.source, "automatic");
  assert.equal(judged?.events, "1");
  assert.match(judged?.note ?? "", /到期自动判定/);
  assert.equal(judged?.on_hand_base, 27);
  assert.equal(judged?.reserved_base, 4);
  const bareStill = await one<{ status: string; timeout_at: Date | null }>(pool, "SELECT status, timeout_at FROM orders WHERE id = $1", [bare.data.id]);
  assert.equal(bareStill?.status, "reserved");
  assert.equal(bareStill?.timeout_at, null);

  const again = await judgeDueTimeouts(new Date(new Date(snapRow!.timeout_at).getTime() + 2000));
  assert.equal(again.judged.length, 0);
  const events = await one<{ c: string }>(pool, "SELECT COUNT(*)::text AS c FROM timeout_judge_events WHERE order_id = $1", [snap.data.id]);
  assert.equal(events?.c, "1");

  const later = await placeOrder(actor, { skuId: sku.data.id, unitId: unit!.id, qty: 1, buyerLabel: "新配置采购方", idempotencyKey: "later-order" });
  assert.equal(later.ok, true);
  if (!later.ok) return;
  const laterRow = await one<{ timeout_duration_value: number; timeout_duration_unit: string }>(pool, "SELECT timeout_duration_value, timeout_duration_unit FROM orders WHERE id = $1", [later.data.id]);
  assert.equal(laterRow?.timeout_duration_value, 5);
  assert.equal(laterRow?.timeout_duration_unit, "minute");
  const eventRelease = await releaseReservation(actor, later.data.id, "timed_out");
  assert.equal(eventRelease.ok, true);
  const eventRow = await one<{ source: string }>(pool, "SELECT timeout_judge_source AS source FROM orders WHERE id = $1", [later.data.id]);
  assert.equal(eventRow?.source, "event");

  const afterOther = await one<{ reserved_base: number }>(pool, "SELECT COALESCE(SUM(reserved_base),0)::int AS reserved_base FROM inventory i JOIN skus s ON s.id = i.sku_id WHERE s.merchant_id = 'merchant-b'");
  assert.equal(afterOther?.reserved_base, beforeOther?.reserved_base);

  const productRace = await createProduct(actor, { name: "并发萝卜", baseUnitLabel: "个" });
  assert.equal(productRace.ok, true);
  if (!productRace.ok) return;
  const skuRace = await createSku(actor, { productId: productRace.data.productId, specName: "大" });
  assert.equal(skuRace.ok, true);
  if (!skuRace.ok) return;
  const unitRace = await one<{ id: string }>(pool, "SELECT id FROM product_units WHERE product_id = $1 AND is_base", [productRace.data.productId]);
  assert.equal((await receiveInbound(actor, { skuId: skuRace.data.id, unitId: unitRace!.id, qty: 20 })).ok, true);
  assert.equal((await createQuote(actor, {
    skuId: skuRace.data.id,
    floorPriceCents: 80,
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
  })).ok, true);
  const raceOrder = await placeOrder(actor, { skuId: skuRace.data.id, unitId: unitRace!.id, qty: 6, buyerLabel: "并发采购方", idempotencyKey: "race-timeout" });
  assert.equal(raceOrder.ok, true);
  if (!raceOrder.ok) return;
  const results = await Promise.all([
    runRace(process.env.DATABASE_URL!, raceOrder.data.id, "ship"),
    runRace(process.env.DATABASE_URL!, raceOrder.data.id, "judge"),
  ]);
  assert.equal(results.some((item) => item.ok), true);
  const raceStock = await one<{ on_hand_base: number; reserved_base: number; status: string; qty_fulfilled_base: number }>(
    pool,
    "SELECT i.on_hand_base, i.reserved_base, o.status, o.qty_fulfilled_base FROM inventory i JOIN orders o ON o.sku_id = i.sku_id WHERE o.id = $1",
    [raceOrder.data.id],
  );
  assert.ok(raceStock);
  assert.equal(raceStock.reserved_base, 0);
  if (raceStock.status === "fulfilled") {
    assert.equal(raceStock.qty_fulfilled_base, 6);
    assert.equal(raceStock.on_hand_base, 14);
  }
  if (raceStock.status === "timed_out") {
    assert.equal(raceStock.on_hand_base, 20);
    assert.equal(raceStock.qty_fulfilled_base, 0);
  }
  assert.equal(raceStock.status === "fulfilled" || raceStock.status === "timed_out", true);
});

function runRace(dbUrl: string, orderId: string, action: "ship" | "judge"): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./timeout-auto-worker.ts", import.meta.url), { workerData: { dbUrl, orderId, action } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}
