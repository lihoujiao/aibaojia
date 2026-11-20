import { handleDemos } from "@/lib/http/handlers";

export function GET() {
  return handleDemos();
}
