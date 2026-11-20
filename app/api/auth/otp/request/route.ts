import { handleRequestOtp } from "@/lib/http/handlers";

export function POST(request: Request) {
  return handleRequestOtp(request);
}
