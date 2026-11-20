import { handleListOrders } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleListOrders(request);
}
