import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">没有这个页面</h1>
      <p className="mt-2 text-sm text-[#5c6f64]">可以回到首页，或从底部导航进入商品、报价、出入库和库存。</p>
      <Link className="mt-4 inline-block text-sm text-[#146c43]" href="/">
        返回首页
      </Link>
    </div>
  );
}
