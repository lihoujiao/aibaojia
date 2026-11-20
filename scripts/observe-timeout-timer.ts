import { setTimeout as delay } from "node:timers/promises";

if (process.env.NODE_ENV === "production") {
  throw new Error("生产进程不跑这条观察脚本");
}

async function main(): Promise<void> {
  const { one } = await import("../lib/db");
  const { getActorByPhone, placeOrder } = await import("../lib/domain");
  const actor = await getActorByPhone("13800000001");
  if (!actor) throw new Error("缺少示例商家");
  const pool = (await import("../lib/db")).getPool();
  const sku = await one<{ id: string; unit_id: string; available: number }>(
    pool,
    `SELECT s.id, u.id AS unit_id, (i.on_hand_base - i.reserved_base) AS available
     FROM skus s
     JOIN inventory i ON i.sku_id = s.id
     JOIN product_units u ON u.product_id = s.product_id AND u.is_base
     WHERE s.merchant_id = 'merchant-a' AND s.spec_name = '一级果'`,
  );
  if (!sku || sku.available < 1) throw new Error("示例库存不足");
  const order = await placeOrder(actor, {
    skuId: sku.id,
    unitId: sku.unit_id,
    qty: 1,
    buyerLabel: "定时观察采购方",
    idempotencyKey: `observe-${Date.now()}`,
  });
  if (!order.ok) throw new Error(order.code);
  await pool.query("UPDATE orders SET timeout_at = NOW() - interval '1 second' WHERE id = $1 AND timeout_at IS NOT NULL", [order.data.id]);
  const snap = await one<{ value: number | null; unit: string | null; at: Date | null }>(
    pool,
    "SELECT timeout_duration_value AS value, timeout_duration_unit AS unit, timeout_at AS at FROM orders WHERE id = $1",
    [order.data.id],
  );
  if (!snap?.at) throw new Error("这张订单没有快照截止时间，运行中的扫描不应释放它");
  const started = Date.now();
  let status = "reserved";
  let source: string | null = null;
  while (Date.now() - started < 22_000) {
    const row = await one<{ status: string; source: string | null }>(pool, "SELECT status, timeout_judge_source AS source FROM orders WHERE id = $1", [order.data.id]);
    status = row?.status ?? "";
    source = row?.source ?? null;
    if (status === "timed_out") break;
    await delay(500);
  }
  const events = await one<{ c: string }>(pool, "SELECT COUNT(*)::text AS c FROM timeout_judge_events WHERE order_id = $1", [order.data.id]);
  console.log(JSON.stringify({
    status,
    source,
    events: events?.c ?? "0",
    elapsedMs: Date.now() - started,
    snapshotValue: snap.value,
    snapshotUnit: snap.unit,
  }));
  if (status !== "timed_out" || source !== "automatic" || events?.c !== "1") {
    throw new Error("运行中的扫描没有在一个周期内完成判定和释放");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "observe failed");
  process.exit(1);
});
