import { handleMerchants } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleMerchants(request);
}
