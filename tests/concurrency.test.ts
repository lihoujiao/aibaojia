import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { one } from "../lib/db";
import { createProduct, createQuote, createSku, getActorByPhone, receiveInbound } from "../lib/domain";
import { PHONES, tempDb } from "./helpers";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

test("可用库存只剩 1 时，两笔并发下单只能预占成功一笔", async () => {
  await ctxPromise;
  const actor = await getActorByPhone(PHONES.merchantA);
  assert.ok(actor);
  const product = await createProduct(actor, { name: "示例并发果", baseUnitLabel: "件" });
  assert.equal(product.ok, true);
  if (!product.ok) return;
  const sku = await createSku(actor, { productId: product.data.productId, specName: "单件" });
  assert.equal(sku.ok, true);
  if (!sku.ok) return;
  await receiveInbound(actor, { skuId: sku.data.id, unitId: sku.data.units[0].id, qty: 1 });
  await createQuote(actor, { skuId: sku.data.id, floorPriceCents: 500, validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString() });
  const dbUrl = process.env.DATABASE_URL!;
  const results = await Promise.all([0, 1].map((index) => runWorker(dbUrl, sku.data.id, sku.data.units[0].id, `c-${index}`)));
  assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((item) => item.code === "INSUFFICIENT_STOCK").length, 1, JSON.stringify(results));
  const stock = await one<{ on_hand_base: number; reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [sku.data.id]);
  assert.equal(stock?.on_hand_base, 1);
  assert.equal(stock?.reserved_base, 1);
});

function runWorker(dbUrl: string, skuId: string, unitId: string, key: string): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./concurrency-worker.ts", import.meta.url), { workerData: { dbUrl, skuId, unitId, key } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}
