import type { PolishAvailabilityResponse, PolishRequest } from "@/lib/polish/contract";

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

export const ENABLED_AVAILABILITY_BODY = {
  requestId: "srv-availability-1",
  availability: {
    enabled: true,
    configGeneration: "42",
    routingPolicyVersionId: "00000000-0000-4000-8000-000000000042",
    profileVersionId: "11111111-1111-4111-8111-111111111111",
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    runtimeContractId: "runtime.deepseek-v2.v1",
    runtimeContractSha256: "a".repeat(64),
    displayDisclosure: {
      key: "deepseek-official-v1",
      providerName: "DeepSeek",
      modelName: "DeepSeek V4 Flash",
    },
    termsAccepted: true,
  },
} satisfies PolishAvailabilityResponse;

export const DISABLED_AVAILABILITY_BODY = {
  requestId: "srv-availability-disabled",
  availability: {
    enabled: false,
    configGeneration: null,
    routingPolicyVersionId: null,
    profileVersionId: null,
    legalBundleVersion: null,
    runtimeContractId: null,
    runtimeContractSha256: null,
    displayDisclosure: null,
    termsAccepted: false,
  },
} satisfies PolishAvailabilityResponse;

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function fetchReturning(response: Response | Promise<Response>): typeof fetch {
  return (() => Promise.resolve(response)) as unknown as typeof fetch;
}
