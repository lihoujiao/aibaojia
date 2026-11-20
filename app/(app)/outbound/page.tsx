"use client";

import { useState, type FormEvent } from "react";
import { ApiError, api } from "@/components/api";
import { formatWhen } from "@/components/format";
import { SkuField } from "@/components/sku-field";
import { useRemote } from "@/components/use-remote";
import { useSession } from "@/components/session";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatYuanFromCents } from "@/lib/pricing";
import { DEDUCTION_RULE, TIMEOUT_SCAN_NOTE } from "@/lib/rules";
import type { PriceBreakdown, SkuRecord } from "@/lib/types";

type SkuCard = SkuRecord & { effective: PriceBreakdown | null };
type OrderRow = {
  id: string;
  status: string;
  productName: string;
  specName: string;
  qty: number;
  unitLabel: string;
  qtyBase: number;
  qtyFulfilledBase: number;
  timeoutDurationValue: number | null;
  timeoutDurationUnit: string | null;
  timeoutAt: string | null;
  timeoutJudgeSource: string | null;
  buyerLabel: string;
  platformPriceCents: number;
  createdAt: string;
};
type TimeoutConfig = { configured: boolean; durationValue: number | null; durationUnit: string | null; note: string };

const STATUS_LABEL: Record<string, string> = {
  reserved: "预占中",
  fulfilled: "已全部出库",
  cancelled: "已取消，剩余预占已释放",
  timed_out: "已超时，剩余预占已释放",
};

export default function OutboundPage() {
  const session = useSession();
  const skuQuery = useRemote<{ skus: SkuCard[] }>("/api/skus");
  const orderQuery = useRemote<{ orders: OrderRow[] }>("/api/orders");
  const timeoutQuery = useRemote<TimeoutConfig>("/api/order-timeout");
  const skus = skuQuery.data?.skus ?? null;
  const orders = orderQuery.data?.orders ?? null;
  const error = skuQuery.error || orderQuery.error || timeoutQuery.error;
  const [skuOverride, setSkuOverride] = useState<string | null>(null);
  const [unitOverride, setUnitOverride] = useState<string | null>(null);
  const skuId = skuOverride ?? skus?.[0]?.id ?? "";
  const [qty, setQty] = useState("1");
  const [buyerLabel, setBuyerLabel] = useState("示例采购方");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [durationDraft, setDurationDraft] = useState("");
  const [unitDraft, setUnitDraft] = useState("");
  const [timeoutNotice, setTimeoutNotice] = useState<string | null>(null);
  const selected = skus?.find((sku) => sku.id === skuId);
  const unitId = unitOverride ?? selected?.units[0]?.id ?? "";
  const selectedUnit = selected?.units.find((unit) => unit.id === unitId);

  async function submit() {
    setSaving(true);
    setFormError(null);
    setDone(null);
    try {
      await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          skuId,
          unitId,
          qty: Number(qty),
          buyerLabel,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setOpen(false);
      setDone("订单已预占。出库数量需要在订单上另行填写，页面不会把整单自动出完。");
      skuQuery.reload();
      orderQuery.reload();
    } catch (reason) {
      setFormError(reason instanceof ApiError ? reason.message : "下单没有完成");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function saveTimeout(event: FormEvent) {
    event.preventDefault();
    setTimeoutNotice(null);
    const durationValue = Number(durationDraft);
    if (!durationDraft.trim() || !unitDraft) {
      setTimeoutNotice("请同时填写正整数时长和单位。空白不会被当成已生效的默认超时。");
      return;
    }
    try {
      await api("/api/order-timeout", {
        method: "PUT",
        body: JSON.stringify({ durationValue, durationUnit: unitDraft }),
      });
      setDurationDraft("");
      setUnitDraft("");
      setTimeoutNotice("已保存你提交的时长。之后新建的订单会快照它，到期自动释放剩余预占。已经存在的订单不改写。谁能改、是否应该追溯，仍未指定。");
      timeoutQuery.reload();
    } catch (reason) {
      setTimeoutNotice(reason instanceof ApiError ? reason.message : "没有保存超时配置");
    }
  }

  function refreshAfterOrderAction() {
    skuQuery.reload();
    orderQuery.reload();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">下单与出库</h1>
        <p className="mt-1 text-sm leading-6 text-[#5c6f64]">{DEDUCTION_RULE}</p>
      </div>
      <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]">
        <h2 className="font-medium">订单超时时长</h2>
        {timeoutQuery.data ? <p className="text-sm leading-6 text-[#9a3412]">{timeoutQuery.data.note}</p> : <LoadingBlock />}
        <p className="text-sm leading-6 text-[#5c6f64]">{TIMEOUT_SCAN_NOTE}</p>
        {timeoutQuery.data?.configured ? (
          <p className="text-sm">
            已保存 {timeoutQuery.data.durationValue}{" "}
            {timeoutQuery.data.durationUnit === "minute" ? "分钟" : timeoutQuery.data.durationUnit === "hour" ? "小时" : "天"}
            。这是已提交的参数，不是开发预填的默认。新订单会快照它并在到期后自动释放剩余预占；已有订单不改写。
          </p>
        ) : (
          <p className="text-sm">当前没有已生效的超时时长。输入框保持空白，示例里的 24 小时或 1 小时都不会被预先填入。</p>
        )}
        {session.user.role === "merchant" ? (
          <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => void saveTimeout(event)}>
            <div className="space-y-1.5">
              <Label htmlFor="timeout-value">时长</Label>
              <Input id="timeout-value" inputMode="numeric" placeholder="请填写正整数" value={durationDraft} onChange={(event) => setDurationDraft(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeout-unit">单位</Label>
              <select id="timeout-unit" className="h-10 w-full rounded-lg border border-input bg-white px-2.5 text-sm" value={unitDraft} onChange={(event) => setUnitDraft(event.target.value)}>
                <option value="">请选择单位</option>
                <option value="minute">分钟</option>
                <option value="hour">小时</option>
                <option value="day">天</option>
              </select>
            </div>
            <Button type="submit" className="h-10 self-end">保存配置</Button>
          </form>
        ) : (
          <p className="text-sm text-[#5c6f64]">谁可以保存这份配置尚未指定。平台、集团和客服在这里不能代其他商家写入。</p>
        )}
        {timeoutNotice ? <p className="text-sm">{timeoutNotice}</p> : null}
      </section>
      {session.permissions.canWriteStock ? (
        <form
          className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]"
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <SkuField skus={skus ?? []} skuId={skuId} onChange={setSkuOverride} />
          <div className="space-y-1.5">
            <Label htmlFor="out-unit">本商品单位</Label>
            <select id="out-unit" className="h-10 w-full rounded-lg border border-input bg-white px-2.5 text-sm" value={unitId} onChange={(event) => setUnitOverride(event.target.value)}>
              {(selected?.units ?? []).map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.unitLabel}
                  {unit.isBase ? "（基准）" : ` = ${unit.toBaseNumerator}/${unit.toBaseDenominator} ${selected?.baseUnitLabel}`}
                </option>
              ))}
            </select>
          </div>
          {selected ? (
            <div className="rounded-lg bg-[#f3f6f0] px-3 py-3 text-sm">
              <p>现货 {selected.onHandBase} · 预占 {selected.reservedBase} · 可用 {selected.availableBase} {selected.baseUnitLabel}</p>
              {selected.effective ? <p className="mt-1 text-[#e86a17]">基准单位平台价 {selected.effective.platformPriceYuan} 元</p> : <p className="mt-1 text-[#9a3412]">没有有效报价，下单会被拒绝。</p>}
            </div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="out-qty">数量{selectedUnit ? `（${selectedUnit.unitLabel}）` : ""}</Label>
              <Input id="out-qty" inputMode="numeric" value={qty} onChange={(event) => setQty(event.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="buyer">采购方名称</Label>
              <Input id="buyer" value={buyerLabel} onChange={(event) => setBuyerLabel(event.target.value)} required />
            </div>
          </div>
          <p className="text-xs text-[#5c6f64]">这一步只预占。部分出库、取消和超时释放在下面的订单上单独办理，不会在下单时把整单出完。</p>
          {formError ? <p className="text-sm text-[#b42318]">{formError}</p> : null}
          {done ? <p className="text-sm text-[#146c43]">{done}</p> : null}
          <Button type="submit" variant="trade" className="h-11 w-full" disabled={!skuId || !unitId || !buyerLabel.trim()}>
            下单预占
          </Button>
        </form>
      ) : (
        <p className="rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-[#d5e3d8]">当前身份不能办理出库。</p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认下单预占</DialogTitle>
            <DialogDescription>
              {selected ? `${selected.productName} · ${selected.specName}` : "规格"}，数量 {qty} {selectedUnit?.unitLabel}。只预占可用库存，不在这一步扣现货。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>返回</Button>
            <Button type="button" variant="trade" disabled={saving} onClick={() => void submit()}>{saving ? "处理中…" : "确认预占"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error ? <ErrorBlock message={error} onRetry={() => { skuQuery.reload(); orderQuery.reload(); timeoutQuery.reload(); }} /> : null}
      {!orders && !error ? <LoadingBlock /> : null}
      {orders && orders.length === 0 ? <EmptyBlock title="还没有订单" detail="库存不足或报价过期时，下单会被拒绝，也不会预占。" /> : null}
      <div className="space-y-2">
        {orders?.map((order) => (
          <OrderCard key={order.id} order={order} canAct={session.permissions.canWriteStock} onChanged={refreshAfterOrderAction} />
        ))}
      </div>
    </div>
  );
}

function OrderCard({ order, canAct, onChanged }: { order: OrderRow; canAct: boolean; onChanged: () => void }) {
  const [shipQty, setShipQty] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = order.status === "reserved";

  async function run(path: string, body?: Record<string, unknown>, okText?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api(path, body ? { method: "POST", body: JSON.stringify(body) } : { method: "POST" });
      setShipQty("");
      setMessage(okText ?? "已处理。");
      onChanged();
    } catch (reason) {
      setMessage(reason instanceof ApiError ? reason.message : "没有完成");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-xl bg-white p-4 text-sm ring-1 ring-[#d5e3d8]">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-medium">{order.productName} · {order.specName}</h2>
        <p className="text-right font-semibold text-[#e86a17]">{STATUS_LABEL[order.status] ?? order.status}</p>
      </div>
      <p className="mt-1">订单 {order.qty} {order.unitLabel}，折合 {order.qtyBase} 个基准单位，已出 {order.qtyFulfilledBase} 个基准单位。</p>
      <p className="mt-1 text-[#9a3412]">
        {order.timeoutAt
          ? `本单快照 ${order.timeoutDurationValue ?? ""} ${order.timeoutDurationUnit === "minute" ? "分钟" : order.timeoutDurationUnit === "hour" ? "小时" : order.timeoutDurationUnit === "day" ? "天" : ""}，到期 ${formatWhen(order.timeoutAt)}。${order.timeoutJudgeSource === "automatic" ? "已由到期自动判定释放。" : order.timeoutJudgeSource === "event" ? "已由超时事件释放。" : "到期前仍保持预占。"}`
          : "本单建立时没有超时配置，不会自动超时。"}
      </p>
      <p className="mt-1">平台价快照 {formatYuanFromCents(order.platformPriceCents)} 元</p>
      <p className="mt-1 text-[#5c6f64]">采购方 {order.buyerLabel} · {formatWhen(order.createdAt)}</p>
      {open && canAct ? (
        <div className="mt-3 space-y-2">
          <Label htmlFor={`ship-${order.id}`}>本次出库数量（{order.unitLabel}）</Label>
          <Input id={`ship-${order.id}`} inputMode="numeric" placeholder="填写本次实出数量" value={shipQty} onChange={(event) => setShipQty(event.target.value)} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Button type="button" variant="trade" disabled={busy || !shipQty.trim()} onClick={() => void run(`/api/orders/${order.id}/outbound`, { qty: Number(shipQty), idempotencyKey: crypto.randomUUID() }, "已按填写数量出库。未出部分继续预占。")}>部分出库</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void run(`/api/orders/${order.id}/cancel`, undefined, "已取消，剩余预占已立即释放。")}>取消并释放</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void run(`/api/orders/${order.id}/timeout`, undefined, "已按超时事件释放剩余预占。这不是定时器自动判断。")}>记录超时</Button>
          </div>
        </div>
      ) : null}
      {message ? <p className="mt-2 text-sm">{message}</p> : null}
    </article>
  );
}
