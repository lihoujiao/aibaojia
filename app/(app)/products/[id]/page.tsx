"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useRemote } from "@/components/use-remote";
import { formatWhen } from "@/components/format";
import { useSession } from "@/components/session";
import { ErrorBlock, LoadingBlock } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import type { PriceBreakdown, QuoteView, SkuRecord } from "@/lib/types";

type Detail = {
  sku: SkuRecord;
  quotes: QuoteView[];
  effective: PriceBreakdown | null;
  rules: { unit: string; overlap: string; deduction: string; commission: string };
};

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const skuId = Array.isArray(params.id) ? params.id[0] : params.id;
  const session = useSession();
  const query = useRemote<Detail>(skuId ? `/api/skus/${skuId}` : null);
  const detail = query.data;
  const error = query.error;

  if (error) return <ErrorBlock message={error} onRetry={query.reload} />;
  if (!detail) return <LoadingBlock />;

  const { sku, effective, quotes, rules } = detail;
  return (
    <div className="space-y-4">
      <Link href="/products" className="text-sm text-[#146c43]">
        返回商品
      </Link>
      <section className="rounded-2xl bg-white p-4 ring-1 ring-[#d5e3d8]">
        <p className="text-xs text-[#146c43]">{sku.merchantName} · 示例商品</p>
        <h1 className="mt-1 text-2xl font-semibold">{sku.productName}</h1>
        <p className="text-sm text-[#5c6f64]">{sku.specName}</p>
        <div className="mt-4 flex items-end justify-between">
          <div>
            <p className="text-xs text-[#5c6f64]">现货</p>
            <p className="text-3xl font-semibold text-[#146c43]">
              {sku.onHand}
              <span className="ml-1 text-base font-normal">{sku.unitLabel}</span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-[#5c6f64]">有效平台价</p>
            {effective ? (
              <p className="text-3xl font-semibold text-[#e86a17]">{effective.platformPriceYuan}</p>
            ) : (
              <p className="text-sm text-[#9a3412]">暂无有效报价</p>
            )}
          </div>
        </div>
        {effective && session.permissions.canSeeFloorPrice ? (
          <p className="mt-3 text-sm leading-6">
            底价 {effective.floorPriceYuan} 元 + 临时佣金 {effective.commissionYuan} 元（{effective.commissionPercent}%）= 平台价{" "}
            {effective.platformPriceYuan} 元
          </p>
        ) : null}
        {sku.note ? <p className="mt-2 text-sm text-[#5c6f64]">{sku.note}</p> : null}
      </section>
      <section className="space-y-2 text-sm leading-6 text-[#5c6f64]">
        <p>{rules.unit}</p>
        <p>{rules.commission}</p>
        <p>{rules.overlap}</p>
        <p>{rules.deduction}</p>
      </section>
      <section className="space-y-2">
        <h2 className="font-medium">报价记录</h2>
        {quotes.length === 0 ? <p className="text-sm text-[#5c6f64]">还没有报价。</p> : null}
        {quotes.map((quote) => (
          <article key={quote.id} className="rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]">
            <div className="flex items-center justify-between gap-3">
              <Badge variant={quote.status === "effective" ? "default" : quote.status === "expired" ? "destructive" : "secondary"}>
                {quote.statusLabel}
              </Badge>
              <p className="text-sm">底价 {quote.floorPriceYuan} 元 / {quote.unitLabel}</p>
            </div>
            <p className="mt-2 text-sm text-[#5c6f64]">
              {formatWhen(quote.validFrom)} 至 {formatWhen(quote.validUntil)}
            </p>
            {quote.status === "expired" ? <p className="mt-1 text-sm text-[#9a3412]">已过期，不能当作当前有效价。</p> : null}
            {quote.note ? <p className="mt-1 text-sm">{quote.note}</p> : null}
          </article>
        ))}
      </section>
    </div>
  );
}
