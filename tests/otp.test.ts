import assert from "node:assert/strict";
import { after, test } from "node:test";
import { handleRequestOtp, handleVerifyOtp } from "../lib/http/handlers";
import { expireTestOtp, readTestOtp } from "../lib/otp";
import { PHONES, readJson, tempDb } from "./helpers";

const ctxPromise = tempDb();
after(async () => (await ctxPromise).cleanup());

function request(phone: string): Request {
  return new Request("http://local/api/auth/otp/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
}

function verify(phone: string, code: string): Request {
  return new Request("http://local/api/auth/otp/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, code }),
  });
}

test("错误、过期、复用和限流都会拒绝，响应不含验证码", async () => {
  await ctxPromise;
  const sent = await handleRequestOtp(request(PHONES.merchantA));
  const sentText = JSON.stringify(await sent.clone().json());
  assert.equal(sentText.includes("000000"), false);
  const code = readTestOtp(PHONES.merchantA);
  assert.ok(code);
  assert.equal(sentText.includes(code!), false);
  const wrong = await readJson(await handleVerifyOtp(verify(PHONES.merchantA, "000000")));
  assert.equal(wrong.status, 401);
  expireTestOtp(PHONES.merchantA);
  const expired = await readJson(await handleVerifyOtp(verify(PHONES.merchantA, code!)));
  assert.equal(expired.status, 401);
  await handleRequestOtp(request(PHONES.merchantA));
  const fresh = readTestOtp(PHONES.merchantA);
  assert.ok(fresh);
  const good = await readJson(await handleVerifyOtp(verify(PHONES.merchantA, fresh!)));
  assert.equal(good.status, 200);
  const reused = await readJson(await handleVerifyOtp(verify(PHONES.merchantA, fresh!)));
  assert.equal(reused.status, 401);
  for (let index = 0; index < 3; index += 1) await handleRequestOtp(request(PHONES.merchantB));
  const limited = await readJson(await handleRequestOtp(request(PHONES.merchantB)));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
});
