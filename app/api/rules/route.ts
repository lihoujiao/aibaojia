import { handleRules } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleRules(request);
}
