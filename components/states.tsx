import { Button } from "@/components/ui/button";

export function LoadingBlock({ label = "正在读取示例数据…" }: { label?: string }) {
  return (
    <div className="rounded-xl bg-white px-4 py-8 text-center text-sm text-[#5c6f64] ring-1 ring-[#d5e3d8]" role="status">
      {label}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl bg-white px-4 py-6 text-sm ring-1 ring-[#f0c7c3]" role="alert">
      <p className="font-medium text-[#b42318]">没有完成这次操作</p>
      <p className="mt-1 text-[#7a2e28]">{message}</p>
      {onRetry ? (
        <Button className="mt-3" variant="outline" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyBlock({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-xl bg-white px-4 py-8 text-center ring-1 ring-[#d5e3d8]">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-[#5c6f64]">{detail}</p>
    </div>
  );
}
