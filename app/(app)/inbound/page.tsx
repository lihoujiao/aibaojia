"use client";

import { useState } from "react";
import { ApiError, api } from "@/components/api";
import { useRemote } from "@/components/use-remote";
import { formatWhen } from "@/components/format";
import { useSession } from "@/components/session";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SkuField } from "@/components/sku-field";
import { UNIT_RULE } from "@/lib/rules";
import type { PriceBreakdown, SkuRecord } from "@/lib/types";

type SkuCard = SkuRecord & { effective: PriceBreakdown | null };
type Doc = {
  id: string;
  merchantName: string;
  productName: string;
  specName: string;
  qty: number;
  unitLabel: string;
  actorName: string;
  note: string | null;
  createdAt: string;
};

export default function InboundPage() {
  const session = useSession();
  const skuQuery = useRemote<{ skus: SkuCard[] }>("/api/skus");
  const docQuery = useRemote<{ docs: Doc[] }>("/api/inbound");
  const skus = skuQuery.data?.skus ?? null;
  const docs = docQuery.data?.docs ?? null;
  const error = skuQuery.error || docQuery.error;
  const [skuOverride, setSkuOverride] = useState<string | null>(null);
  const [unitOverride, setUnitOverride] = useState<string | null>(null);
  const skuId = skuOverride ?? skus?.[0]?.id ?? "";
  const [qty, setQty] = useState("10");
  const [note, setNote] = useState("示例采购入库，非真实采购");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const selected = skus?.find((sku) => sku.id === skuId);
  const unitId = unitOverride ?? selected?.units[0]?.id ?? "";
  const selectedUnit = selected?.units.find((unit) => unit.id === unitId);

  async function submit() {
    setSaving(true);
    setFormError(null);
    setDone(null);
    try {
      const result = await api<{ onHandBase: number }>("/api/inbound", {
        method: "POST",
        body: JSON.stringify({ skuId, unitId, qty: Number(qty), note }),
      });
      setDone(`已入库，当前现货 ${result.onHandBase} ${selected?.baseUnitLabel ?? selected?.unitLabel ?? ""}。`);
      skuQuery.reload();
      docQuery.reload();
    } catch (reason) {
      setFormError(reason instanceof ApiError ? reason.message : "入库没有完成");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">采购入库</h1>
        <p className="mt-1 text-sm leading-6 text-[#5c6f64]">确认后增加现货，并写下操作人、时间和数量。{UNIT_RULE}</p>
      </div>
      {session.permissions.canWriteStock ? (
        <form
          className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SkuField skus={skus ?? []} skuId={skuId} onChange={setSkuOverride} />
          <div className="space-y-1.5">
            <Label htmlFor="in-unit">本商品单位</Label>
            <select id="in-unit" className="h-10 w-full rounded-lg border border-input bg-white px-2.5 text-sm" value={unitId} onChange={(event) => setUnitOverride(event.target.value)}>
              {(selected?.units ?? []).map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.unitLabel}
                  {unit.isBase ? "（基准）" : ` = ${unit.toBaseNumerator}/${unit.toBaseDenominator} ${selected?.baseUnitLabel}`}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="in-qty">数量{selectedUnit ? `（${selectedUnit.unitLabel}）` : ""}</Label>
            <Input id="in-qty" inputMode="numeric" value={qty} onChange={(event) => setQty(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="in-note">备注</Label>
            <Textarea id="in-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          {formError ? <p className="text-sm text-[#b42318]">{formError}</p> : null}
          {done ? <p className="text-sm text-[#146c43]">{done}</p> : null}
          <Button type="submit" variant="trade" className="h-11 w-full" disabled={saving || !skuId}>
            {saving ? "入库中…" : "确认入库"}
          </Button>
        </form>
      ) : (
        <p className="rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-[#d5e3d8]">当前身份不能办理入库。</p>
      )}
      {error ? (
        <ErrorBlock
          message={error}
          onRetry={() => {
            skuQuery.reload();
            docQuery.reload();
          }}
        />
      ) : null}
      {!docs && !error ? <LoadingBlock /> : null}
      {docs && docs.length === 0 ? <EmptyBlock title="还没有入库单" detail="采购入库确认后会出现在这里，并记入库存流水。" /> : null}
      <div className="space-y-2">
        {docs?.map((doc) => (
          <article key={doc.id} className="rounded-xl bg-white p-4 text-sm ring-1 ring-[#d5e3d8]">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-medium">
                {doc.productName} · {doc.specName}
              </h2>
              <p className="font-semibold text-[#146c43]">
                +{doc.qty} {doc.unitLabel}
              </p>
            </div>
            <p className="mt-1 text-[#5c6f64]">
              {doc.merchantName} · {doc.actorName} · {formatWhen(doc.createdAt)}
            </p>
            <p className="mt-1 text-xs text-[#5c6f64]">单号 {doc.id}</p>
            {doc.note ? <p className="mt-1">{doc.note}</p> : null}
          </article>
        ))}
      </div>
    </div>
  );
}
