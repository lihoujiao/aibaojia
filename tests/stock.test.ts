import assert from "node:assert/strict";
import { after, test } from "node:test";
import { one } from "../lib/db";
import { createProduct, createQuote, createSku, getActorByPhone, receiveInbound } from "../lib/domain";
import { handleCreateOrder } from "../lib/http/handlers";
import { authed, login, PHONES, readJson, tempDb } from "./helpers";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

test("可用库存不足时下单被拒绝，现货和预占不变", async () => {
  await ctxPromise;
  const actor = await getActorByPhone(PHONES.merchantA);
  assert.ok(actor);
  const product = await createProduct(actor, { name: "示例青菜", baseUnitLabel: "斤" });
  assert.equal(product.ok, true);
  if (!product.ok) return;
  const sku = await createSku(actor, { productId: product.data.productId, specName: "散装" });
  assert.equal(sku.ok, true);
  if (!sku.ok) return;
  const unit = sku.data.units[0];
  await receiveInbound(actor, { skuId: sku.data.id, unitId: unit.id, qty: 2 });
  await createQuote(actor, { skuId: sku.data.id, floorPriceCents: 100, validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString() });
  const cookie = await login(PHONES.merchantA);
  const before = await one<{ on_hand_base: number; reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [sku.data.id]);
  const { status, body } = await readJson(await handleCreateOrder(authed("/api/orders", cookie, { method: "POST", body: { skuId: sku.data.id, unitId: unit.id, qty: 3, buyerLabel: "示例采购方", idempotencyKey: "stock-1" } })));
  assert.equal(status, 409);
  assert.equal(body.code, "INSUFFICIENT_STOCK");
  const after = await one<{ on_hand_base: number; reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [sku.data.id]);
  assert.deepEqual(after, before);
});

test("零库存规格不能下单", async () => {
  await ctxPromise;
  const actor = await getActorByPhone(PHONES.merchantA);
  assert.ok(actor);
  const product = await createProduct(actor, { name: "示例空库存", baseUnitLabel: "件" });
  assert.equal(product.ok, true);
  if (!product.ok) return;
  const sku = await createSku(actor, { productId: product.data.productId, specName: "件装" });
  assert.equal(sku.ok, true);
  if (!sku.ok) return;
  await createQuote(actor, { skuId: sku.data.id, floorPriceCents: 100, validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString() });
  const cookie = await login(PHONES.merchantA);
  const { status, body } = await readJson(await handleCreateOrder(authed("/api/orders", cookie, { method: "POST", body: { skuId: sku.data.id, unitId: sku.data.units[0].id, qty: 1, buyerLabel: "示例采购方", idempotencyKey: "stock-0" } })));
  assert.equal(status, 409);
  assert.equal(body.code, "INSUFFICIENT_STOCK");
  const stock = await one<{ on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [sku.data.id]);
  assert.equal(stock?.on_hand_base, 0);
});
