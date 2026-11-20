import { randomBytes } from "node:crypto";
import { convertToBase, parsePositiveInt } from "./convert";
import { type Db, exec, getPool, one, query, transaction } from "./db";
import { breakdown, commissionCents, platformPriceCents } from "./pricing";
import { COMMISSION_RULE, DEFAULT_COMMISSION_BPS, OVERLAP_RULE, ROUNDING_RULE } from "./rules";
import { normalizePayment, parseAnnualPercent, recordShipmentBatch, samePayment, type PaymentInput, type PaymentSnapshot } from "./payments";
import { applyReservationRelease } from "./timeout-judge";
import type { Actor, Err, PriceBreakdown, QuoteStatus, QuoteView, Result, Role, SkuRecord } from "./types";

type UnitRow = {
  id: string;
  product_id: string;
  unit_label: string;
  is_base: boolean;
  to_base_numerator: number;
  to_base_denominator: number;
};

const STATUS_LABEL: Record<QuoteStatus, string> = {
  effective: "有效",
  expired: "已过期",
  scheduled: "未生效",
  overlapped: "重叠未采用",
};

function nid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function fail(code: string, message: string, httpStatus: number): Err {
  return { ok: false, code, message, httpStatus };
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export async function getActorById(userId: string): Promise<Actor | null> {
  const row = await one<{
    id: string;
    display_name: string;
    role: Role;
    merchant_id: string | null;
    group_id: string | null;
    merchant_name: string | null;
    group_name: string | null;
    phone: string;
  }>(
    getPool(),
    `SELECT u.id, u.display_name, u.role, u.merchant_id, u.group_id, u.phone,
            m.name AS merchant_name, g.name AS group_name
     FROM users u
     LEFT JOIN merchants m ON m.id = u.merchant_id
     LEFT JOIN groups g ON g.id = u.group_id
     WHERE u.id = $1`,
    [userId],
  );
  if (!row) return null;
  return {
    userId: row.id,
    displayName: row.display_name,
    role: row.role,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    groupId: row.group_id,
    groupName: row.group_name,
    phoneMasked: `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}`,
  };
}

export async function getActorByPhone(phone: string): Promise<Actor | null> {
  const row = await one<{ id: string }>(getPool(), "SELECT id FROM users WHERE phone = $1", [phone]);
  if (!row) return null;
  return getActorById(row.id);
}

function scope(actor: Actor, merchantColumn: string, groupColumn: string): Result<{ sql: string; params: unknown[] }> {
  if (actor.role === "customer_service") {
    return fail("FORBIDDEN", "客服不默认全库，当前账号不能查看商品、库存或底价。", 403);
  }
  if (actor.role === "platform") return { ok: true, data: { sql: "TRUE", params: [] } };
  if (actor.role === "merchant") {
    if (!actor.merchantId) return fail("FORBIDDEN", "商家账号未绑定商家。", 403);
    return { ok: true, data: { sql: `${merchantColumn} = $1`, params: [actor.merchantId] } };
  }
  if (!actor.groupId) return fail("FORBIDDEN", "集团账号未绑定集团。", 403);
  return { ok: true, data: { sql: `${groupColumn} = $1`, params: [actor.groupId] } };
}

async function loadUnits(db: Db, productId: string): Promise<UnitRow[]> {
  return query<UnitRow>(
    db,
    `SELECT id, product_id, unit_label, is_base, to_base_numerator, to_base_denominator
     FROM product_units WHERE product_id = $1 ORDER BY is_base DESC, unit_label`,
    [productId],
  );
}

async function mapSku(db: Db, row: {
  id: string;
  product_id: string;
  merchant_id: string;
  merchant_name: string;
  group_id: string | null;
  product_name: string;
  spec_name: string;
  on_hand_base: number;
  reserved_base: number;
  created_at: Date | string;
  note: string | null;
}): Promise<SkuRecord> {
  const units = await loadUnits(db, row.product_id);
  const base = units.find((unit) => unit.is_base);
  const baseLabel = base?.unit_label ?? "";
  return {
    id: row.id,
    productId: row.product_id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    groupId: row.group_id,
    productName: row.product_name,
    specName: row.spec_name,
    baseUnitLabel: baseLabel,
    unitLabel: baseLabel,
    onHand: row.on_hand_base,
    onHandBase: row.on_hand_base,
    reservedBase: row.reserved_base,
    availableBase: row.on_hand_base - row.reserved_base,
    units: units.map((unit) => ({
      id: unit.id,
      unitLabel: unit.unit_label,
      isBase: unit.is_base,
      toBaseNumerator: unit.to_base_numerator,
      toBaseDenominator: unit.to_base_denominator,
    })),
    createdAt: iso(row.created_at),
    note: row.note,
  };
}

async function authorizeSku(actor: Actor, skuId: string, mode: "read" | "write"): Promise<Result<SkuRecord>> {
  if (actor.role === "customer_service") return fail("FORBIDDEN", "客服不默认全库，当前账号不能查看商品、库存或底价。", 403);
  const row = await one<Parameters<typeof mapSku>[1]>(
    getPool(),
    `SELECT s.id, s.product_id, s.merchant_id, m.name AS merchant_name, m.group_id, p.name AS product_name,
            s.spec_name, i.on_hand_base, i.reserved_base, s.created_at, s.note
     FROM skus s
     JOIN products p ON p.id = s.product_id
     JOIN merchants m ON m.id = s.merchant_id
     JOIN inventory i ON i.sku_id = s.id
     WHERE s.id = $1`,
    [skuId],
  );
  if (!row) return fail("NOT_FOUND", "没有这个规格。", 404);
  const sku = await mapSku(getPool(), row);
  const allowed =
    actor.role === "platform" ||
    (actor.role === "merchant" && actor.merchantId === sku.merchantId) ||
    (actor.role === "group" && actor.groupId && actor.groupId === sku.groupId);
  if (!allowed) return fail("FORBIDDEN", "无权访问该商品、库存或报价。", 403);
  if (mode === "write" && !(actor.role === "merchant" && actor.merchantId === sku.merchantId)) {
    return fail("FORBIDDEN", "当前身份只能查看范围内的数据，不能修改库存或报价。", 403);
  }
  return { ok: true, data: sku };
}

export async function createProduct(
  actor: Actor,
  input: { name: string; baseUnitLabel: string; note?: string | null; units?: Array<{ label: string; numerator: number; denominator: number }> },
): Promise<Result<{ productId: string }>> {
  if (actor.role !== "merchant" || !actor.merchantId) return fail("FORBIDDEN", "只有供货商家可以新建自己的商品。", 403);
  if (!input.name.trim() || !input.baseUnitLabel.trim()) return fail("INVALID_INPUT", "请填写商品名和基准单位。", 400);
  const productId = nid("prd");
  const baseId = nid("unit");
  try {
    await transaction(async (client) => {
      await exec(
        client,
        "INSERT INTO products (id, merchant_id, name, note, created_at) VALUES ($1, $2, $3, $4, NOW())",
        [productId, actor.merchantId, input.name.trim(), input.note ?? null],
      );
      await exec(
        client,
        `INSERT INTO product_units (id, product_id, unit_label, is_base, to_base_numerator, to_base_denominator)
         VALUES ($1, $2, $3, true, 1, 1)`,
        [baseId, productId, input.baseUnitLabel.trim()],
      );
      for (const unit of input.units ?? []) {
        const baseQty = convertToBase(1, unit.numerator, unit.denominator);
        if (!baseQty || unit.label.trim() === input.baseUnitLabel.trim()) {
          throw new Error("INVALID_RATIO");
        }
        await exec(
          client,
          `INSERT INTO product_units (id, product_id, unit_label, is_base, to_base_numerator, to_base_denominator)
           VALUES ($1, $2, $3, false, $4, $5)`,
          [nid("unit"), productId, unit.label.trim(), unit.numerator, unit.denominator],
        );
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_RATIO") {
      return fail("INVALID_RATIO", "换算比例必须是该商品自己的正整数分子和分母，且换到基准单位后不能是 0。", 400);
    }
    throw error;
  }
  return { ok: true, data: { productId } };
}

export async function updateUnitRatio(
  actor: Actor,
  unitId: string,
  numerator: number,
  denominator: number,
): Promise<Result<{ unitId: string }>> {
  const unit = await one<UnitRow & { merchant_id: string }>(
    getPool(),
    `SELECT u.id, u.product_id, u.unit_label, u.is_base, u.to_base_numerator, u.to_base_denominator, p.merchant_id
     FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.id = $1`,
    [unitId],
  );
  if (!unit) return fail("NOT_FOUND", "没有这个单位。", 404);
  if (actor.role !== "merchant" || actor.merchantId !== unit.merchant_id) return fail("FORBIDDEN", "只能修改自己商品的换算比例。", 403);
  if (unit.is_base) return fail("INVALID_RATIO", "基准单位的比例固定为 1/1。", 400);
  if (!convertToBase(1, numerator, denominator)) return fail("INVALID_RATIO", "换算比例不合法。", 400);
  await exec(
    getPool(),
    "UPDATE product_units SET to_base_numerator = $2, to_base_denominator = $3 WHERE id = $1",
    [unitId, numerator, denominator],
  );
  return { ok: true, data: { unitId } };
}

export async function createSku(actor: Actor, input: { productId: string; specName: string; note?: string | null }): Promise<Result<SkuRecord>> {
  if (actor.role !== "merchant" || !actor.merchantId) return fail("FORBIDDEN", "只有供货商家可以新建自己的规格。", 403);
  const product = await one<{ merchant_id: string }>(getPool(), "SELECT merchant_id FROM products WHERE id = $1", [input.productId]);
  if (!product) return fail("NOT_FOUND", "没有这个商品。", 404);
  if (product.merchant_id !== actor.merchantId) return fail("FORBIDDEN", "不能在其他商家的商品下新建规格。", 403);
  if (!input.specName.trim()) return fail("INVALID_INPUT", "请填写规格。", 400);
  const id = nid("sku");
  await transaction(async (client) => {
    await exec(
      client,
      "INSERT INTO skus (id, product_id, merchant_id, spec_name, note, created_at) VALUES ($1, $2, $3, $4, $5, NOW())",
      [id, input.productId, actor.merchantId, input.specName.trim(), input.note ?? null],
    );
    await exec(client, "INSERT INTO inventory (sku_id, on_hand_base, reserved_base) VALUES ($1, 0, 0)", [id]);
  });
  return authorizeSku(actor, id, "read");
}

async function roundingMode(): Promise<string> {
  const row = await one<{ mode: string }>(getPool(), "SELECT mode FROM rounding_settings WHERE id = 1");
  return row?.mode ?? "half_up";
}

export async function receiveInbound(
  actor: Actor,
  input: { skuId: string; unitId: string; qty: number; note?: string | null },
): Promise<Result<{ docId: string; onHandBase: number; qtyBase: number }>> {
  const qty = parsePositiveInt(input.qty);
  if (!qty) return fail("INVALID_INPUT", "入库数量必须是正整数。", 400);
  const allowed = await authorizeSku(actor, input.skuId, "write");
  if (!allowed.ok) return allowed;
  const unit = await one<UnitRow>(getPool(), "SELECT * FROM product_units WHERE id = $1", [input.unitId]);
  if (!unit || unit.product_id !== allowed.data.productId) {
    return fail("UNIT_PRODUCT_MISMATCH", "这个单位不属于当前商品，不能借用其他商品的换算比例。", 400);
  }
  const qtyBase = convertToBase(qty, unit.to_base_numerator, unit.to_base_denominator);
  if (!qtyBase) return fail("INVALID_RATIO", "按该商品自己的比例换算后数量无效。", 400);
  const mode = await roundingMode();
  const docId = nid("in");
  await transaction(async (client) => {
    const locked = await one<{ on_hand_base: number; reserved_base: number }>(
      client,
      "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1 FOR UPDATE",
      [allowed.data.id],
    );
    if (!locked) throw new Error("missing inventory");
    await exec(client, "UPDATE inventory SET on_hand_base = on_hand_base + $2 WHERE sku_id = $1", [allowed.data.id, qtyBase]);
    const after = locked.on_hand_base + qtyBase;
    await exec(
      client,
      `INSERT INTO inbound_docs (
         id, merchant_id, sku_id, product_id, qty_in_unit, unit_id, unit_label, to_base_numerator, to_base_denominator,
         qty_base, rounding_mode, actor_user_id, actor_name, note, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
      [
        docId,
        allowed.data.merchantId,
        allowed.data.id,
        allowed.data.productId,
        qty,
        unit.id,
        unit.unit_label,
        unit.to_base_numerator,
        unit.to_base_denominator,
        qtyBase,
        mode,
        actor.userId,
        actor.displayName,
        input.note ?? null,
      ],
    );
    await exec(
      client,
      `INSERT INTO ledger (
         id, merchant_id, sku_id, movement_type, qty_base_delta, reserved_delta, on_hand_after, reserved_after, available_after,
         unit_label, qty_in_unit, to_base_numerator, to_base_denominator, rounding_mode, ref_doc_type, ref_doc_id,
         actor_user_id, actor_name, note, created_at
       ) VALUES ($1,$2,$3,'purchase_in',$4,0,$5,$6,$7,$8,$9,$10,$11,$12,'inbound',$13,$14,$15,$16,NOW())`,
      [
        nid("led"),
        allowed.data.merchantId,
        allowed.data.id,
        qtyBase,
        after,
        locked.reserved_base,
        after - locked.reserved_base,
        unit.unit_label,
        qty,
        unit.to_base_numerator,
        unit.to_base_denominator,
        mode,
        docId,
        actor.userId,
        actor.displayName,
        `采购入库 ${qty} ${unit.unit_label}，快照比例 ${unit.to_base_numerator}/${unit.to_base_denominator}，基准数量 ${qtyBase}`,
      ],
    );
  });
  return { ok: true, data: { docId, onHandBase: (await authorizeSku(actor, allowed.data.id, "read")).ok ? (await authorizeSku(actor, allowed.data.id, "read") as { ok: true; data: SkuRecord }).data.onHandBase : qtyBase, qtyBase } };
}

async function effectiveQuote(db: Db, skuId: string, now = new Date()) {
  return one<{
    id: string;
    floor_price_cents: number;
    valid_from: Date;
    valid_until: Date;
    created_at: Date;
    note: string | null;
    created_by: string;
    merchant_id: string;
    sku_id: string;
  }>(
    db,
    `SELECT id, sku_id, merchant_id, floor_price_cents, valid_from, valid_until, created_by, created_at, note
     FROM quotes
     WHERE sku_id = $1 AND valid_from <= $2 AND valid_until > $2
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [skuId, now.toISOString()],
  );
}

async function commissionOf(db: Db, merchantId: string): Promise<{ bps: number; source: "platform" | "merchant" | "default" }> {
  const row = await one<{ merchant_bps: number | null; platform_bps: number | null }>(
    db,
    "SELECT merchant_bps, platform_bps FROM merchant_commission WHERE merchant_id = $1",
    [merchantId],
  );
  if (row?.platform_bps != null) return { bps: row.platform_bps, source: "platform" };
  if (row?.merchant_bps != null) return { bps: row.merchant_bps, source: "merchant" };
  return { bps: DEFAULT_COMMISSION_BPS, source: "default" };
}

export async function createQuote(
  actor: Actor,
  input: { skuId: string; floorPriceCents: number; validFrom: string; validUntil: string; note?: string | null },
  options?: { createdAt?: Date },
): Promise<Result<QuoteView>> {
  const allowed = await authorizeSku(actor, input.skuId, "write");
  if (!allowed.ok) return allowed;
  if (!Number.isInteger(input.floorPriceCents) || input.floorPriceCents < 0) return fail("INVALID_INPUT", "底价需为非负金额，最多两位小数。", 400);
  const from = new Date(input.validFrom);
  const until = new Date(input.validUntil);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || until <= from) {
    return fail("INVALID_INPUT", "报价结束时间必须晚于开始时间。", 400);
  }
  const id = nid("quo");
  await exec(
    getPool(),
    `INSERT INTO quotes (id, sku_id, merchant_id, floor_price_cents, valid_from, valid_until, created_by, created_at, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, allowed.data.id, allowed.data.merchantId, input.floorPriceCents, from.toISOString(), until.toISOString(), actor.userId, (options?.createdAt ?? new Date()).toISOString(), input.note ?? null],
  );
  const listed = await listQuotes(actor, allowed.data.id);
  if (!listed.ok) return listed;
  const created = listed.data.quotes.find((quote) => quote.id === id);
  if (!created) return fail("NOT_FOUND", "报价保存后没有读到。", 500);
  return { ok: true, data: created };
}

export async function listSkus(actor: Actor): Promise<Result<{ skus: Array<SkuRecord & { effective: PriceBreakdown | null }> }>> {
  const where = scope(actor, "s.merchant_id", "m.group_id");
  if (!where.ok) return where;
  const rows = await query<Parameters<typeof mapSku>[1]>(
    getPool(),
    `SELECT s.id, s.product_id, s.merchant_id, m.name AS merchant_name, m.group_id, p.name AS product_name,
            s.spec_name, i.on_hand_base, i.reserved_base, s.created_at, s.note
     FROM skus s
     JOIN products p ON p.id = s.product_id
     JOIN merchants m ON m.id = s.merchant_id
     JOIN inventory i ON i.sku_id = s.id
     WHERE ${where.data.sql}
     ORDER BY m.name, p.name, s.spec_name`,
    where.data.params,
  );
  const skus = [];
  for (const row of rows) {
    const sku = await mapSku(getPool(), row);
    const quote = await effectiveQuote(getPool(), sku.id);
    const rate = await commissionOf(getPool(), sku.merchantId);
    skus.push({ ...sku, effective: quote ? breakdown(quote.id, quote.floor_price_cents, rate.bps) : null });
  }
  return { ok: true, data: { skus } };
}

export async function getSkuDetail(actor: Actor, skuId: string): Promise<Result<{ sku: SkuRecord; quotes: QuoteView[]; effective: PriceBreakdown | null; rules: Record<string, string> }>> {
  const allowed = await authorizeSku(actor, skuId, "read");
  if (!allowed.ok) return allowed;
  const quotes = await listQuotes(actor, skuId);
  if (!quotes.ok) return quotes;
  return {
    ok: true,
    data: {
      sku: allowed.data,
      quotes: quotes.data.quotes,
      effective: quotes.data.effective,
      rules: { overlap: OVERLAP_RULE, rounding: ROUNDING_RULE, commission: COMMISSION_RULE },
    },
  };
}

export async function listQuotes(actor: Actor, skuId?: string): Promise<Result<{ quotes: QuoteView[]; effective: PriceBreakdown | null }>> {
  const where = scope(actor, "s.merchant_id", "m.group_id");
  if (!where.ok) return where;
  if (skuId) {
    const allowed = await authorizeSku(actor, skuId, "read");
    if (!allowed.ok) return allowed;
  }
  const params = [...where.data.params];
  let filter = "";
  if (skuId) {
    params.push(skuId);
    filter = ` AND q.sku_id = $${params.length}`;
  }
  const rows = await query<{
    id: string;
    sku_id: string;
    merchant_id: string;
    floor_price_cents: number;
    valid_from: Date;
    valid_until: Date;
    created_at: Date;
    created_by: string;
    note: string | null;
    product_name: string;
    spec_name: string;
    unit_label: string;
  }>(
    getPool(),
    `SELECT q.id, q.sku_id, q.merchant_id, q.floor_price_cents, q.valid_from, q.valid_until, q.created_by, q.created_at, q.note,
            p.name AS product_name, s.spec_name, bu.unit_label
     FROM quotes q
     JOIN skus s ON s.id = q.sku_id
     JOIN products p ON p.id = s.product_id
     JOIN merchants m ON m.id = s.merchant_id
     JOIN product_units bu ON bu.product_id = p.id AND bu.is_base
     WHERE ${where.data.sql}${filter}
     ORDER BY q.created_at DESC, q.id DESC`,
    params,
  );
  const now = new Date().toISOString();
  const quotes: QuoteView[] = [];
  for (const row of rows) {
    const effective = await effectiveQuote(getPool(), row.sku_id);
    const bps = (await commissionOf(getPool(), row.merchant_id)).bps;
    const from = iso(row.valid_from);
    const until = iso(row.valid_until);
    const status: QuoteStatus = from > now ? "scheduled" : until <= now ? "expired" : row.id === effective?.id ? "effective" : "overlapped";
    quotes.push({
      id: row.id,
      skuId: row.sku_id,
      merchantId: row.merchant_id,
      productName: row.product_name,
      specName: row.spec_name,
      unitLabel: row.unit_label,
      floorPriceCents: row.floor_price_cents,
      floorPriceYuan: breakdown(row.id, row.floor_price_cents, bps).floorPriceYuan,
      validFrom: from,
      validUntil: until,
      createdAt: iso(row.created_at),
      createdBy: row.created_by,
      note: row.note,
      status,
      statusLabel: STATUS_LABEL[status],
      price: status === "effective" ? breakdown(row.id, row.floor_price_cents, bps) : null,
    });
  }
  const effectiveRow = skuId ? await effectiveQuote(getPool(), skuId) : null;
  const bps = effectiveRow ? (await commissionOf(getPool(), effectiveRow.merchant_id)).bps : 0;
  return {
    ok: true,
    data: {
      quotes,
      effective: effectiveRow ? breakdown(effectiveRow.id, effectiveRow.floor_price_cents, bps) : null,
    },
  };
}

type OrderRow = {
  id: string;
  merchant_id: string;
  sku_id: string;
  product_id: string;
  buyer_label: string;
  qty_in_unit: number;
  unit_id: string;
  unit_label: string;
  to_base_numerator: number;
  to_base_denominator: number;
  qty_base: number;
  rounding_mode: string;
  quote_id: string;
  floor_price_cents: number;
  line_floor_cents: number;
  commission_bps: number;
  commission_cents: number;
  platform_price_cents: number;
  status: "reserved" | "fulfilled" | "cancelled" | "timed_out";
  qty_fulfilled_base: number;
  idempotency_key: string;
};

function orderPayloadMatches(row: OrderRow, input: { skuId: string; unitId: string; qty: number; buyerLabel: string }): boolean {
  return row.sku_id === input.skuId && row.unit_id === input.unitId && row.qty_in_unit === input.qty && row.buyer_label === input.buyerLabel;
}

export async function placeOrder(
  actor: Actor,
  input: { skuId: string; unitId: string; qty: number; buyerLabel: string; idempotencyKey: string; payment?: PaymentInput | null },
): Promise<Result<OrderRow & { availableBase: number }>> {
  const qty = parsePositiveInt(input.qty);
  if (!qty || !input.buyerLabel.trim() || !input.idempotencyKey.trim()) {
    return fail("INVALID_INPUT", "请填写数量、采购方和幂等键。", 400);
  }
  const payment = normalizePayment(input.payment);
  if (!payment.ok) return payment;
  const allowed = await authorizeSku(actor, input.skuId, "write");
  if (!allowed.ok) return allowed;
  const unit = await one<UnitRow>(getPool(), "SELECT * FROM product_units WHERE id = $1", [input.unitId]);
  if (!unit || unit.product_id !== allowed.data.productId) {
    return fail("UNIT_PRODUCT_MISMATCH", "这个单位不属于当前商品。", 400);
  }
  const qtyBase = convertToBase(qty, unit.to_base_numerator, unit.to_base_denominator);
  if (!qtyBase) return fail("INVALID_RATIO", "换算后的预占数量无效。", 400);
  const existing = await one<OrderRow>(
    getPool(),
    "SELECT * FROM orders WHERE merchant_id = $1 AND idempotency_key = $2",
    [allowed.data.merchantId, input.idempotencyKey.trim()],
  );
  if (existing) {
    const storedPayment: PaymentSnapshot = {
      method: (existing as OrderRow & { payment_method?: PaymentSnapshot["method"] }).payment_method ?? null,
      termDays: (existing as OrderRow & { term_days?: number | null }).term_days ?? null,
      capitalCostAnnualPercent: parseAnnualPercent(String((existing as OrderRow & { capital_cost_annual_percent?: string | number | null }).capital_cost_annual_percent ?? "")),
      overdueAnnualPercent: parseAnnualPercent(String((existing as OrderRow & { overdue_annual_percent?: string | number | null }).overdue_annual_percent ?? "")),
      agreementPriceCents: (existing as OrderRow & { agreement_price_cents?: number | null }).agreement_price_cents ?? null,
    };
    if (!orderPayloadMatches(existing, { ...input, qty, buyerLabel: input.buyerLabel.trim() }) || !samePayment(storedPayment, payment.data)) {
      return fail("IDEMPOTENCY_CONFLICT", "同一个幂等键不能改成另一笔订单。", 409);
    }
    const sku = await authorizeSku(actor, existing.sku_id, "read");
    return { ok: true, data: { ...existing, availableBase: sku.ok ? sku.data.availableBase : 0 } };
  }
  const quote = await effectiveQuote(getPool(), allowed.data.id);
  if (!quote) return fail("NO_VALID_QUOTE", "没有未过期的有效报价，不能下单预占。库存未改变。", 409);
  const bps = (await commissionOf(getPool(), allowed.data.merchantId)).bps;
  const lineFloor = quote.floor_price_cents * qtyBase;
  const fee = commissionCents(lineFloor, bps);
  const platform = platformPriceCents(lineFloor, bps);
  const mode = await roundingMode();
  const orderId = nid("ord");
  const timeoutConfig = await one<{ duration_value: number; duration_unit: "minute" | "hour" | "day" }>(
    getPool(),
    "SELECT duration_value, duration_unit FROM order_timeout_config WHERE merchant_id = $1",
    [allowed.data.merchantId],
  );
  try {
    await transaction(async (client) => {
      const locked = await one<{ on_hand_base: number; reserved_base: number }>(
        client,
        "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1 FOR UPDATE",
        [allowed.data.id],
      );
      if (!locked || locked.on_hand_base - locked.reserved_base < qtyBase) {
        throw Object.assign(new Error("INSUFFICIENT_STOCK"), { status: 409 });
      }
      await exec(client, "UPDATE inventory SET reserved_base = reserved_base + $2 WHERE sku_id = $1", [allowed.data.id, qtyBase]);
      const reservedAfter = locked.reserved_base + qtyBase;
      const timeoutAt = timeoutConfig
        ? await one<{ timeout_at: Date }>(
            client,
            `SELECT NOW() + CASE $2
               WHEN 'minute' THEN make_interval(mins => $1::int)
               WHEN 'hour' THEN make_interval(hours => $1::int)
               WHEN 'day' THEN make_interval(days => $1::int)
             END AS timeout_at`,
            [timeoutConfig.duration_value, timeoutConfig.duration_unit],
          )
        : null;
      await exec(
        client,
        `INSERT INTO orders (
           id, merchant_id, sku_id, product_id, buyer_label, qty_in_unit, unit_id, unit_label,
           to_base_numerator, to_base_denominator, qty_base, rounding_mode, quote_id, floor_price_cents,
           line_floor_cents, commission_bps, commission_cents, platform_price_cents, status, idempotency_key,
           actor_user_id, actor_name, created_at, timeout_duration_value, timeout_duration_unit, timeout_at,
           payment_method, term_days, capital_cost_annual_percent, overdue_annual_percent, agreement_price_cents, agreement_price_source, principal_cents
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'reserved',$19,$20,$21,NOW(),$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
        [
          orderId,
          allowed.data.merchantId,
          allowed.data.id,
          allowed.data.productId,
          input.buyerLabel.trim(),
          qty,
          unit.id,
          unit.unit_label,
          unit.to_base_numerator,
          unit.to_base_denominator,
          qtyBase,
          mode,
          quote.id,
          quote.floor_price_cents,
          lineFloor,
          bps,
          fee,
          platform,
          input.idempotencyKey.trim(),
          actor.userId,
          actor.displayName,
          timeoutConfig?.duration_value ?? null,
          timeoutConfig?.duration_unit ?? null,
          timeoutAt?.timeout_at ?? null,
          payment.data.method,
          payment.data.termDays,
          payment.data.capitalCostAnnualPercent,
          payment.data.overdueAnnualPercent,
          payment.data.agreementPriceCents,
          payment.data.method ? "order_time_explicit" : null,
          payment.data.agreementPriceCents,
        ],
      );
      await exec(
        client,
        `INSERT INTO ledger (
           id, merchant_id, sku_id, movement_type, qty_base_delta, reserved_delta, on_hand_after, reserved_after, available_after,
           unit_label, qty_in_unit, to_base_numerator, to_base_denominator, rounding_mode, ref_doc_type, ref_doc_id,
           actor_user_id, actor_name, note, created_at
         ) VALUES ($1,$2,$3,'order_reserve',0,$4,$5,$6,$7,$8,$9,$10,$11,$12,'order',$13,$14,$15,$16,NOW())`,
        [
          nid("led"),
          allowed.data.merchantId,
          allowed.data.id,
          qtyBase,
          locked.on_hand_base,
          reservedAfter,
          locked.on_hand_base - reservedAfter,
          unit.unit_label,
          qty,
          unit.to_base_numerator,
          unit.to_base_denominator,
          mode,
          orderId,
          actor.userId,
          actor.displayName,
          `下单预占 ${qty} ${unit.unit_label}，基准数量 ${qtyBase}。报价 ${quote.id}，费率 ${bps} 基点已快照。${timeoutConfig ? `超时快照 ${timeoutConfig.duration_value} ${timeoutConfig.duration_unit}。` : "下单时没有超时配置，本单不会自动超时。"}`,
        ],
      );
    });
  } catch (error) {
    const code = (error as { code?: string; status?: number }).code;
    if ((error as { status?: number }).status === 409 || (error instanceof Error && error.message === "INSUFFICIENT_STOCK")) {
      return fail("INSUFFICIENT_STOCK", "可用库存不足，已拒绝下单，现货和预占都未改变。", 409);
    }
    if (code === "23505") {
      const winner = await one<OrderRow>(getPool(), "SELECT * FROM orders WHERE merchant_id = $1 AND idempotency_key = $2", [allowed.data.merchantId, input.idempotencyKey.trim()]);
      const winnerPayment: PaymentSnapshot = {
        method: (winner as OrderRow & { payment_method?: PaymentSnapshot["method"] })?.payment_method ?? null,
        termDays: (winner as OrderRow & { term_days?: number | null })?.term_days ?? null,
        capitalCostAnnualPercent: parseAnnualPercent(String((winner as OrderRow & { capital_cost_annual_percent?: string | number | null })?.capital_cost_annual_percent ?? "")),
        overdueAnnualPercent: parseAnnualPercent(String((winner as OrderRow & { overdue_annual_percent?: string | number | null })?.overdue_annual_percent ?? "")),
        agreementPriceCents: (winner as OrderRow & { agreement_price_cents?: number | null })?.agreement_price_cents ?? null,
      };
      if (winner && orderPayloadMatches(winner, { ...input, qty, buyerLabel: input.buyerLabel.trim() }) && samePayment(winnerPayment, payment.data)) {
        const sku = await authorizeSku(actor, winner.sku_id, "read");
        return { ok: true, data: { ...winner, availableBase: sku.ok ? sku.data.availableBase : 0 } };
      }
      return fail("IDEMPOTENCY_CONFLICT", "同一个幂等键不能改成另一笔订单。", 409);
    }
    throw error;
  }
  const saved = await one<OrderRow>(getPool(), "SELECT * FROM orders WHERE id = $1", [orderId]);
  const sku = await authorizeSku(actor, allowed.data.id, "read");
  if (!saved) return fail("NOT_FOUND", "订单保存后没有读到。", 500);
  return { ok: true, data: { ...saved, availableBase: sku.ok ? sku.data.availableBase : 0 } };
}

async function stockOf(db: Db, skuId: string): Promise<{ onHandBase: number; reservedBase: number }> {
  const row = await one<{ on_hand_base: number; reserved_base: number }>(db, "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1", [skuId]);
  return { onHandBase: row?.on_hand_base ?? 0, reservedBase: row?.reserved_base ?? 0 };
}

export async function confirmOutbound(
  actor: Actor,
  orderId: string,
  input: { qty: number; idempotencyKey: string },
): Promise<Result<{ docId: string; onHandBase: number; reservedBase: number; qtyFulfilledBase: number; replayed: boolean }>> {
  const qty = parsePositiveInt(input.qty);
  if (!qty || !input.idempotencyKey.trim()) return fail("INVALID_INPUT", "请填写本次出库数量和幂等键。", 400);
  const order = await one<OrderRow>(getPool(), "SELECT * FROM orders WHERE id = $1", [orderId]);
  if (!order) return fail("NOT_FOUND", "没有这张订单。", 404);
  if (actor.role !== "merchant" || actor.merchantId !== order.merchant_id) return fail("FORBIDDEN", "不能确认其他商家的出库。", 403);
  const replay = await one<{ id: string; order_id: string; qty_base: number }>(
    getPool(),
    "SELECT id, order_id, qty_base FROM outbound_docs WHERE merchant_id = $1 AND idempotency_key = $2",
    [order.merchant_id, input.idempotencyKey.trim()],
  );
  if (replay) {
    if (replay.order_id !== orderId) return fail("IDEMPOTENCY_CONFLICT", "这个幂等键已经用于另一张订单。", 409);
    const stock = await stockOf(getPool(), order.sku_id);
    const current = await one<{ qty_fulfilled_base: number }>(getPool(), "SELECT qty_fulfilled_base FROM orders WHERE id = $1", [orderId]);
    return { ok: true, data: { docId: replay.id, ...stock, qtyFulfilledBase: current?.qty_fulfilled_base ?? 0, replayed: true } };
  }
  const shipBase = convertToBase(qty, order.to_base_numerator, order.to_base_denominator);
  if (!shipBase) return fail("INVALID_RATIO", "按订单快照比例换算后，本次出库数量无效。", 400);
  let docId = "";
  let onHandBase = 0;
  let reservedBase = 0;
  let qtyFulfilledBase = 0;
  try {
    await transaction(async (client) => {
      const lockedOrder = await one<OrderRow>(client, "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
      if (!lockedOrder) throw new Error("missing order");
      if (lockedOrder.status === "cancelled" || lockedOrder.status === "timed_out") throw new Error("ORDER_CLOSED");
      const remaining = lockedOrder.qty_base - lockedOrder.qty_fulfilled_base;
      if (remaining <= 0 || lockedOrder.status === "fulfilled") throw new Error("EXCEEDS_ORDER");
      if (shipBase > remaining) throw new Error("EXCEEDS_ORDER");
      const locked = await one<{ on_hand_base: number; reserved_base: number }>(
        client,
        "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1 FOR UPDATE",
        [lockedOrder.sku_id],
      );
      if (!locked || locked.on_hand_base < shipBase || locked.reserved_base < shipBase) throw new Error("INSUFFICIENT_STOCK");
      onHandBase = locked.on_hand_base - shipBase;
      reservedBase = locked.reserved_base - shipBase;
      qtyFulfilledBase = lockedOrder.qty_fulfilled_base + shipBase;
      await exec(client, "UPDATE inventory SET on_hand_base = $2, reserved_base = $3 WHERE sku_id = $1", [lockedOrder.sku_id, onHandBase, reservedBase]);
      const done = qtyFulfilledBase === lockedOrder.qty_base;
      await exec(
        client,
        "UPDATE orders SET qty_fulfilled_base = $2, status = $3, fulfilled_at = CASE WHEN $3 = 'fulfilled' THEN NOW() ELSE fulfilled_at END WHERE id = $1",
        [orderId, qtyFulfilledBase, done ? "fulfilled" : "reserved"],
      );
      docId = nid("out");
      await exec(
        client,
        `INSERT INTO outbound_docs (id, order_id, merchant_id, sku_id, qty_base, actor_user_id, actor_name, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
        [docId, orderId, lockedOrder.merchant_id, lockedOrder.sku_id, shipBase, actor.userId, actor.displayName, input.idempotencyKey.trim()],
      );
      await recordShipmentBatch(client, orderId, lockedOrder.merchant_id, docId, shipBase);
      if (process.env.NODE_ENV !== "production" && process.env.OUTBOUND_FAIL_AFTER_BATCH === orderId) {
        throw new Error("OUTBOUND_TEST_ABORT");
      }
      await exec(
        client,
        `INSERT INTO ledger (
           id, merchant_id, sku_id, movement_type, qty_base_delta, reserved_delta, on_hand_after, reserved_after, available_after,
           unit_label, qty_in_unit, to_base_numerator, to_base_denominator, rounding_mode, ref_doc_type, ref_doc_id,
           actor_user_id, actor_name, note, created_at
         ) VALUES ($1,$2,$3,'sale_out',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'outbound',$14,$15,$16,$17,NOW())`,
        [
          nid("led"),
          lockedOrder.merchant_id,
          lockedOrder.sku_id,
          -shipBase,
          -shipBase,
          onHandBase,
          reservedBase,
          onHandBase - reservedBase,
          lockedOrder.unit_label,
          qty,
          lockedOrder.to_base_numerator,
          lockedOrder.to_base_denominator,
          lockedOrder.rounding_mode,
          docId,
          actor.userId,
          actor.displayName,
          `部分或全部出库 ${qty} ${lockedOrder.unit_label}，现货和对应预占各减 ${shipBase} 个基准单位。未出部分继续预占。`,
        ],
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "INSUFFICIENT_STOCK") return fail("INSUFFICIENT_STOCK", "出库确认失败，库存未再次扣减。", 409);
    if (message === "EXCEEDS_ORDER") return fail("EXCEEDS_ORDER", "累计出库不能超过订单数量，库存未改变。", 409);
    if (message === "ORDER_CLOSED") return fail("ORDER_CLOSED", "订单已取消或已超时释放，不能再出库。", 409);
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      const again = await one<{ id: string; order_id: string }>(getPool(), "SELECT id, order_id FROM outbound_docs WHERE merchant_id = $1 AND idempotency_key = $2", [order.merchant_id, input.idempotencyKey.trim()]);
      if (again && again.order_id === orderId) {
        const stock = await stockOf(getPool(), order.sku_id);
        const current = await one<{ qty_fulfilled_base: number }>(getPool(), "SELECT qty_fulfilled_base FROM orders WHERE id = $1", [orderId]);
        return { ok: true, data: { docId: again.id, ...stock, qtyFulfilledBase: current?.qty_fulfilled_base ?? 0, replayed: true } };
      }
    }
    throw error;
  }
  return { ok: true, data: { docId, onHandBase, reservedBase, qtyFulfilledBase, replayed: false } };
}

export async function releaseReservation(
  actor: Actor,
  orderId: string,
  reason: "cancelled" | "timed_out",
): Promise<Result<{ status: string; alreadyReleased: boolean; onHandBase: number; reservedBase: number; releasedBase: number }>> {
  const order = await one<OrderRow>(getPool(), "SELECT * FROM orders WHERE id = $1", [orderId]);
  if (!order) return fail("NOT_FOUND", "没有这张订单。", 404);
  if (actor.role !== "merchant" || actor.merchantId !== order.merchant_id) return fail("FORBIDDEN", "不能释放其他商家的预占。", 403);
  const released = await transaction((client) => applyReservationRelease(client, orderId, reason, actor, "event"));
  return { ok: true, data: released };
}

export async function getTimeoutConfig(actor: Actor, merchantId?: string | null): Promise<Result<{ configured: boolean; durationValue: number | null; durationUnit: string | null; note: string }>> {
  if (actor.role === "customer_service") return fail("FORBIDDEN", "客服不默认全库。", 403);
  let target = actor.merchantId;
  if (actor.role === "platform" || actor.role === "group") {
    if (!merchantId) return { ok: true, data: { configured: false, durationValue: null, durationUnit: null, note: "未指定商家。未配置时不会自动超时。" } };
    if (actor.role === "group") {
      const merchant = await one<{ group_id: string | null }>(getPool(), "SELECT group_id FROM merchants WHERE id = $1", [merchantId]);
      if (!merchant || merchant.group_id !== actor.groupId) return fail("FORBIDDEN", "不能查看旗下以外的超时配置。", 403);
    }
    target = merchantId;
  }
  if (!target) return fail("INVALID_INPUT", "没有可查看的商家。", 400);
  const row = await one<{ duration_value: number; duration_unit: string }>(getPool(), "SELECT duration_value, duration_unit FROM order_timeout_config WHERE merchant_id = $1", [target]);
  if (!row) {
    return { ok: true, data: { configured: false, durationValue: null, durationUnit: null, note: "未配置订单超时时长。系统不会自行按时间把订单判为超时，也没有默认时长。" } };
  }
  return { ok: true, data: { configured: true, durationValue: row.duration_value, durationUnit: row.duration_unit, note: "已保存。此后新建的订单会快照这个时长，到期后自动判定并释放剩余预占。已经存在的订单不会被这次修改改写。谁可以配置、变更是否应该追溯旧订单，仍未确认。" } };
}

export async function setTimeoutConfig(actor: Actor, merchantId: string | null, durationValue: number, durationUnit: string): Promise<Result<{ configured: true; durationValue: number; durationUnit: string }>> {
  if (actor.role !== "merchant" || !actor.merchantId) {
    return fail("TIMEOUT_CONFIG_ROLE_UNCONFIRMED", "超时配置的权限归属尚未确认。为避免跨商家写入，当前只保存本商家自己提交的配置，平台、集团和客服的代设不在本次实现。", 409);
  }
  if (merchantId && merchantId !== actor.merchantId) return fail("FORBIDDEN", "不能修改其他商家的超时配置。", 403);
  if (!Number.isInteger(durationValue) || durationValue <= 0 || durationValue > 1_000_000) {
    return fail("INVALID_INPUT", "超时时长必须是正整数。0 和负数不保存，也不当作默认时长。", 400);
  }
  if (durationUnit !== "minute" && durationUnit !== "hour" && durationUnit !== "day") {
    return fail("INVALID_INPUT", "时长单位只能是 minute、hour 或 day，不能省略后替用户假定。", 400);
  }
  await exec(
    getPool(),
    `INSERT INTO order_timeout_config (merchant_id, duration_value, duration_unit, updated_by, updated_by_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (merchant_id) DO UPDATE SET duration_value = EXCLUDED.duration_value, duration_unit = EXCLUDED.duration_unit, updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name, updated_at = NOW()`,
    [actor.merchantId, durationValue, durationUnit, actor.userId, actor.displayName],
  );
  return { ok: true, data: { configured: true, durationValue, durationUnit } };
}

export async function updateCommission(actor: Actor, merchantId: string | null, commissionBps: number): Promise<Result<{ bps: number; side: "merchant" | "platform"; updatedByName: string }>> {
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    return fail("INVALID_INPUT", "佣金比例需在 0% 到 100% 之间，最多两位小数。", 400);
  }
  if (commissionBps === 0) {
    return fail("COMMISSION_ZERO_UNCONFIRMED", "显式 0 的含义尚未确认，本次不保存，避免把它当成覆盖或清空。", 409);
  }
  let target = merchantId;
  let side: "merchant" | "platform";
  if (actor.role === "merchant") {
    if (merchantId && merchantId !== actor.merchantId) return fail("MERCHANT_ID_NOT_ALLOWED", "商家不能指定其他商家的费率。", 400);
    target = actor.merchantId;
    side = "merchant";
  } else if (actor.role === "platform") {
    if (!merchantId) return fail("INVALID_INPUT", "平台调整费率时必须指定商家。", 400);
    side = "platform";
  } else {
    return fail("FORBIDDEN", "当前身份不能调整佣金比例。", 403);
  }
  if (!target) return fail("FORBIDDEN", "没有可调整的商家。", 403);
  const merchant = await one<{ id: string }>(getPool(), "SELECT id FROM merchants WHERE id = $1", [target]);
  if (!merchant) return fail("NOT_FOUND", "没有这个商家。", 404);
  const previous = await one<{ merchant_bps: number | null; platform_bps: number | null }>(
    getPool(),
    "SELECT merchant_bps, platform_bps FROM merchant_commission WHERE merchant_id = $1",
    [target],
  );
  const previousBps = side === "platform" ? previous?.platform_bps ?? null : previous?.merchant_bps ?? null;
  await transaction(async (client) => {
    if (side === "platform") {
      await exec(
        client,
        `INSERT INTO merchant_commission (merchant_id, platform_bps, platform_updated_by, platform_updated_by_name, platform_updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (merchant_id) DO UPDATE SET platform_bps = EXCLUDED.platform_bps, platform_updated_by = EXCLUDED.platform_updated_by, platform_updated_by_name = EXCLUDED.platform_updated_by_name, platform_updated_at = NOW()`,
        [target, commissionBps, actor.userId, actor.displayName],
      );
    } else {
      await exec(
        client,
        `INSERT INTO merchant_commission (merchant_id, merchant_bps, merchant_updated_by, merchant_updated_by_name, merchant_updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (merchant_id) DO UPDATE SET merchant_bps = EXCLUDED.merchant_bps, merchant_updated_by = EXCLUDED.merchant_updated_by, merchant_updated_by_name = EXCLUDED.merchant_updated_by_name, merchant_updated_at = NOW()`,
        [target, commissionBps, actor.userId, actor.displayName],
      );
    }
    await exec(
      client,
      `INSERT INTO commission_audit (id, merchant_id, side, previous_bps, new_bps, actor_user_id, actor_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [nid("aud"), target, side, previousBps, commissionBps, actor.userId, actor.displayName],
    );
  });
  return { ok: true, data: { bps: commissionBps, side, updatedByName: actor.displayName } };
}

export async function getCommission(actor: Actor, merchantId?: string | null): Promise<Result<{ commissionBps: number; commissionPercent: string; effectiveSource: "platform" | "merchant" | "default"; merchantBps: number | null; platformBps: number | null; updatedByName: string | null; priorityApplied: boolean; label: string }>> {
  if (actor.role === "customer_service") return fail("FORBIDDEN", "客服不默认全库，不能查看平台佣金配置。", 403);
  let target = actor.merchantId;
  if (actor.role === "platform") target = merchantId ?? null;
  if (actor.role === "group") {
    if (!merchantId) return fail("INVALID_INPUT", "请指定旗下商家。", 400);
    const merchant = await one<{ group_id: string | null }>(getPool(), "SELECT group_id FROM merchants WHERE id = $1", [merchantId]);
    if (!merchant || merchant.group_id !== actor.groupId) return fail("FORBIDDEN", "集团不能查看旗下以外的费率。", 403);
    target = merchantId;
  }
  if (actor.role === "merchant" && merchantId && merchantId !== actor.merchantId) {
    return fail("FORBIDDEN", "不能查看其他商家的费率。", 403);
  }
  if (!target) return fail("INVALID_INPUT", "没有可查看的商家费率。", 400);
  const row = await one<{ merchant_bps: number | null; platform_bps: number | null; merchant_updated_by_name: string | null; platform_updated_by_name: string | null }>(
    getPool(),
    "SELECT merchant_bps, platform_bps, merchant_updated_by_name, platform_updated_by_name FROM merchant_commission WHERE merchant_id = $1",
    [target],
  );
  const effective = await commissionOf(getPool(), target);
  return {
    ok: true,
    data: {
      commissionBps: effective.bps,
      commissionPercent: (effective.bps / 100).toFixed(2),
      effectiveSource: effective.source,
      merchantBps: row?.merchant_bps ?? null,
      platformBps: row?.platform_bps ?? null,
      updatedByName: effective.source === "platform" ? row?.platform_updated_by_name ?? null : effective.source === "merchant" ? row?.merchant_updated_by_name ?? null : null,
      priorityApplied: row?.platform_bps != null && row?.merchant_bps != null,
      label: COMMISSION_RULE,
    },
  };
}

export async function listMerchants(actor: Actor): Promise<Result<{ merchants: Array<{ id: string; name: string; groupId: string | null; skuCount: number }> }>> {
  const where = scope(actor, "m.id", "m.group_id");
  if (!where.ok) return where;
  const sql =
    actor.role === "platform"
      ? "TRUE"
      : actor.role === "merchant"
        ? "m.id = $1"
        : "m.group_id = $1";
  const params = actor.role === "platform" ? [] : actor.role === "merchant" ? [actor.merchantId] : [actor.groupId];
  const rows = await query<{ id: string; name: string; group_id: string | null; sku_count: string }>(
    getPool(),
    `SELECT m.id, m.name, m.group_id, COUNT(s.id)::text AS sku_count
     FROM merchants m LEFT JOIN skus s ON s.merchant_id = m.id
     WHERE ${sql} GROUP BY m.id ORDER BY m.name`,
    params,
  );
  return { ok: true, data: { merchants: rows.map((row) => ({ id: row.id, name: row.name, groupId: row.group_id, skuCount: Number(row.sku_count) })) } };
}

export async function listLedger(actor: Actor, skuId?: string): Promise<Result<{ entries: Array<Record<string, unknown>> }>> {
  const where = scope(actor, "l.merchant_id", "m.group_id");
  if (!where.ok) return where;
  const params = [...where.data.params];
  let filter = "";
  if (skuId) {
    const allowed = await authorizeSku(actor, skuId, "read");
    if (!allowed.ok) return allowed;
    params.push(skuId);
    filter = ` AND l.sku_id = $${params.length}`;
  }
  const rows = await query<Record<string, unknown>>(
    getPool(),
    `SELECT l.*, p.name AS product_name, s.spec_name, m.name AS merchant_name
     FROM ledger l
     JOIN skus s ON s.id = l.sku_id
     JOIN products p ON p.id = s.product_id
     JOIN merchants m ON m.id = l.merchant_id
     WHERE ${where.data.sql.replaceAll("l.merchant_id", "l.merchant_id")}${filter}
     ORDER BY l.created_at DESC LIMIT 200`,
    params,
  );
  return {
    ok: true,
    data: {
      entries: rows.map((row) => ({
        id: row.id,
        merchantName: row.merchant_name,
        productName: row.product_name,
        specName: row.spec_name,
        movementType: row.movement_type,
        movementLabel: row.movement_type === "purchase_in" ? "采购入库" : row.movement_type === "order_reserve" ? "下单预占" : row.movement_type === "reserve_release" ? "释放预占" : "销售出库",
        qtyDelta: row.qty_base_delta,
        qtyAfter: row.on_hand_after,
        unitLabel: row.unit_label,
        onHandAfter: row.on_hand_after,
        reservedAfter: row.reserved_after,
        availableAfter: row.available_after,
        refDocId: row.ref_doc_id,
        actorName: row.actor_name,
        note: row.note,
        createdAt: iso(row.created_at as string),
      })),
    },
  };
}

export async function listInbound(actor: Actor): Promise<Result<{ docs: Array<Record<string, unknown>> }>> {
  const where = scope(actor, "d.merchant_id", "m.group_id");
  if (!where.ok) return where;
  const rows = await query<Record<string, unknown>>(
    getPool(),
    `SELECT d.*, p.name AS product_name, s.spec_name, m.name AS merchant_name
     FROM inbound_docs d
     JOIN skus s ON s.id = d.sku_id
     JOIN products p ON p.id = d.product_id
     JOIN merchants m ON m.id = d.merchant_id
     WHERE ${where.data.sql} ORDER BY d.created_at DESC LIMIT 100`,
    where.data.params,
  );
  return {
    ok: true,
    data: {
      docs: rows.map((row) => ({
        id: row.id,
        merchantName: row.merchant_name,
        productName: row.product_name,
        specName: row.spec_name,
        qty: row.qty_in_unit,
        qtyBase: row.qty_base,
        unitLabel: row.unit_label,
        ratio: `${row.to_base_numerator}/${row.to_base_denominator}`,
        actorName: row.actor_name,
        note: row.note,
        createdAt: iso(row.created_at as string),
      })),
    },
  };
}

export async function listOrders(actor: Actor): Promise<Result<{ orders: Array<Record<string, unknown>> }>> {
  const where = scope(actor, "o.merchant_id", "m.group_id");
  if (!where.ok) return where;
  const rows = await query<Record<string, unknown>>(
    getPool(),
    `SELECT o.*, p.name AS product_name, s.spec_name, m.name AS merchant_name
     FROM orders o
     JOIN skus s ON s.id = o.sku_id
     JOIN products p ON p.id = o.product_id
     JOIN merchants m ON m.id = o.merchant_id
     WHERE ${where.data.sql.replaceAll("o.merchant_id", "o.merchant_id")}
     ORDER BY o.created_at DESC LIMIT 100`,
    where.data.params,
  );
  return {
    ok: true,
    data: {
      orders: rows.map((row) => ({
        id: row.id,
        status: row.status,
        merchantName: row.merchant_name,
        productName: row.product_name,
        specName: row.spec_name,
        qty: row.qty_in_unit,
        unitLabel: row.unit_label,
        qtyBase: row.qty_base,
        qtyFulfilledBase: row.qty_fulfilled_base,
        timeoutDurationValue: row.timeout_duration_value,
        timeoutDurationUnit: row.timeout_duration_unit,
        timeoutAt: row.timeout_at ? iso(row.timeout_at as string) : null,
        timeoutJudgeSource: row.timeout_judge_source,
        buyerLabel: row.buyer_label,
        floorPriceCents: row.floor_price_cents,
        commissionBps: row.commission_bps,
        platformPriceCents: row.platform_price_cents,
        quoteId: row.quote_id,
        ratio: `${row.to_base_numerator}/${row.to_base_denominator}`,
        createdAt: iso(row.created_at as string),
      })),
    },
  };
}

export async function ensureCommission(merchantId: string): Promise<void> {
  await exec(getPool(), "INSERT INTO merchant_commission (merchant_id) VALUES ($1) ON CONFLICT (merchant_id) DO NOTHING", [merchantId]);
}
