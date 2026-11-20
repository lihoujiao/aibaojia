import { handleCreateOrder, handleListOrders } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleListOrders(request);
}

export function POST(request: Request) {
  return handleCreateOrder(request);
}
