import { parentPort, workerData } from "node:worker_threads";

type Payload = { dbUrl: string; skuId: string; unitId: string; key: string };

async function main(): Promise<void> {
  const data = workerData as Payload;
  process.env.DATABASE_URL = data.dbUrl;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  process.env.OTP_DELIVERY = "test";
  const { getActorByPhone, placeOrder } = await import("../lib/domain");
  const actor = await getActorByPhone("13800000001");
  if (!actor) throw new Error("缺少示例商家甲");
  const result = await placeOrder(actor, {
    skuId: data.skuId,
    unitId: data.unitId,
    qty: 1,
    buyerLabel: "示例采购方",
    idempotencyKey: data.key,
  });
  parentPort?.postMessage(result.ok ? { ok: true } : { ok: false, code: result.code });
}

main().catch((error: unknown) => {
  parentPort?.postMessage({ ok: false, code: "THROW", message: error instanceof Error ? error.message : String(error) });
});
