import {
  confirmOutbound,
  getTimeoutConfig,
  releaseReservation,
  setTimeoutConfig,
  createProduct,
  createQuote,
  createSku,
  getActorById,
  getActorByPhone,
  getCommission,
  getSkuDetail,
  listInbound,
  listLedger,
  listMerchants,
  listOrders,
  listQuotes,
  listSkus,
  placeOrder,
  receiveInbound,
  updateCommission,
  updateUnitRatio,
} from "../domain";
import { normalizePhone, requestOtp, verifyOtp } from "../otp";
import { parseYuanToCents, parsePercentToBps } from "../pricing";
import {
  COMMISSION_RULE,
  DEDUCTION_RULE,
  DISCLAIMER,
  OVERLAP_RULE,
  ROUNDING_RULE,
  SMS_NOTE,
  STACK_NOTE,
  TARGET_DOMAIN,
  TARGET_DOMAIN_NOTE,
  UNIT_RULE,
  UNIMPLEMENTED_FLOWS,
  VIRTUAL_PHONES,
} from "../rules";
import { explainInterest, listPayments, postRepayment, registerPaymentTerms } from "../payments";
import { ready } from "../runtime";
import { judgeDueTimeouts } from "../timeout-judge";
import { otpMode } from "../otp";
import { readDypnsConfig } from "../sms/dypns";
import {
  getSessionSecret,
  readCookie,
  readSession,
  sessionClearCookie,
  sessionCookieName,
  sessionSetCookie,
  signSession,
} from "../session";
import type { Actor, Result } from "../types";

const BLOCKED: Record<string, { code: string; message: string }> = {
  merchantId: { code: "MERCHANT_ID_NOT_ALLOWED", message: "不能由客户端指定 merchantId" },
  merchant_id: { code: "MERCHANT_ID_NOT_ALLOWED", message: "不能由客户端指定 merchantId" },
  quoteId: { code: "QUOTE_ID_NOT_ALLOWED", message: "不能由客户端指定报价" },
  quote_id: { code: "QUOTE_ID_NOT_ALLOWED", message: "不能由客户端指定报价" },
  role: { code: "CLIENT_SCOPE_NOT_ALLOWED", message: "不能由客户端指定角色" },
  demoKey: { code: "DEMO_LOGIN_DISABLED", message: "演示身份切换已停用" },
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, code, message }, { status });
}

function jsonOk(data: unknown, status = 200, setCookie?: string): Response {
  const headers = new Headers();
  if (setCookie) headers.set("set-cookie", setCookie);
  return Response.json({ ok: true, data }, { status, headers });
}

function fromResult<T>(result: Result<T>): Response {
  if (!result.ok) return jsonError(result.httpStatus, result.code, result.message);
  return jsonOk(result.data);
}

async function readBody(request: Request, options?: { allowMerchantId?: boolean }): Promise<Record<string, unknown> | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return jsonError(400, "INVALID_INPUT", "请求体不是 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return jsonError(400, "INVALID_INPUT", "请求体必须是对象");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (options?.allowMerchantId && (key === "merchantId" || key === "merchant_id")) continue;
    const blocked = BLOCKED[key];
    if (blocked) return jsonError(400, blocked.code, blocked.message);
  }
  return record;
}

async function requireActor(request: Request): Promise<{ ok: true; actor: Actor } | { ok: false; response: Response }> {
  await ready();
  const token = readCookie(request, sessionCookieName());
  if (!token) return { ok: false, response: jsonError(401, "UNAUTHENTICATED", "请先完成手机验证码登录") };
  const session = readSession(token, getSessionSecret());
  if (!session) return { ok: false, response: jsonError(401, "UNAUTHENTICATED", "登录已失效，请重新验证") };
  const actor = await getActorById(session.userId);
  if (!actor) return { ok: false, response: jsonError(401, "UNAUTHENTICATED", "登录已失效，请重新验证") };
  return { ok: true, actor };
}

function publicActor(actor: Actor) {
  const permissions =
    actor.role === "merchant"
      ? { scope: "own", canWriteStock: true, canWriteQuote: true, canSeeFloorPrice: true, canEditOwnCommission: true, canEditAnyCommission: false, description: "只能查看和修改本商家的商品、库存、报价和自己的佣金比例。" }
      : actor.role === "group"
        ? { scope: "group", canWriteStock: false, canWriteQuote: false, canSeeFloorPrice: true, canEditOwnCommission: false, canEditAnyCommission: false, description: "可以查看旗下子商家，不能修改库存、报价或费率。" }
        : actor.role === "platform"
          ? { scope: "platform", canWriteStock: false, canWriteQuote: false, canSeeFloorPrice: true, canEditOwnCommission: false, canEditAnyCommission: true, description: "可以查看全部示例商家，并调整其生效费率。不能代商家改库存。" }
          : { scope: "none", canWriteStock: false, canWriteQuote: false, canSeeFloorPrice: false, canEditOwnCommission: false, canEditAnyCommission: false, description: "客服不默认全库。" };
  return { user: { ...actor, roleLabel: actor.role === "merchant" ? "供货方" : actor.role === "group" ? "集团" : actor.role === "platform" ? "平台" : "客服" }, permissions, disclaimer: DISCLAIMER, smsNote: SMS_NOTE };
}

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
}

export function handleHealth(): Response {
  const config = readDypnsConfig();
  return jsonOk({
    preview: true,
    live: false,
    database: "postgres",
    smsProduct: "Dypnsapi/2017-05-25",
    smsApis: ["SendSmsVerifyCode", "CheckSmsVerifyCode"],
    smsConfigured: config.ok,
    smsDelivered: false,
    otpMode: otpMode(),
    realSendTested: false,
    targetDomain: TARGET_DOMAIN,
    targetDomainStatus: "待配置，未绑定，未上线",
    disclaimer: DISCLAIMER,
  });
}

export function handleDemos(): Response {
  return jsonError(410, "DEMO_LOGIN_DISABLED", "演示身份切换已停用，不能当作登录。");
}

export async function handleLogin(): Promise<Response> {
  return jsonError(410, "DEMO_LOGIN_DISABLED", "演示身份切换已停用。请使用手机验证码。");
}

export async function handleRequestOtp(request: Request): Promise<Response> {
  await ready();
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const phone = normalizePhone(body.phone);
  if (!phone) return jsonError(400, "INVALID_INPUT", "请输入大陆 11 位手机号。");
  const actor = await getActorByPhone(phone);
  const result = await requestOtp(phone, clientIp(request), Boolean(actor));
  if (!result.ok) return jsonError(result.code === "RATE_LIMITED" ? 429 : 503, result.code, result.message);
  return jsonOk({ accepted: true, message: "若该号码已登记且通道可用，验证码会由号码认证服务生成并发送。页面不显示验证码，送达结果需单独确认。" });
}

export async function handleVerifyOtp(request: Request): Promise<Response> {
  await ready();
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const phone = normalizePhone(body.phone);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!phone || !/^\d{4,8}$/.test(code)) return jsonError(400, "INVALID_INPUT", "请输入手机号和验证码。");
  const actor = await getActorByPhone(phone);
  if (!actor) return jsonError(401, "OTP_REJECTED", "验证码不正确、已过期或已使用。");
  const result = await verifyOtp(phone, code);
  if (!result.ok) return jsonError(result.code === "RATE_LIMITED" ? 429 : result.code === "SMS_NOT_CONFIGURED" ? 503 : 401, result.code, result.message);
  return jsonOk(publicActor(actor), 200, sessionSetCookie(signSession(actor.userId, getSessionSecret())));
}

export function handleLogout(): Response {
  return jsonOk({ signedOut: true }, 200, sessionClearCookie());
}

export async function handleMe(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return jsonOk({ ...publicActor(auth.actor), virtualPhones: VIRTUAL_PHONES, smsNote: SMS_NOTE, stackNote: STACK_NOTE });
}

export async function handleListSkus(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await listSkus(auth.actor));
}

export async function handleCreateSku(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const name = String(body.productName ?? "");
  const specName = String(body.specName ?? "");
  const baseUnitLabel = String(body.baseUnitLabel ?? body.unitLabel ?? "");
  const extraLabel = typeof body.extraUnitLabel === "string" ? body.extraUnitLabel.trim() : "";
  const product = await createProduct(auth.actor, {
    name,
    baseUnitLabel,
    note: typeof body.note === "string" ? body.note : "示例商品，非真实货源",
    units: extraLabel
      ? [{ label: extraLabel, numerator: Number(body.extraNumerator), denominator: Number(body.extraDenominator) }]
      : [],
  });
  if (!product.ok) return fromResult(product);
  return fromResult(await createSku(auth.actor, { productId: product.data.productId, specName, note: "示例规格" }));
}

export async function handleGetSku(request: Request, skuId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await getSkuDetail(auth.actor, skuId));
}

export async function handleListQuotes(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const skuId = new URL(request.url).searchParams.get("skuId") ?? undefined;
  return fromResult(await listQuotes(auth.actor, skuId));
}

export async function handleCreateQuote(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const floorPriceCents = parseYuanToCents(body.floorPriceYuan);
  if (floorPriceCents === null || typeof body.skuId !== "string") return jsonError(400, "INVALID_INPUT", "底价需为非负金额，最多两位小数。");
  return fromResult(await createQuote(auth.actor, { skuId: body.skuId, floorPriceCents, validFrom: String(body.validFrom ?? ""), validUntil: String(body.validUntil ?? ""), note: typeof body.note === "string" ? body.note : null }));
}

export async function handleListInbound(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await listInbound(auth.actor));
}

export async function handleCreateInbound(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (typeof body.skuId !== "string" || typeof body.unitId !== "string") return jsonError(400, "INVALID_INPUT", "请选择规格和该商品自己的单位。");
  return fromResult(await receiveInbound(auth.actor, { skuId: body.skuId, unitId: body.unitId, qty: Number(body.qty), note: typeof body.note === "string" ? body.note : null }));
}

export async function handleListOrders(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  await judgeDueTimeouts();
  return fromResult(await listOrders(auth.actor));
}

export async function handleCreateOrder(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (typeof body.skuId !== "string" || typeof body.unitId !== "string" || typeof body.idempotencyKey !== "string") {
    return jsonError(400, "INVALID_INPUT", "请选择规格、单位，并提供幂等键。");
  }
  const payment = body.payment && typeof body.payment === "object" ? body.payment as { method?: unknown; termDays?: unknown; capitalCostAnnualPercent?: unknown; overdueAnnualPercent?: unknown; capitalCostAnnualBps?: unknown; overdueAnnualBps?: unknown; agreementPriceCents?: unknown } : null;
  if (payment && (payment.capitalCostAnnualBps != null || payment.overdueAnnualBps != null)) {
    return jsonError(400, "RATE_UNIT_PERCENT", "年利率按百分比提交。字段是 capitalCostAnnualPercent 和 overdueAnnualPercent。5.25 表示 5.25%，不是 5.25 基点。");
  }
  return fromResult(await placeOrder(auth.actor, {
    skuId: body.skuId,
    unitId: body.unitId,
    qty: Number(body.qty),
    buyerLabel: String(body.buyerLabel ?? ""),
    idempotencyKey: body.idempotencyKey,
    payment: payment && typeof payment.method === "string"
      ? {
          method: payment.method,
          termDays: payment.method === "term" ? Number(payment.termDays) : null,
          capitalCostAnnualPercent: payment.method === "term" ? payment.capitalCostAnnualPercent : null,
          overdueAnnualPercent: payment.method === "term" ? payment.overdueAnnualPercent : null,
          agreementPriceCents: payment.agreementPriceCents,
        }
      : null,
  }));
}

export async function handleRegisterPayment(request: Request, orderId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (typeof body.method !== "string") return jsonError(400, "INVALID_INPUT", "请明确选择付款方式。");
  if (body.capitalCostAnnualBps != null || body.overdueAnnualBps != null) {
    return jsonError(400, "RATE_UNIT_PERCENT", "年利率按百分比提交。字段是 capitalCostAnnualPercent 和 overdueAnnualPercent。5.25 表示 5.25%，不是 5.25 基点。");
  }
  return fromResult(await registerPaymentTerms(auth.actor, orderId, {
    method: body.method,
    termDays: body.method === "term" ? Number(body.termDays) : null,
    capitalCostAnnualPercent: body.method === "term" ? body.capitalCostAnnualPercent : null,
    overdueAnnualPercent: body.method === "term" ? body.overdueAnnualPercent : null,
    agreementPriceCents: body.agreementPriceCents,
  }));
}

export async function handleRepayment(request: Request, orderId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (typeof body.idempotencyKey !== "string" || typeof body.paidOn !== "string") return jsonError(400, "INVALID_INPUT", "请提供付款日和幂等键。");
  return fromResult(await postRepayment(auth.actor, orderId, { amountCents: Number(body.amountCents), paidOn: body.paidOn, idempotencyKey: body.idempotencyKey }));
}

export async function handleInterest(request: Request, orderId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await explainInterest(auth.actor, orderId));
}

export async function handlePayments(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await listPayments(auth.actor));
}

export async function handleConfirmOutbound(request: Request, orderId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (typeof body.idempotencyKey !== "string") return jsonError(400, "INVALID_INPUT", "请提供本次出库的幂等键。");
  return fromResult(await confirmOutbound(auth.actor, orderId, { qty: Number(body.qty), idempotencyKey: body.idempotencyKey }));
}

export async function handleCancelOrder(request: Request, orderId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await releaseReservation(auth.actor, orderId, "cancelled"));
}

export async function handleTimeoutEvent(request: Request, orderId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await releaseReservation(auth.actor, orderId, "timed_out"));
}

export async function handleGetTimeoutConfig(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const merchantId = new URL(request.url).searchParams.get("merchantId");
  return fromResult(await getTimeoutConfig(auth.actor, merchantId));
}

export async function handlePutTimeoutConfig(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request, { allowMerchantId: false });
  if (body instanceof Response) return body;
  return fromResult(await setTimeoutConfig(auth.actor, typeof body.merchantId === "string" ? body.merchantId : null, Number(body.durationValue), String(body.durationUnit ?? "")));
}

export async function handleLedger(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const skuId = new URL(request.url).searchParams.get("skuId") ?? undefined;
  return fromResult(await listLedger(auth.actor, skuId));
}

export async function handleMerchants(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return fromResult(await listMerchants(auth.actor));
}

export async function handleGetCommission(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const merchantId = new URL(request.url).searchParams.get("merchantId");
  const result = await getCommission(auth.actor, merchantId);
  if (!result.ok) return fromResult(result);
  return jsonOk({ ...result.data, formula: COMMISSION_RULE, ruleStatus: "已确认公式；舍入为建议默认" });
}

export async function handleUpdateCommission(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request, { allowMerchantId: auth.actor.role === "platform" });
  if (body instanceof Response) return body;
  const bps = parsePercentToBps(body.commissionPercent);
  if (bps === null) return jsonError(400, "INVALID_INPUT", "佣金比例需在 0% 到 100% 之间，最多两位小数。");
  const merchantId = typeof body.merchantId === "string" ? body.merchantId : null;
  return fromResult(await updateCommission(auth.actor, merchantId, bps));
}

export async function handleUpdateUnit(request: Request, unitId: string): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  return fromResult(await updateUnitRatio(auth.actor, unitId, Number(body.numerator), Number(body.denominator)));
}

export async function handleRules(request: Request): Promise<Response> {
  const auth = await requireActor(request);
  if (!auth.ok) return auth.response;
  return jsonOk({ disclaimer: DISCLAIMER, targetDomain: TARGET_DOMAIN, targetDomainNote: TARGET_DOMAIN_NOTE, commission: COMMISSION_RULE, unit: UNIT_RULE, deduction: DEDUCTION_RULE, overlap: OVERLAP_RULE, rounding: ROUNDING_RULE, unimplemented: UNIMPLEMENTED_FLOWS, stack: STACK_NOTE, sms: SMS_NOTE });
}
