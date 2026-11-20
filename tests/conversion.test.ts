import assert from "node:assert/strict";
import { after, test } from "node:test";
import { one } from "../lib/db";
import { createProduct, getActorByPhone, receiveInbound, updateUnitRatio } from "../lib/domain";
import { PHONES, tempDb } from "./helpers";
import { createSku } from "../lib/domain";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

test("商品换算互相隔离，改比例不重算历史入库快照", async () => {
  await ctxPromise;
  const actorA = await getActorByPhone(PHONES.merchantA);
  const actorB = await getActorByPhone(PHONES.merchantB);
  if (!actorA || !actorB) throw new Error("缺少商家");
  const apple = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM products WHERE name = '云南苹果'");
  const rice = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM products WHERE name = '优质大米'");
  const appleBox = await one<{ to_base_numerator: number }>((await import("../lib/db")).getPool(), "SELECT to_base_numerator FROM product_units WHERE product_id = $1 AND unit_label = '箱'", [apple?.id]);
  const riceBox = await one<{ to_base_numerator: number; is_base: boolean }>((await import("../lib/db")).getPool(), "SELECT to_base_numerator, is_base FROM product_units WHERE product_id = $1 AND unit_label = '箱'", [rice?.id]);
  assert.equal(appleBox?.to_base_numerator, 200);
  assert.equal(riceBox?.is_base, true);
  assert.notEqual(appleBox?.to_base_numerator, riceBox?.to_base_numerator);
  const riceSku = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM skus WHERE product_id = $1", [rice?.id]);
  const appleUnit = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM product_units WHERE product_id = $1 AND unit_label = '箱'", [apple?.id]);
  const before = await one<{ on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [riceSku?.id]);
  const borrowed = await receiveInbound(actorB, { skuId: riceSku!.id, unitId: appleUnit!.id, qty: 1 });
  assert.equal(borrowed.ok, false);
  if (borrowed.ok) return;
  assert.equal(borrowed.code, "UNIT_PRODUCT_MISMATCH");
  const after = await one<{ on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [riceSku?.id]);
  assert.equal(after?.on_hand_base, before?.on_hand_base);
  const inbound = await one<{ qty_base: number; to_base_numerator: number }>((await import("../lib/db")).getPool(), "SELECT qty_base, to_base_numerator FROM inbound_docs WHERE sku_id = (SELECT id FROM skus WHERE product_id = $1 AND spec_name = '一级果')", [apple?.id]);
  assert.equal(inbound?.qty_base, 800);
  assert.equal(inbound?.to_base_numerator, 10);
  const jin = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM product_units WHERE product_id = $1 AND unit_label = '斤'", [apple?.id]);
  const updated = await updateUnitRatio(actorA, jin!.id, 30, 1);
  assert.equal(updated.ok, true);
  const snapshot = await one<{ qty_base: number; to_base_numerator: number }>((await import("../lib/db")).getPool(), "SELECT qty_base, to_base_numerator FROM inbound_docs WHERE sku_id = (SELECT id FROM skus WHERE product_id = $1 AND spec_name = '一级果')", [apple?.id]);
  assert.equal(snapshot?.qty_base, 800);
  assert.equal(snapshot?.to_base_numerator, 10);
  const bad = await createProduct(actorA, { name: "示例坏比例", baseUnitLabel: "斤", units: [{ label: "两", numerator: 0, denominator: 1 }] });
  assert.equal(bad.ok, false);
});

test("非法比例在独立商品上也会被拒绝", async () => {
  await ctxPromise;
  const actor = await getActorByPhone(PHONES.merchantA);
  if (!actor) throw new Error("缺少商家");
  const product = await createProduct(actor, { name: "示例独立商品", baseUnitLabel: "件" });
  assert.equal(product.ok, true);
  if (!product.ok) return;
  const sku = await createSku(actor, { productId: product.data.productId, specName: "默认" });
  assert.equal(sku.ok, true);
});
