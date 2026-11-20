import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.NODE_ENV === "production" || process.env.OTP_DELIVERY !== "test") {
  throw new Error("测试身份注入只允许非生产且 OTP_DELIVERY=test。生产预览不能使用。");
}

const base = process.env.CAPTURE_BASE ?? "http://127.0.0.1:43127";
function log(message: string): void {
  appendFileSync("/tmp/capture-progress.txt", `${new Date().toISOString()} ${message}\n`);
}
const outDir = "docs/evidence";
mkdirSync(outDir, { recursive: true });

type Target = { webSocketDebuggerUrl: string; type: string };

async function cookieFor(userId: string): Promise<string> {
  const { getSessionSecret, signSession } = await import("../lib/session");
  return signSession(userId, getSessionSecret());
}

async function api(cookie: string, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: { cookie: `nq_session=${cookie}`, "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function startChrome(): Promise<void> {
  const child = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=/tmp/chrome-r4-${process.pid}`,
      "--remote-debugging-port=9333",
      "--remote-allow-origins=*",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  child.unref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome 调试端口没有起来")), 15_000);
    const probe = async () => {
      try {
        const response = await fetch("http://127.0.0.1:9333/json/version");
        if (response.ok) {
          clearTimeout(timer);
          resolve();
          return;
        }
      } catch {
        // Chrome is still starting.
      }
      setTimeout(probe, 200);
    };
    void probe();
  });
}

type Pending = Map<number, (value: { result?: Record<string, unknown> }) => void>;

let nextCdpId = 0;

function cdp(ws: WebSocket, pending: Pending, method: string, params: Record<string, unknown> = {}, timeoutMs = 8_000): Promise<{ result?: Record<string, unknown> }> {
  const id = ++nextCdpId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时 ${method}`));
    }, timeoutMs);
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function openPage(): Promise<{ ws: WebSocket; pending: Pending }> {
  const list = (await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json())) as Target[];
  const page = list.find((item) => item.type === "page");
  if (!page) throw new Error("没有浏览器页面");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending: Pending = new Map();
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("调试连接失败")));
  });
  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown> };
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    } catch (error) {
      log(`cdp parse ${error instanceof Error ? error.message : "failed"}`);
    }
  });
  await cdp(ws, pending, "Page.enable");
  await cdp(ws, pending, "Runtime.enable");
  await cdp(ws, pending, "Network.enable");
  return { ws, pending };
}

async function shoot(name: string, cookie: string, path: string, needle: string, width = 1280, height = 900, scroll = false): Promise<void> {
  log(`shoot ${name}`);
  const { ws, pending } = await openPage();
  await cdp(ws, pending, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await cdp(ws, pending, "Page.navigate", { url: `${base}/login` });
  await delay(300);
  const cookieSet = await cdp(ws, pending, "Network.setCookie", { name: "nq_session", value: cookie, url: `${base}/`, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" });
  log(`${name} cookie ${String(cookieSet.result?.success)}`);
  await cdp(ws, pending, "Page.navigate", { url: `${base}${path}` });
  const started = Date.now();
  let found = false;
  let lastText = "";
  while (Date.now() - started < 30_000) {
    const evaluated = await cdp(ws, pending, "Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true });
    lastText = String((evaluated.result?.result as { value?: string } | undefined)?.value ?? "");
    if (lastText.includes(needle)) {
      found = true;
      break;
    }
    await delay(400);
  }
  if (!found) {
    log(`${name} text ${lastText.replace(/\s+/g, " ").slice(0, 240)}`);
    throw new Error(`${name} 没有出现「${needle}」`);
  }
  if (scroll) {
    await cdp(ws, pending, "Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
  }
  await delay(400);
  const shot = await cdp(ws, pending, "Page.captureScreenshot", { format: "png" }, 30_000);
  const data = String(shot.result?.data ?? "");
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
  ws.close();
  log(`${name} ok`);
}

async function main(): Promise<void> {
  log("start");
  await startChrome();
  if (process.env.CAPTURE_ONLY === "payments") {
    const merchantA = await cookieFor("user-merchant-a");
    await shoot("13-payments", merchantA, "/payments", "正式利息不可计算");
    log("capture done");
    return;
  }
  if (process.env.CAPTURE_ONLY === "timeout") {
    const merchantA = await cookieFor("user-merchant-a");
    await shoot("11-timeout-scan-note", merchantA, "/outbound", "15 秒");
    await shoot("12-timeout-automatic", merchantA, "/outbound", "到期自动判定", 1280, 900, true);
    log("capture done");
    return;
  }
  log("chrome");
  const merchantA = await cookieFor("user-merchant-a");
  const merchantB = await cookieFor("user-merchant-b");
  const group = await cookieFor("user-group");
  const platform = await cookieFor("user-platform");
  const skus = await api(merchantA, "/api/skus");
  const rows = ((skus.body as { data?: { skus?: Array<{ id: string; availableBase: number; effective: unknown; units: Array<{ id: string }> }> } }).data?.skus ?? []);
  const sku = rows.find((item) => item.availableBase > 2 && item.effective && item.units[0]);
  if (!sku) throw new Error("示例库存不足以演示下单");
  await shoot("01-products-merchant-a", merchantA, "/products", "商品与规格");
  await shoot("02-product-detail", merchantA, `/products/${sku.id}`, "现货");
  await shoot("03-quotes", merchantA, "/quotes", "报价");
  await shoot("04-outbound-before", merchantA, "/outbound", "订单超时时长");
  const timeout = await api(merchantA, "/api/order-timeout");
  const configured = Boolean((timeout.body as { data?: { configured?: boolean } }).data?.configured);
  if (!configured) {
    const saved = await api(merchantA, "/api/order-timeout", { method: "PUT", body: { durationValue: 2, durationUnit: "hour" } });
    if (saved.status !== 200) throw new Error(`保存超时配置失败 ${saved.status}`);
  }
  const reserved = await api(merchantA, "/api/orders", {
    method: "POST",
    body: { skuId: sku.id, unitId: sku.units[0].id, qty: 4, buyerLabel: "示例验收采购方", idempotencyKey: `cap-${Date.now()}-reserve` },
  });
  const orderId = (reserved.body as { data?: { id?: string } }).data?.id;
  if (reserved.status !== 200 || !orderId) throw new Error(`下单失败 ${reserved.status}`);
  const shipped = await api(merchantA, `/api/orders/${orderId}/outbound`, {
    method: "POST",
    body: { qty: 1, idempotencyKey: `cap-${Date.now()}-ship` },
  });
  if (shipped.status !== 200) throw new Error(`部分出库失败 ${shipped.status}`);
  const cancelOrder = await api(merchantA, "/api/orders", {
    method: "POST",
    body: { skuId: sku.id, unitId: sku.units[0].id, qty: 2, buyerLabel: "示例取消采购方", idempotencyKey: `cap-${Date.now()}-cancel` },
  });
  const cancelId = (cancelOrder.body as { data?: { id?: string } }).data?.id;
  if (!cancelId) throw new Error("取消用订单没有创建");
  const cancelled = await api(merchantA, `/api/orders/${cancelId}/cancel`, { method: "POST" });
  if (cancelled.status !== 200) throw new Error(`取消失败 ${cancelled.status}`);
  await shoot("05-outbound-after", merchantA, "/outbound", "部分出库");
  await shoot("06-outbound-mobile", merchantA, "/outbound", "订单超时时长", 390, 844);
  await shoot("07-ledger", merchantA, "/inventory", "流水");
  await shoot("08-products-merchant-b", merchantB, "/products", "商品与规格");
  await shoot("09-products-group", group, "/products", "商品与规格");
  await shoot("10-products-platform", platform, "/products", "商品与规格");
  console.log("capture done");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "capture failed";
  log(message);
  console.error(message);
  process.exit(1);
});
