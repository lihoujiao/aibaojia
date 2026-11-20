import { handleCreateSku, handleListSkus } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleListSkus(request);
}

export function POST(request: Request) {
  return handleCreateSku(request);
}
