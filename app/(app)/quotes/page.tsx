"use client";

import { useState } from "react";
import { ApiError, api } from "@/components/api";
import { useRemote } from "@/components/use-remote";
import { formatWhen, fromLocalInput, toLocalInput } from "@/components/format";
import { useSession } from "@/components/session";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OVERLAP_RULE } from "@/lib/rules";
import type { PriceBreakdown, QuoteView, SkuRecord } from "@/lib/types";

type SkuCard = SkuRecord & { effective: PriceBreakdown | null };

export default function QuotesPage() {
  const session = useSession();
  const skuQuery = useRemote<{ skus: SkuCard[] }>("/api/skus");
  const quoteQuery = useRemote<{ quotes: QuoteView[] }>("/api/quotes");
  const skus = skuQuery.data?.skus ?? null;
  const quotes = quoteQuery.data?.quotes ?? null;
  const error = skuQuery.error || quoteQuery.error;
  const [skuOverride, setSkuOverride] = useState<string | null>(null);
  const skuId = skuOverride ?? skus?.[0]?.id ?? "";
  const [floorPriceYuan, setFloorPriceYuan] = useState("6.80");
  const [validFrom, setValidFrom] = useState(() => toLocalInput(new Date()));
  const [validUntil, setValidUntil] = useState(() => toLocalInput(new Date(Date.now() + 7 * 86_400_000)));
  const [note, setNote] = useState("示例报价，非真实成交价");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function saveQuote() {
    setSaving(true);
    setFormError(null);
    try {
      await api("/api/quotes", {
        method: "POST",
        body: JSON.stringify({
          skuId,
          floorPriceYuan,
          validFrom: fromLocalInput(validFrom),
          validUntil: fromLocalInput(validUntil),
          note,
        }),
      });
      skuQuery.reload();
      quoteQuery.reload();
    } catch (reason) {
      setFormError(reason instanceof ApiError ? reason.message : "没有保存报价");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">报价</h1>
        <p className="mt-1 text-sm leading-6 text-[#5c6f64]">{OVERLAP_RULE}</p>
      </div>
      {session.permissions.canWriteQuote ? (
        <form
          className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]"
          onSubmit={(event) => {
            event.preventDefault();
            void saveQuote();
          }}
        >
          <h2 className="font-medium">发布本商家报价</h2>
          <div className="space-y-1.5">
            <Label htmlFor="quote-sku">规格</Label>
            <select
              id="quote-sku"
              className="h-10 w-full rounded-lg border border-input bg-white px-2.5 text-sm"
              value={skuId}
              onChange={(event) => setSkuOverride(event.target.value)}
              required
            >
              {(skus ?? []).map((sku) => (
                <option key={sku.id} value={sku.id}>
                  {sku.productName} · {sku.specName}（{sku.unitLabel}）
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="floor">底价（元）</Label>
              <Input id="floor" inputMode="decimal" value={floorPriceYuan} onChange={(event) => setFloorPriceYuan(event.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">开始</Label>
              <Input id="from" type="datetime-local" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="until">结束</Label>
              <Input id="until" type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quote-note">备注</Label>
            <Input id="quote-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          <p className="text-sm text-[#5c6f64]">如果结束时间不晚于现在，保存后会显示为已过期，不能当作有效价。</p>
          {formError ? <p className="text-sm text-[#b42318]">{formError}</p> : null}
          <Button type="submit" variant="trade" className="h-11" disabled={saving || !skuId}>
            {saving ? "保存中…" : "保存报价"}
          </Button>
        </form>
      ) : (
        <p className="rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-[#d5e3d8]">当前身份只能查看范围内的报价，不能改底价。</p>
      )}
      {error ? (
        <ErrorBlock
          message={error}
          onRetry={() => {
            skuQuery.reload();
            quoteQuery.reload();
          }}
        />
      ) : null}
      {!quotes && !error ? <LoadingBlock /> : null}
      {quotes && quotes.length === 0 ? <EmptyBlock title="还没有报价" detail="没有有效报价时，不能给出实时平台价，也不能确认出库。" /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {quotes?.map((quote) => (
          <article key={quote.id} className="rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-medium">
                  {quote.productName} · {quote.specName}
                </h2>
                <p className="text-xs text-[#5c6f64]">单位：{quote.unitLabel}</p>
              </div>
              <Badge variant={quote.status === "effective" ? "default" : quote.status === "expired" ? "destructive" : "secondary"}>
                {quote.statusLabel}
              </Badge>
            </div>
            <p className="mt-3 text-sm">底价 {quote.floorPriceYuan} 元</p>
            {quote.price ? (
              <p className="mt-1 text-sm font-medium text-[#e86a17]">平台价 {quote.price.platformPriceYuan} 元</p>
            ) : (
              <p className="mt-1 text-sm text-[#9a3412]">不作为当前有效价</p>
            )}
            <p className="mt-2 text-xs text-[#5c6f64]">
              {formatWhen(quote.validFrom)} 至 {formatWhen(quote.validUntil)}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
