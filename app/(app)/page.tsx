"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, api } from "@/components/api";
import { useRemote } from "@/components/use-remote";
import { OutOfScope } from "@/components/out-of-scope";
import { useSession } from "@/components/session";
import { ErrorBlock, LoadingBlock } from "@/components/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SkuRecord, PriceBreakdown } from "@/lib/types";
import { COMMISSION_RULE, DEDUCTION_RULE, OVERLAP_RULE, UNIT_RULE, UNIMPLEMENTED_FLOWS } from "@/lib/rules";

type SkuCard = SkuRecord & { effective: PriceBreakdown | null };
type MerchantRow = { id: string; name: string; groupId: string | null; skuCount: number };
type Commission = {
  commissionBps: number;
  commissionPercent: string;
  effectiveSource: "platform" | "merchant" | "default";
  merchantBps: number | null;
  platformBps: number | null;
  priorityApplied: boolean;
  label: string;
};

export default function HomePage() {
  const session = useSession();
  const canRead = session.permissions.scope !== "none";
  const skuQuery = useRemote<{ skus: SkuCard[] }>(canRead ? "/api/skus" : null);
  const merchantQuery = useRemote<{ merchants: MerchantRow[] }>(canRead ? "/api/merchants" : null);
  const [merchantPick, setMerchantPick] = useState<string | null>(null);
  const commissionMerchantId = session.permissions.canEditAnyCommission ? merchantPick ?? merchantQuery.data?.merchants[0]?.id ?? null : null;
  const commissionPath = !canRead
    ? null
    : session.permissions.canEditAnyCommission
      ? commissionMerchantId
        ? `/api/commission?merchantId=${commissionMerchantId}`
        : null
      : "/api/commission";
  const commissionQuery = useRemote<Commission>(commissionPath);
  const [percentDraft, setPercentDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const skus = skuQuery.data?.skus ?? null;
  const merchants = merchantQuery.data?.merchants ?? null;
  const commission = commissionQuery.data;
  const percent = percentDraft ?? commission?.commissionPercent ?? "5.00";
  const error = skuQuery.error || merchantQuery.error || commissionQuery.error;

  async function saveCommission() {
    setSaving(true);
    setNotice(null);
    try {
      await api("/api/commission", {
        method: "PATCH",
        body: JSON.stringify({
          commissionPercent: percent,
          ...(session.permissions.canEditAnyCommission && commissionMerchantId ? { merchantId: commissionMerchantId } : {}),
        }),
      });
      setNotice("已保存你这一侧的费率。双方都已保存时，平台设置优先。已确认单据仍保留当时快照。");
      setPercentDraft(null);
      skuQuery.reload();
      merchantQuery.reload();
      commissionQuery.reload();
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : "没有保存");
    } finally {
      setSaving(false);
    }
  }

  const effectiveCount = skus?.filter((sku) => sku.effective).length ?? 0;
  const zeroCount = skus?.filter((sku) => sku.onHand === 0).length ?? 0;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 ring-1 ring-[#d5e3d8]">
        <p className="text-sm text-[#146c43]">{session.user.roleLabel}</p>
        <h1 className="mt-1 text-xl font-semibold">{session.user.displayName}</h1>
        <p className="mt-2 text-sm leading-6 text-[#5c6f64]">{session.permissions.description}</p>
        {session.user.merchantName ? <p className="mt-2 text-sm">所属商家：{session.user.merchantName}</p> : null}
        {session.user.groupName ? <p className="mt-1 text-sm">所属集团：{session.user.groupName}</p> : null}
      </section>

      {session.permissions.canWriteStock ? (
        <div className="grid grid-cols-2 gap-2">
          <Link className={cn(buttonVariants({ variant: "trade" }), "h-11")} href="/inbound">
            采购入库
          </Link>
          <Link className={cn(buttonVariants({ variant: "trade" }), "h-11")} href="/outbound">
            销售出库
          </Link>
        </div>
      ) : null}

      {!canRead ? (
        <section className="rounded-xl bg-white p-4 text-sm leading-6 ring-1 ring-[#d5e3d8]">
          客服示例账号默认看不到商品、库存、底价和单据。需要单独授权后才能查看，本轮没有授予任何商家。
        </section>
      ) : null}

      {error ? (
        <ErrorBlock
          message={error}
          onRetry={() => {
            skuQuery.reload();
            merchantQuery.reload();
            commissionQuery.reload();
          }}
        />
      ) : null}
      {canRead && !skus && !error ? <LoadingBlock /> : null}

      {skus && merchants ? (
        <>
          <section className="grid grid-cols-3 gap-2">
            <Stat label="可见规格" value={String(skus.length)} />
            <Stat label="有效报价" value={String(effectiveCount)} />
            <Stat label="零库存" value={String(zeroCount)} />
          </section>
          <section className="rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]">
            <h2 className="font-medium">可见商家</h2>
            <ul className="mt-2 space-y-2 text-sm">
              {merchants.map((merchant) => (
                <li key={merchant.id} className="flex items-center justify-between gap-3">
                  <span>{merchant.name}</span>
                  <span className="text-[#5c6f64]">{merchant.skuCount} 个规格</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-5 text-[#5c6f64]">{UNIT_RULE}</p>
          </section>
        </>
      ) : null}

      {(session.permissions.canEditOwnCommission || session.permissions.canEditAnyCommission) && commission ? (
        <section className="rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]">
          <h2 className="font-medium">佣金比例</h2>
          <p className="mt-1 text-sm leading-6 text-[#5c6f64]">{COMMISSION_RULE}</p>
          {session.permissions.canEditAnyCommission ? (
            <div className="mt-3 space-y-1.5">
              <Label htmlFor="commission-merchant">商家</Label>
              <select id="commission-merchant" className="h-10 w-full rounded-lg border border-input bg-white px-2.5 text-sm" value={commissionMerchantId ?? ""} onChange={(event) => setMerchantPick(event.target.value)}>
                {(merchants ?? []).map((merchant) => (
                  <option key={merchant.id} value={merchant.id}>{merchant.name}</option>
                ))}
              </select>
            </div>
          ) : null}
          <p className="mt-2 text-xs leading-5 text-[#5c6f64]">
            当前生效 {commission.commissionPercent}%（
            {commission.effectiveSource === "platform" ? "来自平台已保存" : commission.effectiveSource === "merchant" ? "来自商家已保存，平台侧没有保存记录" : "两侧都未保存，沿用此前已确认的 5% 默认"}
            ）。商家已存 {commission.merchantBps == null ? "未保存" : `${(commission.merchantBps / 100).toFixed(2)}%`}，平台已存 {commission.platformBps == null ? "未保存" : `${(commission.platformBps / 100).toFixed(2)}%`}。
            {commission.priorityApplied ? "双方都已保存，生效的是平台设置。" : ""}
            显式 0 不会保存。
          </p>
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="commission">百分比</Label>
              <Input
                id="commission"
                inputMode="decimal"
                value={percent}
                onChange={(event) => setPercentDraft(event.target.value)}
              />
            </div>
            <Button className="h-10" disabled={saving} onClick={() => void saveCommission()}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
          {notice ? <p className="mt-2 text-sm">{notice}</p> : null}
        </section>
      ) : null}

      <section className="space-y-2 rounded-xl bg-[#fff7f1] p-4 text-sm leading-6 ring-1 ring-[#f3d2bc]">
        <p>{DEDUCTION_RULE}</p>
        <p>{OVERLAP_RULE}</p>
        <p>{UNIMPLEMENTED_FLOWS}</p>
      </section>
      <OutOfScope />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white px-3 py-3 ring-1 ring-[#d5e3d8]">
      <p className="text-xs text-[#5c6f64]">{label}</p>
      <p className="mt-1 text-xl font-semibold text-[#146c43]">{value}</p>
    </div>
  );
}
