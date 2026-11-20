import { handleUpdateUnit } from "@/lib/http/handlers";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleUpdateUnit(request, id);
}
