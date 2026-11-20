import { one, exec } from "./db";
import { createProduct, createQuote, createSku, ensureCommission, getActorByPhone, receiveInbound } from "./domain";
import { VIRTUAL_PHONES } from "./rules";

async function must<T>(result: { ok: true; data: T } | { ok: false; message: string }, label: string): Promise<T> {
  if (!result.ok) throw new Error(`${label}失败：${result.message}`);
  return result.data;
}

export async function seed(): Promise<void> {
  const marker = await one<{ value: string }>( (await import("./db")).getPool(), "SELECT value FROM schema_meta WHERE key = 'demo_seed'");
  if (marker) return;
  const users = await one<{ c: string }>( (await import("./db")).getPool(), "SELECT COUNT(*)::text AS c FROM users");
  if (users && Number(users.c) > 0) throw new Error("示例数据不完整。请运行 npm run db:reset。");
  const pool = (await import("./db")).getPool();
  await exec(pool, "INSERT INTO groups (id, name) VALUES ('group-demo', '示例农业集团')");
  await exec(pool, "INSERT INTO merchants (id, name, group_id, created_at) VALUES ('merchant-a', '示例商家甲', 'group-demo', NOW())");
  await exec(pool, "INSERT INTO merchants (id, name, group_id, created_at) VALUES ('merchant-b', '示例商家乙', NULL, NOW())");
  const people = [
    ["user-merchant-a", "示例商家甲", "merchant", "merchant-a", null, VIRTUAL_PHONES[0].phone],
    ["user-merchant-b", "示例商家乙", "merchant", "merchant-b", null, VIRTUAL_PHONES[1].phone],
    ["user-group", "示例农业集团", "group", null, "group-demo", VIRTUAL_PHONES[2].phone],
    ["user-platform", "平台管理员", "platform", null, null, VIRTUAL_PHONES[3].phone],
    ["user-cs", "客服示例", "customer_service", null, null, VIRTUAL_PHONES[4].phone],
  ] as const;
  for (const person of people) {
    await exec(
      pool,
      "INSERT INTO users (id, display_name, role, merchant_id, group_id, phone, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
      [...person],
    );
  }
  await ensureCommission("merchant-a");
  await ensureCommission("merchant-b");
  const merchantA = await getActorByPhone(VIRTUAL_PHONES[0].phone);
  const merchantB = await getActorByPhone(VIRTUAL_PHONES[1].phone);
  if (!merchantA || !merchantB) throw new Error("示例账号没有写入成功");
  const apple = await must(
    await createProduct(merchantA, {
      name: "云南苹果",
      baseUnitLabel: "两",
      note: "示例商品，非真实货源。换算只属于本商品。",
      units: [
        { label: "斤", numerator: 10, denominator: 1 },
        { label: "箱", numerator: 200, denominator: 1 },
      ],
    }),
    "创建云南苹果",
  );
  const rice = await must(
    await createProduct(merchantB, {
      name: "优质大米",
      baseUnitLabel: "箱",
      note: "示例商品。这里的箱不等于苹果的箱。",
      units: [{ label: "件", numerator: 2, denominator: 1 }],
    }),
    "创建优质大米",
  );
  const appleSku = await must(await createSku(merchantA, { productId: apple.productId, specName: "一级果", note: "示例规格" }), "苹果规格");
  await must(await createSku(merchantA, { productId: apple.productId, specName: "家庭装", note: "示例规格" }), "家庭装");
  const riceSku = await must(await createSku(merchantB, { productId: rice.productId, specName: "示例规格", note: "示例规格" }), "大米规格");
  const now = Date.now();
  const day = 86_400_000;
  await must(
    await createQuote(merchantA, {
      skuId: appleSku.id,
      floorPriceCents: 68,
      validFrom: new Date(now - day).toISOString(),
      validUntil: new Date(now + 30 * day).toISOString(),
      note: "示例有效报价，按基准单位两计价",
    }),
    "苹果有效报价",
  );
  await must(
    await createQuote(
      merchantA,
      {
        skuId: appleSku.id,
        floorPriceCents: 62,
        validFrom: new Date(now - 10 * day).toISOString(),
        validUntil: new Date(now - day).toISOString(),
        note: "示例过期报价",
      },
      { createdAt: new Date(now - 1_000) },
    ),
    "苹果过期报价",
  );
  await must(
    await createQuote(merchantB, {
      skuId: riceSku.id,
      floorPriceCents: 8600,
      validFrom: new Date(now - day).toISOString(),
      validUntil: new Date(now + 30 * day).toISOString(),
      note: "示例报价，按基准单位箱计价",
    }),
    "大米报价",
  );
  const jin = appleSku.units.find((unit) => unit.unitLabel === "斤");
  const box = riceSku.units.find((unit) => unit.isBase);
  if (!jin || !box) throw new Error("示例单位没有生成");
  await must(await receiveInbound(merchantA, { skuId: appleSku.id, unitId: jin.id, qty: 80, note: "示例期初入库" }), "苹果入库");
  await must(await receiveInbound(merchantB, { skuId: riceSku.id, unitId: box.id, qty: 15, note: "示例期初入库" }), "大米入库");
  await exec(pool, "INSERT INTO schema_meta (key, value) VALUES ('demo_seed', '2')");
}
