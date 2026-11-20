import { handleConfirmOutbound } from "@/lib/http/handlers";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleConfirmOutbound(request, id);
}
