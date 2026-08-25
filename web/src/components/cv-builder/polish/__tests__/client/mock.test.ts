import { describe, expect, it } from "vitest";
import {
  polishAvailabilityResponseSchema,
  polishExpectedRouteFromAvailability,
  polishSuccessResponseSchema,
  type PolishPostRequest,
} from "@/lib/polish/contract";
import { POLISH_TRANSPORT_ERROR_CODES } from "../../polish-errors";
import {
  createMockPolishClient,
  MOCK_POLISH_AVAILABILITY_RESPONSE,
  mockPolishText,
  PolishApiError,
} from "../../polish-client";
import { makeRequest } from "./fixtures";

const AUTH = { expectedUserId: "user-a" } as const;

function makeMockRequest(overrides: Partial<PolishPostRequest> = {}): PolishPostRequest {
  const expectedRoute = polishExpectedRouteFromAvailability(
    MOCK_POLISH_AVAILABILITY_RESPONSE.availability,
  );
  if (!expectedRoute) throw new Error("mock availability fixture must be enabled");
  return makeRequest({ expectedRoute, ...overrides });
}

describe("mockPolishText", () => {
  it("collapses redundant whitespace when that changes the text", () => {
    expect(mockPolishText("  padded   text  here ")).toBe("padded text here");
  });

  it("adds a visible deterministic marker otherwise", () => {
    expect(mockPolishText("主导订单系统重构。")).toBe("[mock] 主导订单系统重构。");
  });
});

describe("createMockPolishClient", () => {
  it("returns deterministic enabled and dark availability authority", async () => {
    const enabled = await createMockPolishClient({ delayMs: 1 }).getAvailability(AUTH);
    expect(polishAvailabilityResponseSchema.safeParse(enabled).success).toBe(true);
    expect(enabled.availability).toMatchObject({
      enabled: true,
      termsAccepted: true,
      displayDisclosure: {
        key: "deepseek-official-v1",
        providerName: "DeepSeek",
        modelName: "DeepSeek V4 Flash",
      },
    });

    const unaccepted = await createMockPolishClient({
      delayMs: 1,
      termsAccepted: false,
    }).getAvailability(AUTH);
    expect(unaccepted.availability).toMatchObject({ enabled: true, termsAccepted: false });

    const disabled = await createMockPolishClient({
      delayMs: 1,
      availabilityEnabled: false,
    }).getAvailability(AUTH);
    expect(disabled.availability).toEqual({
      enabled: false,
      configGeneration: null,
      routingPolicyVersionId: null,
      profileVersionId: null,
      legalBundleVersion: null,
      runtimeContractId: null,
      runtimeContractSha256: null,
      displayDisclosure: null,
      termsAccepted: false,
    });
  });

  it("returns a contract-valid deterministic success", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    const result = await client.polish(makeMockRequest(), AUTH);
    expect(polishSuccessResponseSchema.safeParse(result).success).toBe(true);
    expect(result.items[0].polished).toBe("[mock] 五年后端开发经验，专注高并发分布式系统。");
    expect(result.quota.remaining).toBe(19);

    const again = await client.polish(
      makeMockRequest({ clientRequestId: "123e4567-e89b-42d3-a456-426614174001" }),
      AUTH,
    );
    expect(again.items[0].polished).toBe(result.items[0].polished);
  });

  it("decrements the in-memory quota and exhausts it", async () => {
    const client = createMockPolishClient({ delayMs: 1, quotaLimit: 1 });
    const quotaBefore = await client.getQuota(AUTH);
    expect(quotaBefore.quota).toMatchObject({ limit: 1, remaining: 1 });

    await client.polish(makeMockRequest(), AUTH);
    const quotaAfter = await client.getQuota(AUTH);
    expect(quotaAfter.quota.remaining).toBe(0);

    const error = (await client
      .polish(
        makeMockRequest({ clientRequestId: "123e4567-e89b-42d3-a456-426614174002" }),
        AUTH,
      )
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.resetAt).toBeDefined();
  });

  it("rejects a reused clientRequestId as DUPLICATE_REQUEST", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    await client.polish(makeMockRequest(), AUTH);
    const error = (await client
      .polish(makeMockRequest(), AUTH)
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("DUPLICATE_REQUEST");
    expect(error.status).toBe(409);
  });

  it("honors the FAIL_UPSTREAM and FAIL_JSON codewords", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    const upstream = (await client
      .polish(makeMockRequest({ styleInstruction: "FAIL_UPSTREAM" }), AUTH)
      .catch((e: unknown) => e)) as PolishApiError;
    expect(upstream.code).toBe("UPSTREAM_ERROR");

    const json = (await client
      .polish(makeMockRequest({ styleInstruction: "FAIL_JSON" }), AUTH)
      .catch((e: unknown) => e)) as PolishApiError;
    expect(json.code).toBe("INVALID_MODEL_OUTPUT");
  });

  it("rejects a malformed request as INVALID_REQUEST", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    const bad = { ...makeMockRequest(), granularity: "section" } as PolishPostRequest;
    const error = (await client.polish(bad, AUTH).catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("INVALID_REQUEST");
  });

  it("SLOW outlasts a caller abort and surfaces REQUEST_ABORTED", async () => {
    const client = createMockPolishClient({ delayMs: 1, slowDelayMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const error = (await client
      .polish(makeMockRequest({ styleInstruction: "SLOW" }), {
        ...AUTH,
        signal: controller.signal,
      })
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.requestAborted);
  });

  it("rejects a stale route assertion instead of echoing caller authority", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    const request = makeMockRequest();
    const error = (await client
      .polish({
        ...request,
        expectedRoute: { ...request.expectedRoute, configGeneration: "1" },
      }, AUTH)
      .catch((caught: unknown) => caught)) as PolishApiError;

    expect(error.code).toBe("AI_ROUTE_CHANGED");
    expect(error.status).toBe(409);
  });

  it("keeps the dark availability authority dark at the POST boundary", async () => {
    const client = createMockPolishClient({ delayMs: 1, availabilityEnabled: false });
    const error = (await client
      .polish(makeMockRequest(), AUTH)
      .catch((caught: unknown) => caught)) as PolishApiError;

    expect(error.code).toBe("AI_DISABLED");
    expect(error.status).toBe(503);
  });
});
