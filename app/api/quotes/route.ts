import { handleCreateQuote, handleListQuotes } from "@/lib/http/handlers";

export function GET(request: Request) {
  return handleListQuotes(request);
}

export function POST(request: Request) {
  return handleCreateQuote(request);
}
