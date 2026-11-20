import { OUT_OF_SCOPE } from "@/lib/rules";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function OutOfScope() {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">非本轮范围</h2>
        <p className="text-sm text-[#5c6f64]">这些入口只作导航示意，灰色不可用，没有伪造页面。</p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {OUT_OF_SCOPE.map((item) => (
          <Button
            key={item}
            type="button"
            variant="outline"
            disabled
            className="h-auto flex-col items-start gap-1 px-3 py-3 text-left whitespace-normal"
          >
            <span>{item}</span>
            <Badge variant="secondary">非本轮范围</Badge>
          </Button>
        ))}
      </div>
    </section>
  );
}
