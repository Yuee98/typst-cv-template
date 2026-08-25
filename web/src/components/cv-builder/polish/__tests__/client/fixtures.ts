import type {
  PolishAvailabilityResponse,
  PolishExpectedRoute,
  PolishPostRequest,
} from "@/lib/polish/contract";

export const CLIENT_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

export const EXPECTED_ROUTE = {
  schemaVersion: "expected_route_v1",
  configGeneration: "42",
  profileVersionId: "11111111-1111-4111-8111-111111111111",
  legalBundleVersion: "2026-08-23-multi-provider-v1",
  runtimeContractId: "runtime.deepseek-v2.v1",
  runtimeContractSha256: "a".repeat(64),
} satisfies PolishExpectedRoute;

export function makeRequest(overrides: Partial<PolishPostRequest> = {}): PolishPostRequest {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    granularity: "item",
    sectionId: "profile",
    language: "zh",
    items: [{ id: "i0", kind: "profile", text: "五年后端开发经验，专注高并发分布式系统。" }],
    context: { level: 0, references: [] },
    expectedRoute: EXPECTED_ROUTE,
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
    configGeneration: EXPECTED_ROUTE.configGeneration,
    routingPolicyVersionId: "00000000-0000-4000-8000-000000000042",
    profileVersionId: EXPECTED_ROUTE.profileVersionId,
    legalBundleVersion: EXPECTED_ROUTE.legalBundleVersion,
    runtimeContractId: EXPECTED_ROUTE.runtimeContractId,
    runtimeContractSha256: EXPECTED_ROUTE.runtimeContractSha256,
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
