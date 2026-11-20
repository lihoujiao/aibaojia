import { handleLedger } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleLedger(request);
}
