export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = (await response.json()) as { ok?: boolean; data?: T; message?: string; code?: string };
  if (!response.ok || body.ok === false) {
    throw new ApiError(body.message || "请求失败", response.status, body.code || "REQUEST_FAILED");
  }
  return body.data as T;
}
