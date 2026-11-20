import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { closePool, migrate } from "../lib/db";
import { handleRequestOtp, handleVerifyOtp } from "../lib/http/handlers";
import { readTestOtp } from "../lib/otp";
import { resetReady } from "../lib/runtime";
import { seed } from "../lib/seed";

(process.env as Record<string, string | undefined>).NODE_ENV = "development";
process.env.OTP_DELIVERY = "test";
process.env.SESSION_SECRET = "test-only-session-secret-32ch";
process.env.OTP_PEPPER = "test-only-otp-pepper-32chars";

const adminUrl = process.env.PG_ADMIN_URL ?? "postgres://quoteapp@127.0.0.1:5432/postgres";

export const PHONES = {
  merchantA: "13800000001",
  merchantB: "13800000002",
  group: "13800000003",
  platform: "13800000004",
  service: "13800000005",
};

export async function tempDb(): Promise<{ cleanup: () => Promise<void> }> {
  const name = `quote_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  process.env.DATABASE_URL = `postgres://quoteapp@127.0.0.1:5432/${name}`;
  await closePool();
  resetReady();
  await migrate();
  await seed();
  return {
    async cleanup() {
      await closePool();
      const drop = new Client({ connectionString: adminUrl });
      await drop.connect();
      await drop.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
      await drop.query(`DROP DATABASE ${name}`);
      await drop.end();
    },
  };
}

export async function login(phone: string): Promise<string> {
  const requested = await handleRequestOtp(
    new Request("http://local/api/auth/otp/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    }),
  );
  if (!requested.ok) throw new Error(`请求验证码失败 ${requested.status}`);
  const code = readTestOtp(phone);
  if (!code) throw new Error("测试适配器没有验证码");
  const verified = await handleVerifyOtp(
    new Request("http://local/api/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code }),
    }),
  );
  if (!verified.ok) throw new Error(`验证码登录失败 ${verified.status}`);
  const cookie = verified.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("没有会话");
  return cookie;
}

export function authed(pathname: string, cookie: string, init?: { method?: string; body?: unknown }): Request {
  const headers = new Headers({ cookie });
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  return new Request(`http://local${pathname}`, { method: init?.method ?? "GET", headers, body });
}

export async function readJson(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
