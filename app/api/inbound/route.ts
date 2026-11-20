import { handleCreateInbound, handleListInbound } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleListInbound(request);
}

export function POST(request: Request) {
  return handleCreateInbound(request);
}
