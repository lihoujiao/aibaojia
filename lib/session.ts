import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const COOKIE = "nq_session";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionCookieName(): string {
  return COOKIE;
}

export function getSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 16) {
      throw new Error("SESSION_SECRET 至少需要 16 个字符");
    }
    return fromEnv;
  }
  const dir = path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "dev-session-secret");
  if (existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored.length >= 16) return stored;
  }
  const created = randomBytes(32).toString("base64url");
  writeFileSync(file, `${created}\n`, { mode: 0o600 });
  return created;
}

export function signSession(userId: string, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ userId, exp: now + SEVEN_DAYS_MS })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readSession(token: string, secret: string, now = Date.now()): { userId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      userId?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.userId !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp < now) return null;
    return { userId: parsed.userId };
  } catch {
    return null;
  }
}

export function sessionSetCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SEVEN_DAYS_MS / 1000)}`;
}

export function sessionClearCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return rest.join("=");
  }
  return null;
}
