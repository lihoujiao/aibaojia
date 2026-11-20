import { createHash, randomBytes } from "node:crypto";
import Dypnsapi, {
  CheckSmsVerifyCodeRequest,
  SendSmsVerifyCodeRequest,
} from "@alicloud/dypnsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";

export const DYPNS_API_VERSION = "2017-05-25";
export const DYPNS_ENDPOINT = "dypnsapi.aliyuncs.com";
const PLATFORM_CODE_PLACEHOLDER = "##code##";

export type DypnsConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  signName: string;
  templateCode: string;
  templateParam: string;
  schemeName?: string;
  countryCode?: string;
  endpoint: string;
};

export type SendAcceptance = {
  provider: "dypns";
  api: "SendSmsVerifyCode";
  acceptanceCode: string | null;
  acceptanceSuccess: boolean;
  requestId: string | null;
  bizId: string | null;
  outId: string;
};

export type VerifyOutcome = {
  provider: "dypns";
  api: "CheckSmsVerifyCode";
  requestId: string | null;
  verifyResult: "PASS" | "UNKNOWN";
  passed: boolean;
};

type DypnsClient = {
  sendSmsVerifyCode(request: SendSmsVerifyCodeRequest): Promise<{ body?: { code?: string; requestId?: string; success?: boolean; model?: { bizId?: string; verifyCode?: string } } }>;
  checkSmsVerifyCode(request: CheckSmsVerifyCodeRequest): Promise<{ body?: { code?: string; requestId?: string; success?: boolean; model?: { verifyResult?: string } } }>;
};

let injected: DypnsClient | null = null;

export function injectDypnsClientForTests(client: DypnsClient | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境不能注入测试客户端");
  }
  injected = client;
}

export function readDypnsConfig(): { ok: true; config: DypnsConfig } | { ok: false; missing: string[] } {
  const required = [
    "ALIYUN_DYPNS_ACCESS_KEY_ID",
    "ALIYUN_DYPNS_ACCESS_KEY_SECRET",
    "ALIYUN_DYPNS_SIGN_NAME",
    "ALIYUN_DYPNS_TEMPLATE_CODE",
    "ALIYUN_DYPNS_TEMPLATE_PARAM",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) return { ok: false, missing: [...missing] };
  const templateParam = process.env.ALIYUN_DYPNS_TEMPLATE_PARAM!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(templateParam);
  } catch {
    return { ok: false, missing: ["ALIYUN_DYPNS_TEMPLATE_PARAM_JSON"] };
  }
  const values = parsed && typeof parsed === "object" ? Object.values(parsed as Record<string, unknown>) : [];
  if (!values.some((value) => typeof value === "string" && value.includes(PLATFORM_CODE_PLACEHOLDER))) {
    return { ok: false, missing: ["ALIYUN_DYPNS_TEMPLATE_PARAM_##code##"] };
  }
  return {
    ok: true,
    config: {
      accessKeyId: process.env.ALIYUN_DYPNS_ACCESS_KEY_ID!.trim(),
      accessKeySecret: process.env.ALIYUN_DYPNS_ACCESS_KEY_SECRET!.trim(),
      securityToken: process.env.ALIYUN_DYPNS_SECURITY_TOKEN?.trim() || undefined,
      signName: process.env.ALIYUN_DYPNS_SIGN_NAME!.trim(),
      templateCode: process.env.ALIYUN_DYPNS_TEMPLATE_CODE!.trim(),
      templateParam,
      schemeName: process.env.ALIYUN_DYPNS_SCHEME_NAME?.trim() || undefined,
      countryCode: process.env.ALIYUN_DYPNS_COUNTRY_CODE?.trim() || undefined,
      endpoint: DYPNS_ENDPOINT,
    },
  };
}

function clientFor(config: DypnsConfig): DypnsClient {
  if (injected) return injected;
  const sdkConfig = new $OpenApiUtil.Config({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    securityToken: config.securityToken,
    endpoint: config.endpoint,
    protocol: "https",
    readTimeout: 10_000,
    connectTimeout: 5_000,
  });
  return new Dypnsapi(sdkConfig);
}

export function phoneHash(phone: string): string {
  return createHash("sha256").update(`dypns:${phone}`).digest("hex");
}

export async function sendDypnsVerifyCode(phoneNumber: string): Promise<SendAcceptance> {
  const config = readDypnsConfig();
  if (!config.ok) {
    throw Object.assign(new Error("号码认证配置未就绪"), { code: "SMS_NOT_CONFIGURED", missing: config.missing });
  }
  const outId = `out_${randomBytes(8).toString("hex")}`;
  const request = new SendSmsVerifyCodeRequest({
    phoneNumber,
    signName: config.config.signName,
    templateCode: config.config.templateCode,
    templateParam: config.config.templateParam,
    schemeName: config.config.schemeName,
    countryCode: config.config.countryCode,
    outId,
    returnVerifyCode: false,
    autoRetry: 0,
  });
  const response = await clientFor(config.config).sendSmsVerifyCode(request);
  if (response.body?.model) {
    delete response.body.model.verifyCode;
  }
  const acceptanceSuccess = response.body?.code === "OK" && response.body.success === true;
  return {
    provider: "dypns",
    api: "SendSmsVerifyCode",
    acceptanceCode: response.body?.code ?? null,
    acceptanceSuccess,
    requestId: response.body?.requestId ?? null,
    bizId: response.body?.model?.bizId ?? null,
    outId,
  };
}

export async function checkDypnsVerifyCode(phoneNumber: string, verifyCode: string): Promise<VerifyOutcome> {
  const config = readDypnsConfig();
  if (!config.ok) {
    throw Object.assign(new Error("号码认证配置未就绪"), { code: "SMS_NOT_CONFIGURED", missing: config.missing });
  }
  const request = new CheckSmsVerifyCodeRequest({
    phoneNumber,
    verifyCode,
    schemeName: config.config.schemeName,
    countryCode: config.config.countryCode,
  });
  const response = await clientFor(config.config).checkSmsVerifyCode(request);
  const verifyResult = response.body?.model?.verifyResult === "PASS" ? "PASS" : "UNKNOWN";
  return {
    provider: "dypns",
    api: "CheckSmsVerifyCode",
    requestId: response.body?.requestId ?? null,
    verifyResult,
    passed: response.body?.code === "OK" && response.body.success === true && verifyResult === "PASS",
  };
}
