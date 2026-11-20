import { randomBytes } from "node:crypto";
import { exec, one, query, transaction, type Db } from "./db";

export type ReleaseReason = "cancelled" | "timed_out";
export type JudgeSource = "automatic" | "event";

type LockedOrder = {
  id: string;
  merchant_id: string;
  sku_id: string;
  status: "reserved" | "fulfilled" | "cancelled" | "timed_out";
  qty_base: number;
  qty_fulfilled_base: number;
  unit_label: string;
  to_base_numerator: number;
  to_base_denominator: number;
  rounding_mode: string;
  timeout_at: Date | string | null;
};

export type ReleaseResult = {
  status: string;
  alreadyReleased: boolean;
  onHandBase: number;
  reservedBase: number;
  releasedBase: number;
};

function nid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export async function applyReservationRelease(
  client: Db,
  orderId: string,
  reason: ReleaseReason,
  actor: { userId: string; displayName: string },
  source: JudgeSource,
): Promise<ReleaseResult> {
  const lockedOrder = await one<LockedOrder>(client, "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
  if (!lockedOrder) throw new Error("missing order");
  const stock = await one<{ on_hand_base: number; reserved_base: number }>(
    client,
    "SELECT on_hand_base, reserved_base FROM inventory WHERE sku_id = $1 FOR UPDATE",
    [lockedOrder.sku_id],
  );
  if (!stock) throw new Error("missing inventory");
  if (lockedOrder.status === "cancelled" || lockedOrder.status === "timed_out") {
    return {
      status: lockedOrder.status,
      alreadyReleased: true,
      onHandBase: stock.on_hand_base,
      reservedBase: stock.reserved_base,
      releasedBase: 0,
    };
  }
  if (lockedOrder.status === "fulfilled" || lockedOrder.qty_fulfilled_base >= lockedOrder.qty_base) {
    return {
      status: lockedOrder.status,
      alreadyReleased: true,
      onHandBase: stock.on_hand_base,
      reservedBase: stock.reserved_base,
      releasedBase: 0,
    };
  }
  const remaining = lockedOrder.qty_base - lockedOrder.qty_fulfilled_base;
  if (stock.reserved_base < remaining) throw new Error("INVENTORY_INVARIANT");
  const reservedBase = stock.reserved_base - remaining;
  await exec(client, "UPDATE inventory SET reserved_base = $2 WHERE sku_id = $1", [lockedOrder.sku_id, reservedBase]);
  if (reason === "timed_out") {
    await exec(
      client,
      "UPDATE orders SET status = 'timed_out', timeout_judge_source = $2, timeout_judged_at = NOW() WHERE id = $1",
      [orderId, source],
    );
  } else {
    await exec(client, "UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
  }
  const note = reason === "cancelled"
    ? `取消订单，立即释放未出库预占 ${remaining} 个基准单位。已出库部分不回滚。`
    : source === "automatic"
      ? `到期自动判定超时，立即释放未出库预占 ${remaining} 个基准单位。依据是下单时快照的截止时间，已出库部分不回滚。`
      : `订单被判定超时，立即释放未出库预占 ${remaining} 个基准单位。不保留挂起。`;
  await exec(
    client,
    `INSERT INTO ledger (
       id, merchant_id, sku_id, movement_type, qty_base_delta, reserved_delta, on_hand_after, reserved_after, available_after,
       unit_label, qty_in_unit, to_base_numerator, to_base_denominator, rounding_mode, ref_doc_type, ref_doc_id,
       actor_user_id, actor_name, note, created_at
     ) VALUES ($1,$2,$3,'reserve_release',0,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
    [
      nid("led"),
      lockedOrder.merchant_id,
      lockedOrder.sku_id,
      -remaining,
      stock.on_hand_base,
      reservedBase,
      stock.on_hand_base - reservedBase,
      lockedOrder.unit_label,
      lockedOrder.to_base_numerator,
      lockedOrder.to_base_denominator,
      lockedOrder.rounding_mode,
      reason,
      orderId,
      actor.userId,
      actor.displayName,
      note,
    ],
  );
  if (reason === "timed_out") {
    await exec(
      client,
      `INSERT INTO timeout_judge_events (id, order_id, merchant_id, source, released_base, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [nid("tje"), orderId, lockedOrder.merchant_id, source, remaining],
    );
  }
  return {
    status: reason,
    alreadyReleased: false,
    onHandBase: stock.on_hand_base,
    reservedBase,
    releasedBase: remaining,
  };
}

export async function judgeDueTimeouts(asOf: Date = new Date()): Promise<{
  skippedLock: boolean;
  judged: Array<{ orderId: string; merchantId: string; releasedBase: number }>;
}> {
  return transaction(async (client) => {
    const lock = await one<{ locked: boolean }>(client, "SELECT pg_try_advisory_xact_lock(hashtext('native-quote-timeout-judge')) AS locked");
    if (!lock?.locked) return { skippedLock: true, judged: [] };
    const due = await query<{ id: string; merchant_id: string }>(
      client,
      `SELECT id, merchant_id FROM orders
       WHERE status = 'reserved' AND timeout_at IS NOT NULL AND timeout_at <= $1
       ORDER BY timeout_at, id
       FOR UPDATE SKIP LOCKED`,
      [asOf.toISOString()],
    );
    const judged: Array<{ orderId: string; merchantId: string; releasedBase: number }> = [];
    for (const row of due) {
      const released = await applyReservationRelease(
        client,
        row.id,
        "timed_out",
        { userId: "system:timeout-judge", displayName: "系统自动判定" },
        "automatic",
      );
      if (!released.alreadyReleased) {
        judged.push({ orderId: row.id, merchantId: row.merchant_id, releasedBase: released.releasedBase });
      }
    }
    return { skippedLock: false, judged };
  });
}

export const TIMEOUT_SCAN_INTERVAL_MS = 15_000;

const globalState = globalThis as { __nativeQuoteTimeoutJudge?: boolean; __nativeQuoteTimeoutTimer?: ReturnType<typeof setInterval> };
let latestTick: Promise<void> = Promise.resolve();

function runTick(): Promise<void> {
  latestTick = judgeDueTimeouts()
    .then(() => undefined)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown";
      console.error(`timeout judge failed: ${message}`);
    });
  return latestTick;
}

export function startTimeoutJudgeLoop(intervalMs = TIMEOUT_SCAN_INTERVAL_MS): void {
  if (globalState.__nativeQuoteTimeoutJudge) return;
  globalState.__nativeQuoteTimeoutJudge = true;
  void runTick();
  const timer = setInterval(() => {
    void runTick();
  }, intervalMs);
  timer.unref();
  globalState.__nativeQuoteTimeoutTimer = timer;
}

export function timeoutJudgeSettled(): Promise<void> {
  return latestTick;
}

export function stopTimeoutJudgeLoop(): void {
  const timer = globalState.__nativeQuoteTimeoutTimer;
  if (timer) clearInterval(timer);
  globalState.__nativeQuoteTimeoutTimer = undefined;
  globalState.__nativeQuoteTimeoutJudge = false;
}
