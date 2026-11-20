"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, api } from "@/components/api";
import { ErrorBlock, LoadingBlock } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import { TARGET_DOMAIN_NOTE } from "@/lib/rules";

export type Session = {
  user: {
    id: string;
    displayName: string;
    role: "merchant" | "group" | "platform" | "customer_service";
    roleLabel: string;
    merchantId: string | null;
    merchantName: string | null;
    groupId: string | null;
    groupName: string | null;
  };
  permissions: {
    scope: string;
    canWriteStock: boolean;
    canWriteQuote: boolean;
    canSeeFloorPrice: boolean;
    canEditCommission: boolean;
    canEditOwnCommission?: boolean;
    canEditAnyCommission?: boolean;
    description: string;
  };
  disclaimer: string;
  targetDomain: string;
  targetDomainNote: string;
  stackNote: string;
};

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const value = useContext(SessionContext);
  if (!value) throw new Error("会话尚未就绪");
  return value;
}

const LINKS = [
  { href: "/", label: "首页" },
  { href: "/products", label: "商品" },
  { href: "/quotes", label: "报价" },
  { href: "/inbound", label: "入库" },
  { href: "/outbound", label: "出库" },
  { href: "/inventory", label: "库存" },
  { href: "/payments", label: "付款" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<Session>("/api/me")
      .then((data) => {
        if (active) setSession(data);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 401) {
          router.replace("/login");
          return;
        }
        setError(reason instanceof Error ? reason.message : "无法读取登录状态");
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6">
        <ErrorBlock message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6">
        <LoadingBlock label="正在确认登录状态…" />
      </div>
    );
  }

  return (
    <SessionContext.Provider value={session}>
      <div className="min-h-full">
        <header className="bg-[#146c43] text-white">
          <div className="mx-auto flex max-w-5xl items-start justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-xs text-white/75">建议 / 临时预览</p>
              <p className="text-lg font-semibold leading-6">原生AI智能报价</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium">{session.user.displayName}</p>
              <p className="text-xs text-white/75">{session.user.roleLabel}</p>
              <button type="button" className="mt-1 text-xs underline underline-offset-2" onClick={() => void logout()}>
                退出登录
              </button>
            </div>
          </div>
          <nav className="mx-auto hidden max-w-5xl gap-2 px-4 pb-3 md:flex" aria-label="主导航">
            {LINKS.map((link) => (
              <NavLink key={link.href} href={link.href} active={pathname === link.href} />
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-4 pb-28 md:pb-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-24 text-center text-xs leading-5 text-[#5c6f64] md:pb-6">
          <p>{session.disclaimer}</p>
          <p className="mt-1">{TARGET_DOMAIN_NOTE}</p>
        </footer>
        <nav
          className="fixed inset-x-0 bottom-0 z-20 flex gap-1 overflow-x-auto border-t border-[#d5e3d8] bg-white px-2 py-2 md:hidden"
          aria-label="主导航"
        >
          {LINKS.map((link) => (
            <NavLink key={link.href} href={link.href} active={pathname === link.href} compact />
          ))}
        </nav>
      </div>
    </SessionContext.Provider>
  );
}

function NavLink({ href, active, compact = false }: { href: string; active: boolean; compact?: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        buttonVariants({ variant: active ? "default" : "ghost", size: "default" }),
        compact ? "h-10 shrink-0 px-3" : "h-8 bg-white/10 text-white hover:bg-white/20 hover:text-white",
        compact && !active ? "text-[#173024]" : "",
        !compact && active ? "bg-white text-[#146c43] hover:bg-white" : "",
      )}
    >
      {LINKS.find((link) => link.href === href)?.label}
    </Link>
  );
}
