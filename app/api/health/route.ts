import { handleHealth } from "@/lib/http/handlers";

export function GET() {
  return handleHealth();
}
