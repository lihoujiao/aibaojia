import { parentPort, workerData } from "node:worker_threads";

async function main(): Promise<void> {
  const data = workerData as { dbUrl: string; orderId: string; action: "ship" | "judge" };
  process.env.DATABASE_URL = data.dbUrl;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  process.env.OTP_DELIVERY = "test";
  if (data.action === "judge") {
    const { judgeDueTimeouts } = await import("../lib/timeout-judge");
    const result = await judgeDueTimeouts(new Date(Date.now() + 86_400_000));
    parentPort?.postMessage({ ok: true, judged: result.judged.length, skippedLock: result.skippedLock });
    return;
  }
  const { confirmOutbound, getActorByPhone } = await import("../lib/domain");
  const actor = await getActorByPhone("13800000001");
  if (!actor) throw new Error("缺少示例商家甲");
  const result = await confirmOutbound(actor, data.orderId, { qty: 6, idempotencyKey: "race-timeout-ship" });
  parentPort?.postMessage(result.ok ? { ok: true } : { ok: false, code: result.code });
}

main().catch((error: unknown) => {
  parentPort?.postMessage({ ok: false, code: "THROW", message: error instanceof Error ? error.message : String(error) });
});
