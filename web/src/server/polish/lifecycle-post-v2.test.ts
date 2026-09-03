import { describe, expect, it, vi } from "vitest";

import {
  polishErrorResponseSchema,
  polishSuccessResponseSchema,
  type PolishErrorCode,
} from "@/lib/polish/contract";
import {
  createPolishPostV2Handler,
  toExpectedRouteV1,
  type PolishPostV2Deps,
  type PolishPostV2HttpLogEvent,
} from "./lifecycle-post-v2";
import type {
  PolishLifecycleV2FailureCode,
  PolishLifecycleV2Input,
  PolishLifecycleV2Result,
} from "./lifecycle-v2";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const CLIENT_REQUEST_ID = "00000000-0000-4000-8000-000000000003";
const RESET_AT = "2026-08-26T00:00:00.000Z";
const NOW = Date.parse("2026-08-25T12:00:00.000Z");

const EXPECTED_ROUTE = {
  schemaVersion: "expected_route_v1",
  configGeneration: "7",
  profileVersionId: "00000000-0000-4000-8000-000000000011",
  legalBundleVersion: "2026-08-23-multi-provider-v1",
  runtimeContractId: "deepseek-g2-runtime-v1",
} as const;

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    granularity: "item",
    sectionId: "experience",
    language: "zh",
    items: [
      {
        id: "i0",
        kind: "experience_bullet",
        text: "负责后端服务开发，将 P99 延迟降低 40%。",
      },
    ],
    context: { level: 0, references: [] },
    expectedRoute: EXPECTED_ROUTE,
    ...overrides,
  };
}

function post(options: {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
} = {}): Request {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/json",
  };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? "valid-token"}`;
  return new Request("https://test.local/api/polish", {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? requestBody()),
  });
}

function success(): Extract<PolishLifecycleV2Result, { ok: true }> {
  return {
    ok: true,
    requestId: REQUEST_ID,
    items: [{ id: "i0", polished: "主导后端服务开发，将 P99 延迟降低 40%。" }],
    quota: { limit: 20, remaining: 19, resetAt: RESET_AT },
    profileVersionId: EXPECTED_ROUTE.profileVersionId,
    displayDisclosureKey: "deepseek-official-v1",
    attemptCount: 1,
    settlement: "confirmed",
  };
}

function failure(
  code: PolishLifecycleV2FailureCode,
  overrides: Partial<Extract<PolishLifecycleV2Result, { ok: false }>> = {},
): PolishLifecycleV2Result {
  return {
    ok: false,
    requestId: REQUEST_ID,
    code,
    stage: "reserve",
    attemptCount: 0,
    settlement: "not_reserved",
    ...overrides,
  };
}

function makeDeps(
  result: PolishLifecycleV2Result = success(),
  overrides: Partial<PolishPostV2Deps> = {},
): {
  deps: PolishPostV2Deps;
  verifyAccessToken: ReturnType<typeof vi.fn>;
  executeLifecycle: ReturnType<typeof vi.fn>;
  logs: PolishPostV2HttpLogEvent[];
} {
  const verifyAccessToken = vi.fn(async (token: string) =>
    token === "valid-token" ? USER_ID : null,
  );
  const executeLifecycle = vi.fn(async (input: PolishLifecycleV2Input) => {
    void input;
    return result;
  });
  const logs: PolishPostV2HttpLogEvent[] = [];
  return {
    deps: {
      verifyAccessToken,
      executeLifecycle,
      now: () => NOW,
      createRequestId: () => REQUEST_ID,
      logger: (event) => logs.push(event),
      ...overrides,
    },
    verifyAccessToken,
    executeLifecycle,
    logs,
  };
}

async function expectError(
  response: Response,
  status: number,
  code: PolishErrorCode,
): Promise<ReturnType<typeof polishErrorResponseSchema.parse>> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
  const parsed = polishErrorResponseSchema.parse(await response.json());
  expect(parsed.requestId).toBe(REQUEST_ID);
  expect(parsed.error.code).toBe(code);
  return parsed;
}

describe("V2 expected-route conversion", () => {
  it("preserves exactly the assertion-only six-field object", () => {
    const converted = toExpectedRouteV1(EXPECTED_ROUTE);
    expect(converted).toEqual(EXPECTED_ROUTE);
    expect(Object.keys(converted).sort()).toEqual(Object.keys(EXPECTED_ROUTE).sort());
    expect(() =>
      toExpectedRouteV1({
        ...EXPECTED_ROUTE,
        provider: "deepseek",
      } as typeof EXPECTED_ROUTE),
    ).toThrow();
  });
});

describe("POST /api/polish — V2 HTTP boundary", () => {
  it("is login-only and never executes for missing, malformed or invalid bearer tokens", async () => {
    for (const candidate of [
      post({ token: null }),
      new Request("https://test.local/api/polish", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Basic abc" },
        body: JSON.stringify(requestBody()),
      }),
    ]) {
      const mocks = makeDeps();
      await expectError(await createPolishPostV2Handler(mocks.deps)(candidate), 401, "UNAUTHORIZED");
      expect(mocks.verifyAccessToken).not.toHaveBeenCalled();
      expect(mocks.executeLifecycle).not.toHaveBeenCalled();
    }

    const mocks = makeDeps(success(), {
      verifyAccessToken: vi.fn(async () => null),
    });
    await expectError(
      await createPolishPostV2Handler(mocks.deps)(post()),
      401,
      "UNAUTHORIZED",
    );
    expect(mocks.executeLifecycle).not.toHaveBeenCalled();
  });

  it("maps authentication infrastructure failure before reading lifecycle state", async () => {
    const rawDetail = "raw auth infrastructure detail";
    const mocks = makeDeps(success(), {
      verifyAccessToken: vi.fn(async () => {
        throw new Error(rawDetail);
      }),
    });
    const response = await createPolishPostV2Handler(mocks.deps)(post());
    const body = await expectError(response, 500, "INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain(rawDetail);
    expect(mocks.executeLifecycle).not.toHaveBeenCalled();
  });

  it("rejects missing/malformed/partial routes and every client selector before lifecycle", async () => {
    const candidates = [
      requestBody({ expectedRoute: undefined }),
      requestBody({ expectedRoute: { ...EXPECTED_ROUTE, configGeneration: 7 } }),
      requestBody({
        expectedRoute: {
          ...EXPECTED_ROUTE,
          profileVersionId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1",
        },
      }),
      requestBody({
        expectedRoute: { ...EXPECTED_ROUTE, runtimeContractId: null },
      }),
      requestBody({
        expectedRoute: { ...EXPECTED_ROUTE, provider: "deepseek" },
      }),
      requestBody({ provider: "deepseek" }),
      requestBody({ model: "deepseek-v4-flash" }),
      requestBody({ profileVersionId: EXPECTED_ROUTE.profileVersionId }),
      requestBody({ clientRequestId: "123E4567-E89B-42D3-A456-426614174000" }),
    ];
    for (const body of candidates) {
      const mocks = makeDeps();
      await expectError(
        await createPolishPostV2Handler(mocks.deps)(post({ body })),
        400,
        "INVALID_REQUEST",
      );
      expect(mocks.executeLifecycle).not.toHaveBeenCalled();
    }
  });

  it("preserves bounded JSON/content validation before lifecycle", async () => {
    for (const candidate of [
      post({ rawBody: "{" }),
      post({ contentType: "text/plain" }),
      post({ body: requestBody({ items: [] }) }),
    ]) {
      const mocks = makeDeps();
      await expectError(
        await createPolishPostV2Handler(mocks.deps)(candidate),
        400,
        "INVALID_REQUEST",
      );
      expect(mocks.executeLifecycle).not.toHaveBeenCalled();
    }
  });

  it("passes one exact authenticated content request and assertion to V2", async () => {
    const mocks = makeDeps();
    const candidate = post();
    const response = await createPolishPostV2Handler(mocks.deps)(candidate);
    expect(response.status).toBe(200);
    const parsed = polishSuccessResponseSchema.parse(await response.json());
    expect(parsed.requestId).toBe(REQUEST_ID);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(mocks.verifyAccessToken).toHaveBeenCalledOnce();
    expect(mocks.executeLifecycle).toHaveBeenCalledOnce();
    const input = mocks.executeLifecycle.mock.calls[0]?.[0] as PolishLifecycleV2Input;
    expect(input).toMatchObject({
      authenticatedUserId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      expectedRoute: EXPECTED_ROUTE,
    });
    expect(input.request).not.toHaveProperty("expectedRoute");
    expect(input.signal).toBe(candidate.signal);
    expect(mocks.logs).toEqual([
      {
        event: "polish.v2.http.served",
        requestId: REQUEST_ID,
        attemptCount: 1,
        settlement: "confirmed",
        latencyMs: 0,
      },
    ]);
  });

  it.each([
    ["AI_DISABLED", 503, "AI_DISABLED"],
    ["SERVICE_UNAVAILABLE", 503, "SERVICE_UNAVAILABLE"],
    ["QUOTA_EXCEEDED", 429, "QUOTA_EXCEEDED"],
    ["RATE_LIMITED", 429, "RATE_LIMITED"],
    ["DUPLICATE_REQUEST", 409, "DUPLICATE_REQUEST"],
    ["REQUEST_IN_PROGRESS", 409, "REQUEST_IN_PROGRESS"],
    ["AI_ROUTE_CHANGED", 409, "AI_ROUTE_CHANGED"],
    ["AI_TERMS_REQUIRED", 403, "AI_TERMS_REQUIRED"],
    ["UPSTREAM_ERROR", 502, "UPSTREAM_ERROR"],
    ["UPSTREAM_TIMEOUT", 504, "UPSTREAM_TIMEOUT"],
    ["INVALID_MODEL_OUTPUT", 502, "INVALID_MODEL_OUTPUT"],
  ] as const)("projects safe lifecycle failure %s", async (source, status, target) => {
    const mocks = makeDeps(failure(source));
    await expectError(
      await createPolishPostV2Handler(mocks.deps)(post()),
      status,
      target,
    );
  });

  it("projects quota/reset and retry metadata without internal fields", async () => {
    const quota = makeDeps(
      failure("QUOTA_EXCEEDED", {
        resetAt: RESET_AT,
        remaining: 0,
      }),
    );
    const quotaBody = await expectError(
      await createPolishPostV2Handler(quota.deps)(post()),
      429,
      "QUOTA_EXCEEDED",
    );
    expect(quotaBody.error.resetAt).toBe(RESET_AT);
    expect(quotaBody.error.retryAfterSeconds).toBe(43_200);
    expect(quotaBody.error).not.toHaveProperty("remaining");

    const rate = makeDeps(
      failure("RATE_LIMITED", {
        retryAfterSeconds: 17,
      }),
    );
    const rateBody = await expectError(
      await createPolishPostV2Handler(rate.deps)(post()),
      429,
      "RATE_LIMITED",
    );
    expect(rateBody.error.retryAfterSeconds).toBe(17);
  });

  it.each([
    "INVALID_INPUT",
    "RESERVATION_UNKNOWN",
    "EXECUTION_NOT_FOUND",
    "EXECUTION_ALREADY_FINALIZED",
    "EXECUTION_INVALID",
    "ATTEMPT_START_DENIED",
    "ATTEMPT_STATE_UNKNOWN",
    "ATTEMPT_PERSISTENCE_ERROR",
    "CANCELED",
    "SETTLEMENT_CONFLICT",
    "SETTLEMENT_REJECTED",
    "INTERNAL_ERROR",
  ] as const)("collapses internal lifecycle failure %s to a fixed 500", async (code) => {
    const mocks = makeDeps(failure(code));
    await expectError(
      await createPolishPostV2Handler(mocks.deps)(post()),
      500,
      "INTERNAL_ERROR",
    );
  });

  it("maps a missing runtime attestation to retryable service unavailability", async () => {
    const mocks = makeDeps(failure("PROFILE_UNAVAILABLE"));
    const body = await expectError(
      await createPolishPostV2Handler(mocks.deps)(post()),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(body.error.retryAfterSeconds).toBe(300);
  });

  it("fails closed on result identity/response drift and unexpected throws", async () => {
    const mismatched = makeDeps({
      ...success(),
      requestId: "00000000-0000-4000-8000-000000000099",
    });
    await expectError(
      await createPolishPostV2Handler(mismatched.deps)(post()),
      500,
      "INTERNAL_ERROR",
    );

    const malformed = makeDeps({
      ...success(),
      quota: { limit: 20, remaining: 19, resetAt: "not-a-date" },
    });
    await expectError(
      await createPolishPostV2Handler(malformed.deps)(post()),
      500,
      "INTERNAL_ERROR",
    );

    const rawDetail = "raw RPC or provider detail";
    const thrown = makeDeps(success(), {
      executeLifecycle: vi.fn(async () => {
        throw new Error(rawDetail);
      }),
    });
    const response = await createPolishPostV2Handler(thrown.deps)(post());
    const body = await expectError(response, 500, "INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain(rawDetail);
    expect(JSON.stringify(thrown.logs)).not.toContain(rawDetail);
  });

  it("keeps logger failure non-authoritative", async () => {
    const mocks = makeDeps(success(), {
      logger: () => {
        throw new Error("logger unavailable");
      },
    });
    const response = await createPolishPostV2Handler(mocks.deps)(post());
    expect(response.status).toBe(200);
  });
});
