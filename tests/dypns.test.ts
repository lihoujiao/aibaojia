import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckSmsVerifyCodeRequest, SendSmsVerifyCodeRequest } from "@alicloud/dypnsapi20170525";
import { checkDypnsVerifyCode, injectDypnsClientForTests, readDypnsConfig, sendDypnsVerifyCode } from "../lib/sms/dypns";

test("缺配置时 fail-closed，不调用号码认证", async () => {
  const previous = {
    id: process.env.ALIYUN_DYPNS_ACCESS_KEY_ID,
    secret: process.env.ALIYUN_DYPNS_ACCESS_KEY_SECRET,
    sign: process.env.ALIYUN_DYPNS_SIGN_NAME,
    template: process.env.ALIYUN_DYPNS_TEMPLATE_CODE,
    param: process.env.ALIYUN_DYPNS_TEMPLATE_PARAM,
  };
  delete process.env.ALIYUN_DYPNS_ACCESS_KEY_ID;
  delete process.env.ALIYUN_DYPNS_SIGN_NAME;
  delete process.env.ALIYUN_DYPNS_TEMPLATE_CODE;
  delete process.env.ALIYUN_DYPNS_TEMPLATE_PARAM;
  const config = readDypnsConfig();
  assert.equal(config.ok, false);
  await assert.rejects(() => sendDypnsVerifyCode("13800000001"), /配置未就绪/);
  for (const [key, value] of Object.entries({
    ALIYUN_DYPNS_ACCESS_KEY_ID: previous.id,
    ALIYUN_DYPNS_ACCESS_KEY_SECRET: previous.secret,
    ALIYUN_DYPNS_SIGN_NAME: previous.sign,
    ALIYUN_DYPNS_TEMPLATE_CODE: previous.template,
    ALIYUN_DYPNS_TEMPLATE_PARAM: previous.param,
  })) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
});

test("注入的客户端只证明请求形状，不代表真实发送", async () => {
  process.env.ALIYUN_DYPNS_ACCESS_KEY_ID = "test-key-id";
  process.env.ALIYUN_DYPNS_ACCESS_KEY_SECRET = "test-key-secret";
  process.env.ALIYUN_DYPNS_SIGN_NAME = "待核验签名";
  process.env.ALIYUN_DYPNS_TEMPLATE_CODE = "待核验模板";
  process.env.ALIYUN_DYPNS_TEMPLATE_PARAM = JSON.stringify({ token: "##code##", minutes: "9" });
  const captured: { request?: SendSmsVerifyCodeRequest } = {};
  injectDypnsClientForTests({
    async sendSmsVerifyCode(request) {
      captured.request = request;
      return { body: { code: "OK", success: true, requestId: "req-test", model: { bizId: "biz-test", verifyCode: "SHOULD_NOT_LEAK" } } };
    },
    async checkSmsVerifyCode() {
      return { body: { code: "OK", success: true, requestId: "req-check", model: { verifyResult: "UNKNOWN" } } };
    },
  });
  const acceptance = await sendDypnsVerifyCode("13800000001");
  assert.equal(acceptance.acceptanceSuccess, true);
  assert.equal(acceptance.api, "SendSmsVerifyCode");
  assert.equal(JSON.stringify(acceptance).includes("SHOULD_NOT_LEAK"), false);
  assert.equal(captured.request?.signName, "待核验签名");
  assert.equal(captured.request?.templateCode, "待核验模板");
  assert.equal(captured.request?.templateParam, "{\"token\":\"##code##\",\"minutes\":\"9\"}");
  assert.equal(captured.request?.returnVerifyCode, false);
  assert.equal(captured.request?.autoRetry, 0);
  const checked = await checkDypnsVerifyCode("13800000001", "0000");
  assert.equal(checked.api, "CheckSmsVerifyCode");
  assert.equal(checked.passed, false);
  assert.equal(checked.verifyResult, "UNKNOWN");
  injectDypnsClientForTests(null);
  delete process.env.ALIYUN_DYPNS_ACCESS_KEY_ID;
  delete process.env.ALIYUN_DYPNS_ACCESS_KEY_SECRET;
  delete process.env.ALIYUN_DYPNS_SIGN_NAME;
  delete process.env.ALIYUN_DYPNS_TEMPLATE_CODE;
  delete process.env.ALIYUN_DYPNS_TEMPLATE_PARAM;
  void CheckSmsVerifyCodeRequest;
});

test("生产模式禁止测试适配器", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  process.env.OTP_DELIVERY = "test";
  const { otpMode } = await import("../lib/otp");
  assert.equal(otpMode(), "closed");
  if (previous === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = previous;
  process.env.OTP_DELIVERY = "test";
});
