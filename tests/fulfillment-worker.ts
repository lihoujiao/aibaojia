import { parentPort, workerData } from "node:worker_threads";

async function main(): Promise<void> {
  const data = workerData as { dbUrl: string; orderId: string; action: "ship" | "cancel" };
  process.env.DATABASE_URL = data.dbUrl;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  process.env.OTP_DELIVERY = "test";
  const { confirmOutbound, getActorByPhone, releaseReservation } = await import("../lib/domain");
  const actor = await getActorByPhone("13800000001");
  if (!actor) throw new Error("缺少示例商家甲");
  const result = data.action === "ship"
    ? await confirmOutbound(actor, data.orderId, { qty: 6, idempotencyKey: "race-ship" })
    : await releaseReservation(actor, data.orderId, "cancelled");
  parentPort?.postMessage(result.ok ? { ok: true } : { ok: false, code: result.code });
}

main().catch((error: unknown) => {
  parentPort?.postMessage({ ok: false, code: "THROW", message: error instanceof Error ? error.message : String(error) });
});
