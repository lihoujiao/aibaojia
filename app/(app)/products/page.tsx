"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, api } from "@/components/api";
import { useRemote } from "@/components/use-remote";
import { useSession } from "@/components/session";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UNIT_RULE } from "@/lib/rules";
import type { PriceBreakdown, SkuRecord } from "@/lib/types";

type SkuCard = SkuRecord & { effective: PriceBreakdown | null };

export default function ProductsPage() {
  const session = useSession();
  const skuQuery = useRemote<{ skus: SkuCard[] }>("/api/skus");
  const skus = skuQuery.data?.skus ?? null;
  const error = skuQuery.error;
  const [productName, setProductName] = useState("");
  const [specName, setSpecName] = useState("");
  const [unitLabel, setUnitLabel] = useState("斤");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function createSku() {
    setSaving(true);
    setFormError(null);
    try {
      await api("/api/skus", {
        method: "POST",
        body: JSON.stringify({
          productName,
          specName,
          unitLabel,
          note: "示例商品，非真实货源",
        }),
      });
      setProductName("");
      setSpecName("");
      skuQuery.reload();
    } catch (reason) {
      setFormError(reason instanceof ApiError ? reason.message : "没有创建");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">商品与规格</h1>
        <p className="mt-1 text-sm leading-6 text-[#5c6f64]">{UNIT_RULE}</p>
      </div>
      {session.permissions.canWriteStock ? (
        <form
          className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]"
          onSubmit={(event) => {
            event.preventDefault();
            void createSku();
          }}
        >
          <h2 className="font-medium">新建规格</h2>
          <p className="text-sm text-[#5c6f64]">新建后库存为 0。要增加现货，请走采购入库。</p>
          <div className="grid gap-3 md:grid-cols-3">
            <Field id="product-name" label="商品" value={productName} onChange={setProductName} placeholder="例如：云南苹果" />
            <Field id="spec-name" label="规格" value={specName} onChange={setSpecName} placeholder="例如：一级果" />
            <Field id="unit-label" label="单位" value={unitLabel} onChange={setUnitLabel} placeholder="斤 / 箱 / 件" />
          </div>
          {formError ? <p className="text-sm text-[#b42318]">{formError}</p> : null}
          <Button type="submit" className="h-10" disabled={saving}>
            {saving ? "保存中…" : "保存规格"}
          </Button>
        </form>
      ) : (
        <p className="rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-[#d5e3d8]">当前身份不能新建或修改商品。</p>
      )}
      {error ? <ErrorBlock message={error} onRetry={skuQuery.reload} /> : null}
      {!skus && !error ? <LoadingBlock /> : null}
      {skus && skus.length === 0 ? <EmptyBlock title="还没有规格" detail="供货商家可以在上面新建，库存要从入库单增加。" /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {skus?.map((sku) => (
          <Link key={sku.id} href={`/products/${sku.id}`} className="rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-[#146c43]">{sku.merchantName}</p>
                <h2 className="text-lg font-medium">
                  {sku.productName}
                  <span className="ml-2 text-sm font-normal text-[#5c6f64]">{sku.specName}</span>
                </h2>
              </div>
              <p className="text-right">
                <span className="block text-xl font-semibold text-[#146c43]">{sku.onHand}</span>
                <span className="text-xs text-[#5c6f64]">{sku.unitLabel}</span>
              </p>
            </div>
            <p className="mt-3 text-sm">
              {sku.effective ? (
                <span className="font-medium text-[#e86a17]">平台价 {sku.effective.platformPriceYuan} 元 / {sku.unitLabel}</span>
              ) : (
                <span className="text-[#9a3412]">暂无有效报价</span>
              )}
            </p>
            {session.permissions.canSeeFloorPrice && sku.effective ? (
              <p className="mt-1 text-xs text-[#5c6f64]">底价 {sku.effective.floorPriceYuan} 元 · 建议/临时佣金 {sku.effective.commissionPercent}%</p>
            ) : null}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} required />
    </div>
  );
}
