import { parentPort, workerData } from "node:worker_threads";

async function main(): Promise<void> {
  const data = workerData as { dbUrl: string; orderId: string; agreementPriceCents: number };
  process.env.DATABASE_URL = data.dbUrl;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  process.env.OTP_DELIVERY = "test";
  const { getActorByPhone } = await import("../lib/domain");
  const { registerPaymentTerms } = await import("../lib/payments");
  const actor = await getActorByPhone("13800000001");
  if (!actor) throw new Error("缺少商家");
  const result = await registerPaymentTerms(actor, data.orderId, {
    method: "term",
    termDays: 12,
    capitalCostAnnualPercent: "5.25",
    overdueAnnualPercent: "8.00",
    agreementPriceCents: data.agreementPriceCents,
  });
  parentPort?.postMessage(result.ok ? { ok: true } : { ok: false, code: result.code });
}

main().catch((error: unknown) => {
  parentPort?.postMessage({ ok: false, code: error instanceof Error ? error.message : "THROW" });
});