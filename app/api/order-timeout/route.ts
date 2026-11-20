import { handleGetTimeoutConfig, handlePutTimeoutConfig } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleGetTimeoutConfig(request);
}

export function PUT(request: Request) {
  return handlePutTimeoutConfig(request);
}
