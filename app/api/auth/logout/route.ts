import { handleLogout } from "@/lib/http/handlers";

export function POST() {
  return handleLogout();
}
