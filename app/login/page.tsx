"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/components/api";
import { ErrorBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SMS_NOTE, STACK_NOTE, TARGET_DOMAIN_NOTE, VIRTUAL_PHONES } from "@/lib/rules";

export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<"request" | "verify" | null>(null);

  async function requestCode() {
    setPending("request");
    setError(null);
    try {
      const result = await api<{ message: string }>("/api/auth/otp/request", {
        method: "POST",
        body: JSON.stringify({ phone }),
      });
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "没有发出验证码");
    } finally {
      setPending(null);
    }
  }

  async function verify() {
    setPending("verify");
    setError(null);
    try {
      await api("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, code }) });
      router.replace("/");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "没有完成登录");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-lg flex-col px-4 py-6">
      <header className="rounded-2xl bg-[#146c43] px-5 py-6 text-white">
        <p className="text-xs text-white/75">手机验证码登录</p>
        <h1 className="mt-1 text-2xl font-semibold">原生AI智能报价</h1>
        <p className="mt-2 text-sm leading-6 text-white/85">{SMS_NOTE}</p>
      </header>
      <form
        className="mt-4 space-y-3 rounded-xl bg-white p-4 ring-1 ring-[#d5e3d8]"
        onSubmit={(event) => {
          event.preventDefault();
          void verify();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="phone">手机号</Label>
          <Input id="phone" inputMode="numeric" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} required />
        </div>
        <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void requestCode()}>
          {pending === "request" ? "提交中…" : "获取验证码"}
        </Button>
        <div className="space-y-1.5">
          <Label htmlFor="code">验证码</Label>
          <Input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
        </div>
        {notice ? <p className="text-sm text-[#5c6f64]">{notice}</p> : null}
        {error ? <ErrorBlock message={error} /> : null}
        <Button type="submit" variant="trade" className="h-11 w-full" disabled={pending !== null}>
          {pending === "verify" ? "验证中…" : "登录"}
        </Button>
      </form>
      <section className="mt-4 rounded-xl bg-white p-4 text-sm leading-6 ring-1 ring-[#d5e3d8]">
        <p>自动化测试使用虚拟号码，不是真实联系人，当前环境也不会向它们发短信：</p>
        <ul className="mt-2 space-y-1">
          {VIRTUAL_PHONES.map((item) => (
            <li key={item.phone}>
              {item.title} · {item.roleLabel} · {item.phone}
            </li>
          ))}
        </ul>
      </section>
      <p className="mt-4 text-xs leading-5 text-[#5c6f64]">{STACK_NOTE}</p>
      <p className="mt-1 text-xs leading-5 text-[#5c6f64]">{TARGET_DOMAIN_NOTE}</p>
    </div>
  );
}
