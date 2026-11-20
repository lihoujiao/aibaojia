import { parentPort, workerData } from "node:worker_threads";

async function main(): Promise<void> {
  const data = workerData as { dbUrl: string; orderId: string; key: string; amountCents: number };
  process.env.DATABASE_URL = data.dbUrl;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  process.env.OTP_DELIVERY = "test";
  const { getActorByPhone } = await import("../lib/domain");
  const { postRepayment } = await import("../lib/payments");
  const actor = await getActorByPhone("13800000001");
  if (!actor) throw new Error("缺少商家");
  const result = await postRepayment(actor, data.orderId, { amountCents: data.amountCents, paidOn: "2026-11-17", idempotencyKey: data.key });
  parentPort?.postMessage(result.ok ? { ok: true } : { ok: false, code: result.code });
}

main().catch((error: unknown) => {
  parentPort?.postMessage({ ok: false, code: error instanceof Error ? error.message : "THROW" });
});
