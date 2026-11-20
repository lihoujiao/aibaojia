import { handleMe } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleMe(request);
}
