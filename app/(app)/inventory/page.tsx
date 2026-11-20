"use client";

import Link from "next/link";
import { useRemote } from "@/components/use-remote";
import { formatWhen } from "@/components/format";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { UNIT_RULE } from "@/lib/rules";
import type { PriceBreakdown, SkuRecord } from "@/lib/types";

type SkuCard = SkuRecord & { effective: PriceBreakdown | null };
type Entry = {
  id: string;
  merchantName: string;
  productName: string;
  specName: string;
  movementType: "purchase_in" | "sale_out";
  movementLabel: string;
  qtyDelta: number;
  qtyAfter: number;
  unitLabel: string;
  refDocId: string;
  actorName: string;
  note: string;
  createdAt: string;
};

export default function InventoryPage() {
  const skuQuery = useRemote<{ skus: SkuCard[] }>("/api/skus");
  const ledgerQuery = useRemote<{ entries: Entry[] }>("/api/ledger");
  const skus = skuQuery.data?.skus ?? null;
  const entries = ledgerQuery.data?.entries ?? null;
  const error = skuQuery.error || ledgerQuery.error;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">库存与流水</h1>
        <p className="mt-1 text-sm leading-6 text-[#5c6f64]">{UNIT_RULE} 下面按规格分别列出，不把斤、箱、件加在一起。</p>
      </div>
      {error ? (
        <ErrorBlock
          message={error}
          onRetry={() => {
            skuQuery.reload();
            ledgerQuery.reload();
          }}
        />
      ) : null}
      {!skus && !error ? <LoadingBlock /> : null}
      {skus && skus.length === 0 ? <EmptyBlock title="范围内没有库存" detail="当前身份看不到可展示的规格。" /> : null}
      <div className="grid gap-2 md:grid-cols-2">
        {skus?.map((sku) => (
          <Link key={sku.id} href={`/products/${sku.id}`} className="flex items-center justify-between rounded-xl bg-white px-4 py-3 ring-1 ring-[#d5e3d8]">
            <span>
              <span className="block text-xs text-[#5c6f64]">{sku.merchantName}</span>
              <span className="font-medium">
                {sku.productName} · {sku.specName}
              </span>
            </span>
            <span className={sku.onHand === 0 ? "font-semibold text-[#b42318]" : "font-semibold text-[#146c43]"}>
              {sku.onHand} {sku.unitLabel}
            </span>
          </Link>
        ))}
      </div>
      <section className="space-y-2">
        <h2 className="font-medium">流水</h2>
        <p className="text-xs text-[#5c6f64]">最近 200 条。每条记下谁在何时改了哪个规格、变动数量和单据号。</p>
        {entries && entries.length === 0 ? <EmptyBlock title="还没有流水" detail="入库或出库确认后会出现在这里。" /> : null}
        {entries?.map((entry) => (
          <article key={entry.id} className="rounded-xl bg-white p-4 text-sm ring-1 ring-[#d5e3d8]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Badge variant={entry.movementType === "purchase_in" ? "default" : "secondary"}>{entry.movementLabel}</Badge>
                <h3 className="mt-2 font-medium">
                  {entry.productName} · {entry.specName}
                </h3>
              </div>
              <p className={entry.qtyDelta > 0 ? "font-semibold text-[#146c43]" : "font-semibold text-[#e86a17]"}>
                {entry.qtyDelta > 0 ? `+${entry.qtyDelta}` : entry.qtyDelta} {entry.unitLabel}
              </p>
            </div>
            <p className="mt-2 text-[#5c6f64]">
              {entry.merchantName} · {entry.actorName} · {formatWhen(entry.createdAt)}
            </p>
            <p className="mt-1">{entry.note}</p>
            <p className="mt-1 text-xs text-[#5c6f64]">
              变动后 {entry.qtyAfter} {entry.unitLabel} · 单据 {entry.refDocId}
            </p>
          </article>
        ))}
      </section>
    </div>
  );
}
