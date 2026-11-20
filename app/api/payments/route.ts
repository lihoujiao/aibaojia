import { handlePayments } from "@/lib/http/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handlePayments(request);
}
