import type { PolishRequest } from "@/lib/polish/contract";

export const CLIENT_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

export function makeRequest(overrides: Partial<PolishRequest> = {}): PolishRequest {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    granularity: "item",
    sectionId: "profile",
    language: "zh",
    items: [{ id: "i0", kind: "profile", text: "五年后端开发经验，专注高并发分布式系统。" }],
    context: { level: 0, references: [] },
    ...overrides,
  };
}

export const SUCCESS_BODY = {
  requestId: "srv-1",
  items: [{ id: "i0", polished: "六年后端开发经验，专注高并发分布式系统。" }],
  quota: { limit: 20, remaining: 19, resetAt: "2026-08-03T00:00:00.000Z" },
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function fetchReturning(response: Response | Promise<Response>): typeof fetch {
  return (() => Promise.resolve(response)) as unknown as typeof fetch;
}
