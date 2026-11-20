import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exec, one, query } from "./db";
import { OTP_LIMITS } from "./rules";
import { checkDypnsVerifyCode, phoneHash, readDypnsConfig, sendDypnsVerifyCode } from "./sms/dypns";

type TestCode = { code: string; expiresAt: number; used: boolean; attempts: number };

const testCodes = new Map<string, TestCode>();

export function otpMode(): "test" | "dypns" | "closed" {
  if (process.env.NODE_ENV === "production") return process.env.OTP_DELIVERY === "test" ? "closed" : "dypns";
  if (process.env.OTP_DELIVERY === "test") return "test";
  return "dypns";
}

function pepper(): string {
  const fromEnv = process.env.OTP_PEPPER?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须注入 OTP_PEPPER");
  }
  const dir = path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "dev-otp-pepper");
  if (existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored.length >= 16) return stored;
  }
  const created = randomInt(0, 2 ** 30).toString(36) + randomInt(0, 2 ** 30).toString(36);
  writeFileSync(file, `${created}\n`, { mode: 0o600 });
  return created;
}

function hashCode(code: string): string {
  return createHmac("sha256", pepper()).update(code).digest("hex");
}

export function normalizePhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.trim().replace(/^\+86/, "").replace(/^86/, "");
  if (!/^1\d{10}$/.test(digits)) return null;
  return digits;
}

export function readTestOtp(phone: string): string | null {
  if (otpMode() !== "test") return null;
  const row = testCodes.get(phone);
  if (!row || row.used || row.expiresAt <= Date.now()) return null;
  return row.code;
}

export function expireTestOtp(phone: string): void {
  const row = testCodes.get(phone);
  if (row) row.expiresAt = Date.now() - 1_000;
}

async function tooMany(phoneHashValue: string, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - OTP_LIMITS.windowMs).toISOString();
  const byPhone = await one<{ c: string }>(
    (await import("./db")).getPool(),
    "SELECT COUNT(*)::text AS c FROM otp_requests WHERE phone_hash = $1 AND created_at >= $2",
    [phoneHashValue, since],
  );
  const byIp = await one<{ c: string }>(
    (await import("./db")).getPool(),
    "SELECT COUNT(*)::text AS c FROM otp_requests WHERE ip = $1 AND created_at >= $2",
    [ip, since],
  );
  return Number(byPhone?.c ?? 0) >= OTP_LIMITS.maxSendsPerPhone || Number(byIp?.c ?? 0) >= OTP_LIMITS.maxSendsPerIp;
}

export async function requestOtp(phone: string, ip: string, registered: boolean): Promise<
  | { ok: true; limited: boolean }
  | { ok: false; code: "SMS_NOT_CONFIGURED" | "RATE_LIMITED"; message: string }
> {
  const mode = otpMode();
  if (mode === "closed" || (mode === "dypns" && !readDypnsConfig().ok)) {
    return {
      ok: false,
      code: "SMS_NOT_CONFIGURED",
      message: "号码认证尚未配置完成，不能发送验证码，也不会改用模拟短信。",
    };
  }
  const hashed = phoneHash(phone);
  if (await tooMany(hashed, ip)) {
    return { ok: false, code: "RATE_LIMITED", message: "发送过于频繁，请稍后再试。" };
  }
  const requestId = `req_${hashed.slice(0, 8)}_${Date.now()}`;
  if (!registered) {
    await exec(
      (await import("./db")).getPool(),
      "INSERT INTO otp_requests (id, phone_hash, ip, created_at, challenge_id) VALUES ($1, $2, $3, NOW(), NULL)",
      [requestId, hashed, ip],
    );
    return { ok: true, limited: false };
  }
  if (mode === "test") {
    const code = String(randomInt(0, 1_000_000)).padStart(OTP_LIMITS.codeDigits, "0");
    testCodes.set(phone, {
      code,
      expiresAt: Date.now() + OTP_LIMITS.ttlMs,
      used: false,
      attempts: 0,
    });
    await exec(
      (await import("./db")).getPool(),
      "INSERT INTO otp_requests (id, phone_hash, ip, created_at, challenge_id) VALUES ($1, $2, $3, NOW(), $4)",
      [requestId, hashed, ip, "test"],
    );
    await exec(
      (await import("./db")).getPool(),
      `INSERT INTO sms_events (id, kind, phone_hash, provider, out_id, acceptance_code, acceptance_success, request_id, biz_id, verify_result, created_at)
       VALUES ($1, 'send_acceptance', $2, 'test', NULL, 'TEST_ONLY', true, NULL, NULL, NULL, NOW())`,
      [`evt_${requestId}`, hashed],
    );
    return { ok: true, limited: false };
  }
  const acceptance = await sendDypnsVerifyCode(phone);
  await exec(
    (await import("./db")).getPool(),
    "INSERT INTO otp_requests (id, phone_hash, ip, created_at, challenge_id) VALUES ($1, $2, $3, NOW(), $4)",
    [requestId, hashed, ip, acceptance.outId],
  );
  await exec(
    (await import("./db")).getPool(),
    `INSERT INTO sms_events (id, kind, phone_hash, provider, out_id, acceptance_code, acceptance_success, request_id, biz_id, verify_result, created_at)
     VALUES ($1, 'send_acceptance', $2, 'dypns', $3, $4, $5, $6, $7, NULL, NOW())`,
    [
      `evt_${acceptance.outId}`,
      hashed,
      acceptance.outId,
      acceptance.acceptanceCode,
      acceptance.acceptanceSuccess,
      acceptance.requestId,
      acceptance.bizId,
    ],
  );
  if (!acceptance.acceptanceSuccess) {
    return { ok: false, code: "SMS_NOT_CONFIGURED", message: "号码认证没有受理这次发送。验证码是否送达尚不清楚，没有自动重发。" };
  }
  return { ok: true, limited: false };
}

async function failedVerifies(phoneHashValue: string): Promise<number> {
  const since = new Date(Date.now() - OTP_LIMITS.windowMs).toISOString();
  const row = await one<{ c: string }>(
    (await import("./db")).getPool(),
    "SELECT COUNT(*)::text AS c FROM otp_verify_attempts WHERE phone_hash = $1 AND success = false AND created_at >= $2",
    [phoneHashValue, since],
  );
  return Number(row?.c ?? 0);
}

export async function verifyOtp(phone: string, code: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const mode = otpMode();
  const hashed = phoneHash(phone);
  if (mode === "closed" || (mode === "dypns" && !readDypnsConfig().ok)) {
    return { ok: false, code: "SMS_NOT_CONFIGURED", message: "号码认证尚未配置完成，不能核验验证码。" };
  }
  if (await failedVerifies(hashed) >= OTP_LIMITS.maxAttempts) {
    return { ok: false, code: "RATE_LIMITED", message: "错误次数过多，请稍后再试。" };
  }
  let passed = false;
  let verifyResult = "UNKNOWN";
  let provider: "test" | "dypns" = mode === "test" ? "test" : "dypns";
  if (mode === "test") {
    const row = testCodes.get(phone);
    if (!row) {
      verifyResult = "UNKNOWN";
    } else if (row.expiresAt <= Date.now()) {
      verifyResult = "EXPIRED";
    } else if (row.used) {
      verifyResult = "REUSED";
    } else if (row.attempts >= OTP_LIMITS.maxAttempts) {
      verifyResult = "LOCKED";
    } else {
      const given = Buffer.from(hashCode(code));
      const expected = Buffer.from(hashCode(row.code));
      const match = given.length === expected.length && timingSafeEqual(given, expected);
      row.attempts += 1;
      if (!match) verifyResult = "WRONG";
      else {
        row.used = true;
        passed = true;
        verifyResult = "PASS";
      }
    }
  } else {
    const outcome = await checkDypnsVerifyCode(phone, code);
    provider = "dypns";
    verifyResult = outcome.verifyResult;
    passed = outcome.passed;
  }
  await exec(
    (await import("./db")).getPool(),
    "INSERT INTO otp_verify_attempts (id, phone_hash, success, created_at) VALUES ($1, $2, $3, NOW())",
    [`ver_${hashed.slice(0, 10)}_${Date.now()}`, hashed, passed],
  );
  await exec(
    (await import("./db")).getPool(),
    `INSERT INTO sms_events (id, kind, phone_hash, provider, out_id, acceptance_code, acceptance_success, request_id, biz_id, verify_result, created_at)
     VALUES ($1, 'verify_result', $2, $3, NULL, NULL, NULL, NULL, NULL, $4, NOW())`,
    [`evt_v_${hashed.slice(0, 8)}_${Date.now()}`, hashed, provider, verifyResult],
  );
  if (!passed) return { ok: false, code: "OTP_REJECTED", message: "验证码不正确、已过期或已使用。" };
  return { ok: true };
}

export async function recentSmsEvents(phone: string): Promise<Array<Record<string, unknown>>> {
  return query(
    (await import("./db")).getPool(),
    "SELECT kind, provider, acceptance_code, acceptance_success, verify_result, request_id, biz_id, out_id, created_at FROM sms_events WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 20",
    [phoneHash(phone)],
  );
}
