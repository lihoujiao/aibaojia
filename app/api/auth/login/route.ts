import { handleLogin } from "@/lib/http/handlers";

export function POST() {
  return handleLogin();
}
