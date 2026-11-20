import { handleGetCommission, handleUpdateCommission } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleGetCommission(request);
}

export function PATCH(request: Request) {
  return handleUpdateCommission(request);
}
