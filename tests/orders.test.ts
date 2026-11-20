import assert from "node:assert/strict";
import { after, test } from "node:test";
import { one } from "../lib/db";
import { confirmOutbound, getActorByPhone, placeOrder } from "../lib/domain";
import { handleCancelOrder } from "../lib/http/handlers";
import { authed, readJson, tempDb, PHONES } from "./helpers";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

test("重复下单不重复预占，重复出库不重复扣减，未支持动作被拒绝", async () => {
  await ctxPromise;
  const actor = await getActorByPhone(PHONES.merchantA);
  if (!actor) throw new Error("缺少商家");
  const sku = await one<{ id: string; product_id: string }>((await import("../lib/db")).getPool(), "SELECT id, product_id FROM skus WHERE spec_name = '一级果'");
  const unit = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM product_units WHERE product_id = $1 AND is_base", [sku?.product_id]);
  const first = await placeOrder(actor, { skuId: sku!.id, unitId: unit!.id, qty: 10, buyerLabel: "示例采购方", idempotencyKey: "same-key" });
  const second = await placeOrder(actor, { skuId: sku!.id, unitId: unit!.id, qty: 10, buyerLabel: "示例采购方", idempotencyKey: "same-key" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.data.id, second.data.id);
  const reserved = await one<{ reserved_base: number; on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT reserved_base, on_hand_base FROM inventory WHERE sku_id = $1", [sku?.id]);
  assert.equal(reserved?.reserved_base, 10);
  assert.equal(reserved?.on_hand_base, 800);
  const out1 = await confirmOutbound(actor, first.data.id, { qty: 10, idempotencyKey: "full-1" });
  const out2 = await confirmOutbound(actor, first.data.id, { qty: 10, idempotencyKey: "full-1" });
  assert.equal(out1.ok && out2.ok, true);
  if (!out1.ok || !out2.ok) return;
  assert.equal(out2.data.replayed, true);
  assert.equal(out1.data.docId, out2.data.docId);
  const after = await one<{ on_hand_base: number; reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [sku?.id]);
  assert.equal(after?.on_hand_base, 790);
  assert.equal(after?.reserved_base, 0);
  const cancel = await readJson(await handleCancelOrder(authed("/api/orders/x/cancel", "nq_session=none"), first.data.id));
  assert.equal(cancel.status, 401);
  const unchanged = await one<{ reserved_base: number }>((await import("../lib/db")).getPool(), "SELECT reserved_base FROM inventory WHERE sku_id = $1", [sku?.id]);
  assert.equal(unchanged?.reserved_base, 0);
});
