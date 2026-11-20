"use client";

import { useState } from "react";
import { ApiError, api } from "@/components/api";
import { useRemote } from "@/components/use-remote";
import { useSession } from "@/components/session";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatYuanFromCents } from "@/lib/pricing";

type Interest = {
  calculable: boolean;
  officialInterestCents: number | null;
  reasons: string[];
  pricingNote: string;
  facts: {
    paymentMethod: string | null;
    termDays: number | null;
    capitalCostAnnualPercent: string | null;
    overdueAnnualPercent: string | null;
    principalCents: number | null;
    principalPaidCents: number;
    principalRemainingCents: number | null;
    batches: Array<{ id: string; qtyBase: number; shipDate: string; termEnd: string | null; overdueStart: string | null }>;
    paymentDayAccruesInterest: boolean;
  };
};
type PayOrder = {
  id: string;
  productName: string;
  specName: string;
  paymentMethod: string | null;
  termDays: number | null;
  capitalCostAnnualPercent: string | null;
  overdueAnnualPercent: string | null;
  principalCents: number | null;
  principalPaidCents: number;
  interest: Interest | null;
  repayments: Array<{ id: string; amountCents: number; appliedPrincipalCents: number; unallocatedCents: number; paidOn: string }>;
};

const METHOD_LABEL: Record<string, string> = { cash: "现金", barter: "易货", term: "限期" };

export default function PaymentsPage() {
  const session = useSession();
  const query = useRemote<{ orders: PayOrder[] }>(session.permissions.scope === "none" ? null : "/api/payments");
  const orders = query.data?.orders ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">付款与限期</h1>
        <p className="mt-1 text-sm leading-6 text-[#5c6f64]">
          已确认现金、易货、限期三种方式。限期天数和两套年利率都要显式填写，十天、二十天不是默认。标价沿用现有底价加佣金，底价不是已确认的真实采购成本。
        </p>
        <p className="mt-1 text-sm leading-6 text-[#9a3412]">
          限内资金成本是单利，年利率按 365 天折算。逾期利息按一个月结转一次。进入逾期后资金成本继续计，同时加收逾期利息。发货当天是限期第 1 天，N 天的最后一天是发货日加 N-1 个自然日，逾期从第二天开始。付款当天不计息，但不改到期日。年利率按百分比输入，5.25 表示 5.25%。计息时四舍五入保留到分；若和「不足一分钱直接舍弃」冲突，以四舍五入到分的结果为准，0.016 元是 0.02 元。整单协议价怎么分到各批、部分还本之后怎么计息、月结锚点和不足月都还没确认，所以正式总额仍不可计算，页面不会用 0 充当利息。
        </p>
      </div>
      {session.permissions.scope === "none" ? <p className="rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-[#d5e3d8]">当前身份不能查看付款。</p> : null}
      {query.error ? <ErrorBlock message={query.error} onRetry={query.reload} /> : null}
      {!orders && !query.error && session.permissions.scope !== "none" ? <LoadingBlock /> : null}
      {orders && orders.length === 0 ? <EmptyBlock title="还没有订单" detail="下单之后可以在这里登记付款方式。" /> : null}
      <div className="space-y-3">
        {orders?.map((order) => (
          <PayCard key={order.id} order={order} canWrite={session.permissions.canWriteStock} onChanged={query.reload} />
        ))}
      </div>
    </div>
  );
}

function PayCard({ order, canWrite, onChanged }: { order: PayOrder; canWrite: boolean; onChanged: () => void }) {
  const [method, setMethod] = useState("");
  const [agreement, setAgreement] = useState("");
  const [termDays, setTermDays] = useState("");
  const [capital, setCapital] = useState("");
  const [overdue, setOverdue] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/orders/${order.id}/payment-terms`, {
        method: "POST",
        body: JSON.stringify({
          method,
          agreementPriceCents: Number(agreement),
          termDays: method === "term" ? Number(termDays) : null,
          capitalCostAnnualPercent: method === "term" ? capital.trim() : null,
          overdueAnnualPercent: method === "term" ? overdue.trim() : null,
        }),
      });
      setMethod("");
      setAgreement("");
      setTermDays("");
      setCapital("");
      setOverdue("");
      setMessage("已登记。之后不覆盖，因为是否允许改写还没确认。");
      onChanged();
    } catch (reason) {
      setMessage(reason instanceof ApiError ? reason.message : "没有登记");
    } finally {
      setBusy(false);
    }
  }

  async function repay() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ appliedPrincipalCents: number; unallocatedCents: number; replayed: boolean }>(`/api/orders/${order.id}/repayments`, {
        method: "POST",
        body: JSON.stringify({ amountCents: Number(amount), paidOn, idempotencyKey: crypto.randomUUID() }),
      });
      setAmount("");
      setPaidOn("");
      setMessage(result.unallocatedCents > 0 ? `已先还本金 ${formatYuanFromCents(result.appliedPrincipalCents)} 元。超出的 ${formatYuanFromCents(result.unallocatedCents)} 元没有冲减，余款怎么处理还没确认。` : `已先还本金 ${formatYuanFromCents(result.appliedPrincipalCents)} 元。`);
      onChanged();
    } catch (reason) {
      setMessage(reason instanceof ApiError ? reason.message : "没有记账");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="space-y-3 rounded-xl bg-white p-4 text-sm ring-1 ring-[#d5e3d8]">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-medium">{order.productName} · {order.specName}</h2>
        <p className="text-[#e86a17]">{order.paymentMethod ? METHOD_LABEL[order.paymentMethod] : "未登记付款方式"}</p>
      </div>
      {order.principalCents != null ? <p>下单时协议价本金 {formatYuanFromCents(order.principalCents)} 元，已还本金 {formatYuanFromCents(order.principalPaidCents)} 元。标价快照不作为本金。</p> : <p>没有下单时协议价，本金计算被阻断，不会改用标价。</p>}
      {order.paymentMethod === "term" ? (
        <p>限期 {order.termDays} 个自然日。资金成本年利率 {order.capitalCostAnnualPercent}%，逾期年利率 {order.overdueAnnualPercent}%。5.25 表示 5.25%，不是 5.25 基点。</p>
      ) : null}
      {order.interest ? (
        <div className="rounded-lg bg-[#fff7f1] px-3 py-2 text-[#9a3412]">
          <p>{order.interest.calculable ? "可计算" : "正式利息不可计算"}。金额字段为空，不是 0。</p>
          <p className="mt-1">{order.interest.reasons.join("、")}</p>
          <p className="mt-1">{order.interest.pricingNote} 付款当天不计息：{order.interest.facts.paymentDayAccruesInterest ? "是" : "否"}。</p>
        </div>
      ) : null}
      {order.interest?.facts.batches.length ? (
        <ul className="space-y-1 text-[#5c6f64]">
          {order.interest.facts.batches.map((batch) => (
            <li key={batch.id}>发货日 {batch.shipDate} 为第 1 天{batch.termEnd ? `，限期最后一天 ${batch.termEnd}，逾期从 ${batch.overdueStart} 起` : ""}。Asia/Shanghai。{batch.qtyBase} 个基准单位。本金不拆到这一批。付款当天不计息，到期日不因此改动。</li>
          ))}
        </ul>
      ) : null}
      {order.repayments.map((item) => (
        <p key={item.id} className="text-[#5c6f64]">还款 {item.paidOn}：先还本金 {formatYuanFromCents(item.appliedPrincipalCents)} 元{item.unallocatedCents > 0 ? `，未冲减 ${formatYuanFromCents(item.unallocatedCents)} 元` : ""}。</p>
      ))}
      {canWrite && !order.paymentMethod ? (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`agree-${order.id}`}>下单时协议价（分）</Label>
            <Input id={`agree-${order.id}`} inputMode="numeric" placeholder="显式填写，不抄标价" value={agreement} onChange={(event) => setAgreement(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`method-${order.id}`}>付款方式</Label>
            <select id={`method-${order.id}`} className="h-10 w-full rounded-lg border border-input bg-white px-2.5 text-sm" value={method} onChange={(event) => setMethod(event.target.value)}>
              <option value="">请选择</option>
              <option value="cash">现金</option>
              <option value="barter">易货</option>
              <option value="term">限期</option>
            </select>
          </div>
          {method === "term" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={`days-${order.id}`}>限期天数</Label>
                <Input id={`days-${order.id}`} inputMode="numeric" placeholder="正整数，不预填" value={termDays} onChange={(event) => setTermDays(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`capital-${order.id}`}>资金成本年利率（百分比，最多两位小数）</Label>
                <Input id={`capital-${order.id}`} inputMode="decimal" placeholder="百分比，不预填" value={capital} onChange={(event) => setCapital(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`overdue-${order.id}`}>逾期年利率（百分比，最多两位小数）</Label>
                <Input id={`overdue-${order.id}`} inputMode="decimal" placeholder="与资金成本分开填写" value={overdue} onChange={(event) => setOverdue(event.target.value)} />
              </div>
            </>
          ) : null}
          <Button type="button" disabled={busy || !method || !agreement.trim()} onClick={() => void register()}>登记方式</Button>
        </div>
      ) : null}
      {canWrite && order.paymentMethod ? (
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor={`amount-${order.id}`}>还款金额（分）</Label>
            <Input id={`amount-${order.id}`} inputMode="numeric" placeholder="正整数分" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`date-${order.id}`}>付款日</Label>
            <Input id={`date-${order.id}`} placeholder="YYYY-MM-DD" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
          </div>
          <Button type="button" className="self-end" disabled={busy || !amount.trim() || !paidOn.trim()} onClick={() => void repay()}>先还本金</Button>
        </div>
      ) : null}
      {message ? <p>{message}</p> : null}
    </article>
  );
}
