import { handleVerifyOtp } from "@/lib/http/handlers";

export function POST(request: Request) {
  return handleVerifyOtp(request);
}
