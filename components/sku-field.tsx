"use client";

import { Label } from "@/components/ui/label";
import type { PriceBreakdown, SkuRecord } from "@/lib/types";

type SkuCard = SkuRecord & { effective: PriceBreakdown | null };

export function SkuField({
  skus,
  skuId,
  onChange,
}: {
  skus: SkuCard[];
  skuId: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="sku-id">规格</Label>
      <select
        id="sku-id"
        className="h-10 w-full rounded-lg border border-input bg-white px-2.5 text-sm"
        value={skuId}
        onChange={(event) => onChange(event.target.value)}
        required
      >
        {skus.map((sku) => (
          <option key={sku.id} value={sku.id}>
            {sku.merchantName} · {sku.productName} · {sku.specName} · 可用 {sku.availableBase} {sku.baseUnitLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
