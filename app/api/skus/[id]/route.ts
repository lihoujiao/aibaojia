import { handleGetSku } from "@/lib/http/handlers";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleGetSku(request, id);
}
