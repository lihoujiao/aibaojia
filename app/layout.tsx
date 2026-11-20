import type { Metadata, Viewport } from "next";
import { DISCLAIMER } from "@/lib/rules";
import "./globals.css";

export const metadata: Metadata = {
  title: "原生AI智能报价（示例预览）",
  description: "多商家进销存、询报价与出入库的最小预览。商品与价格均为示例，非已上线产品。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#146c43",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full bg-[#f3f6f0] text-[#173024]">
        <p className="bg-[#e7f2eb] px-4 py-2 text-center text-xs leading-5 text-[#146c43]">{DISCLAIMER}</p>
        {children}
      </body>
    </html>
  );
}
