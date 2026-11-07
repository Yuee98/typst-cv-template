import { fixtureAvailability } from "@/lib/polish/fixtures";
import { polishExpectedRouteFromAvailability } from "@/lib/polish/contract";
import type { PolishPostRequest } from "@/lib/polish/contract";
export const CLIENT_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
export const EXPECTED_ROUTE = polishExpectedRouteFromAvailability(fixtureAvailability().availability)!;
export function makeRequest(overrides: Partial<PolishPostRequest> = {}): PolishPostRequest {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    granularity: "item",
    sectionId: "profile",
    language: "zh",
    items: [{
      id: "i0",
      kind: "profile",
      text: "五年后端开发经验，专注高并发分布式系统。"
    }],
    context: {
      level: 0,
      references: []
    },
    expectedRoute: EXPECTED_ROUTE,
    ...overrides
  };
}
export const SUCCESS_BODY = {
  requestId: "srv-1",
  items: [{
    id: "i0",
    polished: "六年后端开发经验，专注高并发分布式系统。"
  }],
  quota: {
    limit: 20,
    remaining: 19,
    resetAt: "2026-08-03T00:00:00.000Z"
  }
};
export const ENABLED_AVAILABILITY_BODY = fixtureAvailability();
export const DISABLED_AVAILABILITY_BODY = {
  ...fixtureAvailability(),
  availability: {
    ...fixtureAvailability().availability,
    enabled: false,
    options: [],
    defaultOptionId: null
  }
};
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}
export function fetchReturning(response: Response | Promise<Response>): typeof fetch {
  return (() => Promise.resolve(response)) as unknown as typeof fetch;
}
