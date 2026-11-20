import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { one } from "../lib/db";
import { handleCreateInbound, handleCreateOrder, handleCreateQuote, handleDemos, handleGetSku, handleListQuotes, handleListSkus, handleLogin } from "../lib/http/handlers";
import { authed, login, PHONES, readJson, tempDb } from "./helpers";

let cleanup: () => Promise<void>;
let cookieA = "";
let cookieGroup = "";
let cookiePlatform = "";
let cookieCs = "";
let riceId = "";
let appleId = "";

before(async () => {
  ({ cleanup } = await tempDb());
  cookieA = await login(PHONES.merchantA);
  cookieGroup = await login(PHONES.group);
  cookiePlatform = await login(PHONES.platform);
  cookieCs = await login(PHONES.service);
  riceId = (await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM skus WHERE spec_name = '示例规格'"))!.id;
  appleId = (await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT s.id FROM skus s JOIN products p ON p.id = s.product_id WHERE p.name = '云南苹果' AND s.spec_name = '一级果'"))!.id;
});

after(async () => cleanup());

test("商家甲的列表里没有商家乙的商品和底价", async () => {
  const { status, body } = await readJson(await handleListSkus(authed("/api/skus", cookieA)));
  assert.equal(status, 200);
  const text = JSON.stringify(body);
  assert.equal(text.includes("优质大米"), false);
  assert.equal(text.includes("86.00"), false);
  assert.equal(text.includes("云南苹果"), true);
});

test("商家甲按编号读取商家乙规格会被拒绝，响应不含底价", async () => {
  const { status, body } = await readJson(await handleGetSku(authed(`/api/skus/${riceId}`, cookieA), riceId));
  assert.equal(status, 403);
  const text = JSON.stringify(body);
  assert.equal(text.includes("86.00"), false);
  assert.equal(text.includes("优质大米"), false);
});

test("商家甲不能改商家乙的报价或入库", async () => {
  const before = await one<{ on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [riceId]);
  const quote = await readJson(await handleCreateQuote(authed("/api/quotes", cookieA, { method: "POST", body: { skuId: riceId, floorPriceYuan: "1.00", validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString() } })));
  const inbound = await readJson(await handleCreateInbound(authed("/api/inbound", cookieA, { method: "POST", body: { skuId: riceId, unitId: "other", qty: 1 } })));
  assert.equal(quote.status, 403);
  assert.equal(inbound.status, 403);
  const after = await one<{ on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [riceId]);
  assert.equal(after?.on_hand_base, before?.on_hand_base);
});

test("客户端附带 merchantId 会被拒绝", async () => {
  const before = await one<{ on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [appleId]);
  const unit = await one<{ id: string }>((await import("../lib/db")).getPool(), "SELECT id FROM product_units WHERE unit_label = '斤' AND product_id = (SELECT product_id FROM skus WHERE id = $1)", [appleId]);
  const { status, body } = await readJson(await handleCreateInbound(authed("/api/inbound", cookieA, { method: "POST", body: { skuId: appleId, unitId: unit?.id, qty: 1, merchantId: "merchant-b" } })));
  assert.equal(status, 400);
  assert.equal(body.code, "MERCHANT_ID_NOT_ALLOWED");
  const after = await one<{ on_hand_base: number }>((await import("../lib/db")).getPool(), "SELECT on_hand_base FROM inventory WHERE sku_id = $1", [appleId]);
  assert.equal(after?.on_hand_base, before?.on_hand_base);
});

test("集团只能看旗下商家甲，也不能下单", async () => {
  const list = await readJson(await handleListSkus(authed("/api/skus", cookieGroup)));
  const text = JSON.stringify(list.body);
  assert.equal(list.status, 200);
  assert.equal(text.includes("云南苹果"), true);
  assert.equal(text.includes("优质大米"), false);
  const rice = await readJson(await handleGetSku(authed(`/api/skus/${riceId}`, cookieGroup), riceId));
  assert.equal(rice.status, 403);
  const order = await readJson(await handleCreateOrder(authed("/api/orders", cookieGroup, { method: "POST", body: { skuId: appleId, unitId: "x", qty: 1, buyerLabel: "示例采购方", idempotencyKey: "g1" } })));
  assert.equal(order.status, 403);
});

test("平台能看两边底价，客服默认不能看库", async () => {
  const platform = await readJson(await handleListSkus(authed("/api/skus", cookiePlatform)));
  const text = JSON.stringify(platform.body);
  assert.equal(text.includes("云南苹果"), true);
  assert.equal(text.includes("优质大米"), true);
  assert.equal(text.includes("86.00"), true);
  const cs = await readJson(await handleListSkus(authed("/api/skus", cookieCs)));
  assert.equal(cs.status, 403);
  const quotes = await readJson(await handleListQuotes(authed("/api/quotes", cookieCs)));
  assert.equal(quotes.status, 403);
});

test("未登录不能读库存，演示旁路已停用", async () => {
  const anon = await readJson(await handleListSkus(new Request("http://local/api/skus")));
  assert.equal(anon.status, 401);
  const demo = await readJson(await handleLogin());
  assert.equal(demo.status, 410);
  assert.equal(demo.body.code, "DEMO_LOGIN_DISABLED");
  const demos = await readJson(handleDemos());
  assert.equal(demos.status, 410);
});
