import { handleRegisterPayment } from "@/lib/http/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleRegisterPayment(request, id);
}
