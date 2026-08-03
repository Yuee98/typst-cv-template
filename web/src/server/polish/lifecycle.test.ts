/**
 * Route-level DI tests for the polish request lifecycle (unit 2.3).
 *
 * The boundaries mocked here are auth, quota, and the single-transmission
 * provider; the REAL orchestrator (prompt build, level trimming, output
 * validation, retry policy) runs inside every test, so these tests also
 * cover the handler ↔ orchestrator integration end to end.
 */

import { describe, expect, it, vi } from "vitest";

import {
  MAX_BODY_BYTES,
  polishQuotaResponseSchema,
  polishSuccessResponseSchema,
  type PolishErrorCode,
} from "@/lib/polish/contract";
import { PolishProviderError, type PolishProviderResult } from "./provider";
import { PolishQuotaError } from "./quota";
import {
  createPolishHandlers,
  POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
  type PolishLogEvent,
  type PolishRouteDeps,
} from "./lifecycle";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "valid-access-token";
const USER_ID = "user-uuid-1";
const REQUEST_ID = "req-fixed-id-1";
const RESERVATION_ID = "11111111-2222-4333-8444-555555555555";
const RESET_AT = "2026-08-03T00:00:00+00:00";
/** Wire form of RESET_AT: the frozen schema only accepts ISO UTC ("Z"). */
const RESET_AT_Z = new Date(RESET_AT).toISOString();
const FIXED_NOW = Date.parse("2026-08-02T12:00:00.000Z");

const VALID_ZH_TEXT = "负责后端服务开发，将 P99 延迟降低 40%。";

interface RequestBodyOverrides {
  [key: string]: unknown;
}

function validRequestBody(overrides: RequestBodyOverrides = {}): Record<string, unknown> {
  return {
    clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
    granularity: "item",
    sectionId: "experience",
    language: "zh",
    items: [{ id: "i0", kind: "experience_bullet", text: VALID_ZH_TEXT }],
    context: { level: 0, references: [] },
    ...overrides,
  };
}

interface PostOptions {
  token?: string | null;
  rawBody?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  bodyStream?: ReadableStream<Uint8Array>;
}

function postRequest(options: PostOptions = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? VALID_TOKEN}`;
  }
  const body = options.bodyStream ?? options.rawBody ?? JSON.stringify(validRequestBody());
  return new Request("https://test.local/api/polish", {
    method: "POST",
    headers,
    body,
    signal: options.signal,
    // @ts-expect-error undici extension required for streaming bodies in Node
    duplex: "half",
  });
}

function quotaRequest(options: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? VALID_TOKEN}`;
  }
  return new Request("https://test.local/api/polish/quota", { headers });
}

// ---------------------------------------------------------------------------
// Mock provider (per-attempt behaviors, records calls)
// ---------------------------------------------------------------------------

interface ProviderCall {
  request: Parameters<PolishRouteDeps["provider"]["complete"]>[0];
  options: { signal: AbortSignal; timeoutMs: number };
}

type ProviderBehavior = (call: ProviderCall) => Promise<PolishProviderResult>;

function makeMockProvider(behaviors: ProviderBehavior[]) {
  const calls: ProviderCall[] = [];
  return {
    calls,
    provider: {
      async complete(request: ProviderCall["request"], options: ProviderCall["options"]) {
        const call: ProviderCall = { request, options };
        calls.push(call);
        const behavior = behaviors[calls.length - 1];
        if (!behavior) throw new Error(`unexpected provider attempt ${calls.length}`);
        return behavior(call);
      },
    } as PolishRouteDeps["provider"],
  };
}

function usage(overrides: Partial<PolishProviderResult["usage"]> = {}) {
  return { promptTokens: 100, completionTokens: 50, cachedReadTokens: 60, uncachedReadTokens: 40, ...overrides };
}

/** Echo the targets like the deterministic fake — always valid output. */
function echoSuccess(call: ProviderCall): Promise<PolishProviderResult> {
  return Promise.resolve({
    text: JSON.stringify({
      items: call.request.targets.map((target) => ({ id: target.id, polished: target.text })),
    }),
    finishReason: "stop",
    usage: usage(),
    providerRequestId: "provider-req-1",
  });
}

function rejectWith(error: unknown): ProviderBehavior {
  return () => Promise.reject(error);
}

function resolveWith(result: PolishProviderResult): ProviderBehavior {
  return () => Promise.resolve(result);
}

// ---------------------------------------------------------------------------
// Mock route deps
// ---------------------------------------------------------------------------

interface DepMocks {
  deps: PolishRouteDeps;
  logs: PolishLogEvent[];
  providerCalls: ProviderCall[];
  verifyAccessToken: ReturnType<typeof vi.fn>;
  hasAcceptedCurrentAiTerms: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  markProviderStarted: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  getQuota: ReturnType<typeof vi.fn>;
  providerUserId: ReturnType<typeof vi.fn>;
}

function makeDeps(
  providerBehaviors: ProviderBehavior[] = [echoSuccess],
  overrides: Partial<PolishRouteDeps> = {},
): DepMocks {
  const { provider, calls } = makeMockProvider(providerBehaviors);
  const logs: PolishLogEvent[] = [];
  const deps: PolishRouteDeps = {
    verifyAccessToken: vi.fn(async (token: string) => (token === VALID_TOKEN ? USER_ID : null)),
    hasAcceptedCurrentAiTerms: vi.fn(async () => true),
    reserve: vi.fn(async () => ({
      reservationId: RESERVATION_ID,
      limit: 20,
      remaining: 19,
      resetAt: RESET_AT,
    })),
    markProviderStarted: vi.fn(async () => ({ started: true, attemptCount: 1 })),
    // Mirrors the real finalize RPC: the post-settlement quota snapshot is
    // returned atomically (relay #8), so the success path never re-reads.
    finalize: vi.fn(async () => ({
      alreadyFinalized: false,
      quota: { limit: 20, remaining: 19, resetAt: RESET_AT },
    })),
    getQuota: vi.fn(async () => ({ limit: 20, remaining: 19, resetAt: RESET_AT })),
    provider,
    providerUserId: vi.fn(() => "hmac-sha256-hex-pseudonymous-id"),
    model: "test-model",
    aiPolishEnabled: true,
    now: () => FIXED_NOW,
    createRequestId: () => REQUEST_ID,
    logger: (event) => logs.push(event),
    ...overrides,
  };
  return {
    deps,
    logs,
    providerCalls: calls,
    verifyAccessToken: deps.verifyAccessToken as ReturnType<typeof vi.fn>,
    hasAcceptedCurrentAiTerms: deps.hasAcceptedCurrentAiTerms as ReturnType<typeof vi.fn>,
    reserve: deps.reserve as ReturnType<typeof vi.fn>,
    markProviderStarted: deps.markProviderStarted as ReturnType<typeof vi.fn>,
    finalize: deps.finalize as ReturnType<typeof vi.fn>,
    getQuota: deps.getQuota as ReturnType<typeof vi.fn>,
    providerUserId: deps.providerUserId as ReturnType<typeof vi.fn>,
  };
}

function handlersOf(mocks: DepMocks) {
  return createPolishHandlers(mocks.deps);
}

async function expectErrorShape(
  response: Response,
  status: number,
  code: PolishErrorCode,
): Promise<{
  requestId: string;
  error: { code: string; message: string; resetAt?: string; retryAfterSeconds?: number };
}> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
  const body = (await response.json()) as {
    requestId: string;
    error: { code: string; message: string; resetAt?: string; retryAfterSeconds?: number };
  };
  expect(body.requestId).toBe(REQUEST_ID);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body;
}

// ---------------------------------------------------------------------------
// POST /api/polish — pre-reserve denials
// ---------------------------------------------------------------------------

describe("POST /api/polish — deployment switch and auth", () => {
  it("503 AI_DISABLED when the deployment switch is off, before any auth work", async () => {
    const mocks = makeDeps([echoSuccess], { aiPolishEnabled: false });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "AI_DISABLED");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
    expect(mocks.verifyAccessToken).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("401 UNAUTHORIZED without an Authorization header", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ token: null }));

    await expectErrorShape(response, 401, "UNAUTHORIZED");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("401 UNAUTHORIZED for an invalid/expired token", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ token: "wrong-token" }));

    await expectErrorShape(response, 401, "UNAUTHORIZED");
    expect(mocks.verifyAccessToken).toHaveBeenCalledWith("wrong-token");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("403 AI_TERMS_REQUIRED when the current AI terms are not accepted", async () => {
    const mocks = makeDeps([echoSuccess], {
      hasAcceptedCurrentAiTerms: vi.fn(async () => false),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 403, "AI_TERMS_REQUIRED");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});

describe("POST /api/polish — bounded reader and request validation", () => {
  it("400 INVALID_REQUEST for a non-JSON content type", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ headers: { "content-type": "text/plain" } }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("413 PAYLOAD_TOO_LARGE when Content-Length exceeds the cap (body never read)", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ headers: { "content-length": String(MAX_BODY_BYTES + 1) } }),
    );

    await expectErrorShape(response, 413, "PAYLOAD_TOO_LARGE");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("413 PAYLOAD_TOO_LARGE when the streamed body grows past the cap without Content-Length", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 3 chunks × 32 KiB = 96 KiB > 64 KiB cap
        for (let index = 0; index < 3; index += 1) {
          controller.enqueue(encoder.encode("x".repeat(32 * 1024)));
        }
        controller.close();
      },
    });
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ bodyStream: stream }));

    await expectErrorShape(response, 413, "PAYLOAD_TOO_LARGE");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("400 INVALID_REQUEST for an empty body", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ rawBody: "" }));

    await expectErrorShape(response, 400, "INVALID_REQUEST");
  });

  it("400 INVALID_REQUEST for malformed JSON", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ rawBody: "{not json" }));

    await expectErrorShape(response, 400, "INVALID_REQUEST");
  });

  it.each([
    ["unknown top-level key", { ...validRequestBody(), path: "experience[0].items[0]" }],
    ["unknown items[].path key (RHF path must never cross the wire)", (() => {
      const body = validRequestBody();
      (body.items as Record<string, unknown>[])[0].path = "experience[0].items[0]";
      return body;
    })()],
    ["header PII attempt", { ...validRequestBody(), header: { name: "张三", email: "a@b.c" } }],
  ])("400 INVALID_REQUEST on strictObject rejection: %s", async (_label, body) => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(body) }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("400 INVALID_REQUEST when item granularity carries two items", async () => {
    const body = validRequestBody({
      items: [
        { id: "i0", kind: "experience_bullet", text: VALID_ZH_TEXT },
        { id: "i1", kind: "experience_bullet", text: "优化数据库查询，将响应时间缩短 30%。" },
      ],
    });
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(body) }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("400 INVALID_REQUEST for a whitespace-only item text", async () => {
    const body = validRequestBody({
      items: [{ id: "i0", kind: "experience_bullet", text: "  　  " }],
    });
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(body) }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
  });
});

describe("POST /api/polish — reserve denials (dedup, quota, rate limit, kill switch)", () => {
  function reserveDenial(code: PolishErrorCode, extras: { resetAt?: string; retryAfterSeconds?: number } = {}) {
    return vi.fn(async () => {
      throw new PolishQuotaError(code, `denied: ${code}`, extras);
    });
  }

  it("409 REQUEST_IN_PROGRESS for an in-flight duplicate clientRequestId", async () => {
    const mocks = makeDeps([echoSuccess], { reserve: reserveDenial("REQUEST_IN_PROGRESS") });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 409, "REQUEST_IN_PROGRESS");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("409 DUPLICATE_REQUEST for an already-settled clientRequestId", async () => {
    const mocks = makeDeps([echoSuccess], { reserve: reserveDenial("DUPLICATE_REQUEST") });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 409, "DUPLICATE_REQUEST");
    expect(mocks.providerCalls).toHaveLength(0);
  });

  it("429 QUOTA_EXCEEDED carries resetAt + computed Retry-After", async () => {
    const mocks = makeDeps([echoSuccess], {
      reserve: reserveDenial("QUOTA_EXCEEDED", { resetAt: RESET_AT }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    const body = await expectErrorShape(response, 429, "QUOTA_EXCEEDED");
    // FIXED_NOW → RESET_AT is exactly 12h; resetAt is normalized to ISO UTC.
    expect(body.error.resetAt).toBe(RESET_AT_Z);
    expect(body.error.retryAfterSeconds).toBe(43_200);
    expect(response.headers.get("retry-after")).toBe("43200");
  });

  it("429 RATE_LIMITED passes retryAfterSeconds through to body + Retry-After", async () => {
    const mocks = makeDeps([echoSuccess], {
      reserve: reserveDenial("RATE_LIMITED", { retryAfterSeconds: 17 }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    const body = await expectErrorShape(response, 429, "RATE_LIMITED");
    expect(body.error.retryAfterSeconds).toBe(17);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("503 AI_DISABLED when the runtime kill switch denies the reserve", async () => {
    const mocks = makeDeps([echoSuccess], { reserve: reserveDenial("AI_DISABLED") });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "AI_DISABLED");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
  });

  it("503 SERVICE_UNAVAILABLE when the global daily limit is reached", async () => {
    const mocks = makeDeps([echoSuccess], { reserve: reserveDenial("SERVICE_UNAVAILABLE") });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "SERVICE_UNAVAILABLE");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
  });

  it("500 INTERNAL_ERROR when the reserve RPC itself fails (fixed client message, relay #10)", async () => {
    const mocks = makeDeps([echoSuccess], { reserve: reserveDenial("INTERNAL_ERROR") });
    const response = await handlersOf(mocks).POST(postRequest());

    const body = await expectErrorShape(response, 500, "INTERNAL_ERROR");
    // Raw PostgREST/DB detail never crosses the API boundary.
    expect(body.error.message).toBe("Internal quota service error.");
  });
});

// ---------------------------------------------------------------------------
// POST /api/polish — orchestration outcomes and settlement
// ---------------------------------------------------------------------------

describe("POST /api/polish — success path", () => {
  it("200 success: response shape, headers, settlement, and structured log", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);

    const body = (await response.json()) as unknown;
    const parsed = polishSuccessResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as { requestId: string }).requestId).toBe(REQUEST_ID);
    expect((body as { items: { id: string; polished: string }[] }).items).toEqual([
      { id: "i0", polished: VALID_ZH_TEXT },
    ]);
    expect((body as { quota: unknown }).quota).toEqual({ limit: 20, remaining: 19, resetAt: RESET_AT_Z });

    // provider request: HMAC pseudonymous id + targets metadata, never the raw user id
    expect(mocks.providerUserId).toHaveBeenCalledWith(USER_ID);
    expect(mocks.providerCalls).toHaveLength(1);
    expect(mocks.providerCalls[0].request.providerUserId).toBe("hmac-sha256-hex-pseudonymous-id");
    expect(JSON.stringify(mocks.providerCalls[0].request)).not.toContain(USER_ID);
    expect(mocks.providerCalls[0].request.targets).toEqual([{ id: "i0", text: VALID_ZH_TEXT }]);

    // settlement: charged + billable + usage + full metadata
    expect(mocks.markProviderStarted).toHaveBeenCalledWith(RESERVATION_ID);
    expect(mocks.finalize).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      status: "succeeded",
      quotaCharged: true,
      providerBillable: true,
      usage: {
        inputCachedTokens: 60,
        inputUncachedTokens: 40,
        outputTokens: 50,
        usageComplete: true,
      },
      metadata: {
        granularity: "item",
        itemCount: 1,
        contextLevel: 0,
        language: "zh",
        model: "test-model",
        promptVersion: expect.any(String),
        validatorVersion: expect.any(String),
        attemptCount: 1,
        providerRequestId: "provider-req-1",
        finishReason: "stop",
        latencyMs: 0,
      },
    });
    expect(mocks.getQuota).not.toHaveBeenCalled(); // quota came from the atomic finalize snapshot

    // structured log: metadata only (the type carries no content fields)
    const completed = mocks.logs.find((log) => log.event === "polish.request.completed");
    expect(completed).toMatchObject({
      requestId: REQUEST_ID,
      userId: USER_ID,
      attempts: 1,
      providerRequestId: "provider-req-1",
      inputCachedTokens: 60,
      inputUncachedTokens: 40,
      outputTokens: 50,
      latencyMs: 0,
    });
  });

  it("retry succeeds: transport failure then success — charged once, usage summed, 2 marks", async () => {
    const mocks = makeDeps([
      rejectWith(new PolishProviderError("UPSTREAM_ERROR", "upstream 500")),
      echoSuccess,
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    expect(mocks.providerCalls).toHaveLength(2);
    // one user-visible request == one quota charge (Invariant 6)
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        quotaCharged: true,
        metadata: expect.objectContaining({ attemptCount: 2 }),
      }),
    );
    // every provider attempt was marked (global cost accounting, Invariant 7)
    expect(mocks.markProviderStarted).toHaveBeenCalledTimes(2);
  });

  it("500 when finalize fails after a successful polish (reconciler refunds)", async () => {
    const mocks = makeDeps([echoSuccess], {
      finalize: vi.fn(async () => {
        throw new PolishQuotaError("INTERNAL_ERROR", "finalize RPC failed");
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.logs.some((log) => log.event === "polish.finalize_failed")).toBe(true);
  });

  it("200 when getQuota throws: the atomic finalize snapshot serves the response (relay #8)", async () => {
    // Orchestration + finalize succeed; the ancillary quota read is broken.
    // The response must still be served (never "charged + no result") and
    // the broken read is never even attempted while the snapshot exists.
    const mocks = makeDeps([echoSuccess], {
      getQuota: vi.fn(async () => {
        throw new PolishQuotaError("INTERNAL_ERROR", "get quota RPC failed: connection reset");
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: unknown; items: unknown };
    expect(body.quota).toEqual({ limit: 20, remaining: 19, resetAt: RESET_AT_Z });
    expect(body.items).toEqual([{ id: "i0", polished: VALID_ZH_TEXT }]);
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded", quotaCharged: true }));
    expect(mocks.getQuota).not.toHaveBeenCalled();
  });

  it("200 without a finalize snapshot: falls back to a direct quota read", async () => {
    const mocks = makeDeps([echoSuccess], {
      finalize: vi.fn(async () => ({ alreadyFinalized: false })), // no quota key (older/fake wiring)
    });
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: unknown };
    expect(body.quota).toEqual({ limit: 20, remaining: 19, resetAt: RESET_AT_Z });
    expect(mocks.getQuota).toHaveBeenCalledWith(USER_ID);
  });

  it("200 when the quota read fails without a finalize snapshot: reserve snapshot is the last-resort fallback", async () => {
    const mocks = makeDeps([echoSuccess], {
      finalize: vi.fn(async () => ({ alreadyFinalized: false })),
      getQuota: vi.fn(async () => {
        throw new PolishQuotaError("INTERNAL_ERROR", "get quota RPC failed: connection reset");
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: unknown };
    // Point-in-time snapshot from the reserve (limit/remaining/resetAt).
    expect(body.quota).toEqual({ limit: 20, remaining: 19, resetAt: RESET_AT_Z });
    expect(mocks.logs.some((log) => log.event === "polish.quota_read_failed")).toBe(true);
  });
});

describe("POST /api/polish — failure settlement (refund paths)", () => {
  it("504 UPSTREAM_TIMEOUT after two timed-out attempts: refunded, billability unknown", async () => {
    const mocks = makeDeps([
      rejectWith(new PolishProviderError("UPSTREAM_TIMEOUT", "timed out")),
      rejectWith(new PolishProviderError("UPSTREAM_TIMEOUT", "timed out")),
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 504, "UPSTREAM_TIMEOUT");
    expect(mocks.providerCalls).toHaveLength(2);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed_upstream",
        quotaCharged: false,
        // Upstream calls were entered but no usage came back: absence of
        // usage is not proof of zero cost → billability UNKNOWN (null).
        providerBillable: null,
        metadata: expect.objectContaining({ failureStage: "provider_timeout", attemptCount: 2 }),
      }),
    );
  });

  it("502 UPSTREAM_ERROR after two failed attempts: refunded", async () => {
    const mocks = makeDeps([
      rejectWith(new PolishProviderError("UPSTREAM_ERROR", "HTTP 500", { upstreamStatus: 500 })),
      rejectWith(new PolishProviderError("UPSTREAM_ERROR", "HTTP 500", { upstreamStatus: 500 })),
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 502, "UPSTREAM_ERROR");
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed_upstream",
        quotaCharged: false,
        metadata: expect.objectContaining({ failureStage: "provider_http" }),
      }),
    );
    // upstreamStatus reaches the structured log, never the response body
    const failed = mocks.logs.find((log) => log.event === "polish.request.failed");
    expect(failed).toMatchObject({ code: "UPSTREAM_ERROR", upstreamStatus: 500 });
  });

  it("502 INVALID_MODEL_OUTPUT after two invalid responses: refunded but billable (content was returned)", async () => {
    const invalid: PolishProviderResult = {
      text: '{"items":[{"id":"i0","polished":"truncated',
      finishReason: "stop",
      usage: usage(),
    };
    const mocks = makeDeps([resolveWith(invalid), resolveWith(invalid)]);
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 502, "INVALID_MODEL_OUTPUT");
    expect(mocks.providerCalls).toHaveLength(2);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "invalid_output",
        quotaCharged: false, // 两次失败返还
        providerBillable: true, // real cost: content WAS produced
        usage: {
          inputCachedTokens: 120,
          inputUncachedTokens: 80,
          outputTokens: 100,
          usageComplete: true,
        },
        metadata: expect.objectContaining({ failureStage: "json_parse", attemptCount: 2 }),
      }),
    );
  });

  it("500 INTERNAL_ERROR + released when mark_provider_started says the reservation is settled", async () => {
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => ({ started: false, attemptCount: null })),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    const body = await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal quota service error."); // fixed, no internals (relay #10)
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", quotaCharged: false }),
    );
  });
});

describe("POST /api/polish — cancellation settlement", () => {
  it("cancel after provider call entry: charged, billability unknown without usage (取消照扣)", async () => {    const controller = new AbortController();
    const mocks = makeDeps([
      (call) => {
        controller.abort();
        return Promise.reject(call.options.signal.reason);
      },
    ]);
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    // The client is gone; the response is moot but must still be well-formed.
    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        quotaCharged: true,
        // The call was entered but aborted before any usage came back:
        // billability is UNKNOWN (null), not provably free and not provable cost.
        providerBillable: null,
        metadata: expect.objectContaining({ failureStage: "canceled" }),
      }),
    );
    expect(mocks.logs.some((log) => log.event === "polish.request.canceled")).toBe(true);
  });

  it("cancel before the provider starts: released and refunded", async () => {
    const controller = new AbortController();
    controller.abort();
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.markProviderStarted).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", quotaCharged: false, providerBillable: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/polish — terminal progress settlement (relay #3/#2):
// usage and providerCallEntered survive EVERY exit path
// ---------------------------------------------------------------------------

describe("POST /api/polish — terminal progress settlement (relay #3)", () => {
  const INVALID_WITH_USAGE: PolishProviderResult = {
    text: JSON.stringify({ items: [{ id: "i0", polished: "将延迟降低 99%。" }] }), // loses P99/40%
    finishReason: "stop",
    usage: usage(),
    providerRequestId: "provider-req-1",
  };

  it("attempt 1 invalid with usage → abort before attempt 2: canceled, charged once, attempt-1 usage recorded", async () => {
    const controller = new AbortController();
    const mocks = makeDeps([
      () => {
        // The caller aborts AFTER attempt 1 returned its (invalid) result,
        // so the orchestrator's loop-top check fires before attempt 2.
        controller.abort();
        return Promise.resolve(INVALID_WITH_USAGE);
      },
    ]);
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.providerCalls).toHaveLength(1); // attempt 2 never started
    expect(mocks.markProviderStarted).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        quotaCharged: true, // one user-visible request == one charge
        providerBillable: true, // attempt-1 content WAS produced
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: false, // a later attempt's tokens are unknowable
        },
        metadata: expect.objectContaining({ failureStage: "canceled" }),
      }),
    );
  });

  it("attempt 1 invalid with usage → attempt-2 mark fails: refunded, attempt-1 usage still recorded and billable", async () => {
    const mocks = makeDeps([resolveWith(INVALID_WITH_USAGE)], {
      markProviderStarted: vi
        .fn()
        .mockResolvedValueOnce({ started: true, attemptCount: 1 })
        .mockRejectedValueOnce(
          new PolishQuotaError("INTERNAL_ERROR", "mark_provider_started RPC failed: connection reset"),
        ),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    const body = await expectErrorShape(response, 500, "INTERNAL_ERROR");
    // Raw RPC detail never crosses the API (relay #10).
    expect(body.error.message).toBe("Internal quota service error.");
    expect(mocks.providerCalls).toHaveLength(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        // NOT "released": attempt 1 really reached the provider (#3.2).
        status: "failed_upstream",
        quotaCharged: false, // refunded: no usable result
        providerBillable: true, // attempt-1 usage is a proven cost
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: true,
        },
      }),
    );
  });

  it("abort while the first mark RPC is pending: provider not called, user quota refunded", async () => {
    const controller = new AbortController();
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => {
        // The caller aborts DURING the ledger mark; the RPC still succeeds.
        controller.abort();
        return { started: true, attemptCount: 1 };
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    // A successful ledger mark is NOT evidence of an upstream call (#3.3):
    // the orchestrator rechecks the signal after the mark and never enters
    // the provider, so the request is released, not charged.
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "released",
        quotaCharged: false,
        providerBillable: false,
      }),
    );
  });

  it("global-cap denial at attempt 2: no provider call, refunded, attempt-1 usage kept, 503 not 500 (relay #2)", async () => {
    const mocks = makeDeps([resolveWith(INVALID_WITH_USAGE)], {
      markProviderStarted: vi
        .fn()
        .mockResolvedValueOnce({ started: true, attemptCount: 1 })
        .mockRejectedValueOnce(
          new PolishQuotaError(
            "SERVICE_UNAVAILABLE",
            "AI polish is temporarily unavailable (daily capacity reached).",
          ),
        ),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "SERVICE_UNAVAILABLE");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
    expect(mocks.providerCalls).toHaveLength(1); // attempt 2 never called the provider
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed_upstream",
        quotaCharged: false, // user refunded: no usable result delivered
        providerBillable: true, // attempt-1 usage retained as cost
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: true,
        },
      }),
    );
  });

  it("global-cap denial at attempt 1: released, refunded, 503", async () => {
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => {
        throw new PolishQuotaError(
          "SERVICE_UNAVAILABLE",
          "AI polish is temporarily unavailable (daily capacity reached).",
        );
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "SERVICE_UNAVAILABLE");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "released",
        quotaCharged: false,
        providerBillable: false,
      }),
    );
  });

  it("kill-switch denial (AI_DISABLED) at the mark: released, refunded, 503 AI_DISABLED", async () => {
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => {
        throw new PolishQuotaError("AI_DISABLED", "AI polish is currently disabled.");
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "AI_DISABLED");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", quotaCharged: false, providerBillable: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/polish — level-role trimming end to end (CP2 mandatory proof)
// ---------------------------------------------------------------------------

describe("POST /api/polish — server-side level-role trimming (Invariant 3)", () => {
  const SIBLING = "SIBLING-SENTINEL-ALLOWED";
  const SCOPE = "SCOPE-META-SENTINEL-ALLOWED";
  const PROFILE = "PROFILE-SENTINEL-NEVER-SENT";
  const SKILL = "SKILL-SENTINEL-NEVER-SENT";

  function leveledBody(level: 1 | 2) {
    return validRequestBody({
      context: {
        level,
        references: [
          { role: "sibling", text: `${SIBLING} 兄弟条目内容` },
          { role: "scope_metadata", text: `${SCOPE} 区块元数据` },
          { role: "profile", text: `${PROFILE} profile 摘要` },
          { role: "skill", text: `${SKILL} 技能标签` },
        ],
      },
    });
  }

  function allProviderText(mocks: DepMocks): string {
    return mocks.providerCalls
      .flatMap((call) => call.request.messages.map((message) => message.content))
      .join("\n");
  }

  it("level 1: profile/skill references are dropped BEFORE prompt construction and never reach the provider", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(leveledBody(1)) }),
    );

    expect(response.status).toBe(200);
    expect(mocks.providerCalls).toHaveLength(1);
    const sent = allProviderText(mocks);
    expect(sent).toContain(SIBLING);
    expect(sent).toContain(SCOPE);
    expect(sent).not.toContain(PROFILE);
    expect(sent).not.toContain(SKILL);
  });

  it("level 2: profile/skill references are allowed through", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(leveledBody(2)) }),
    );

    expect(response.status).toBe(200);
    const sent = allProviderText(mocks);
    expect(sent).toContain(SIBLING);
    expect(sent).toContain(SCOPE);
    expect(sent).toContain(PROFILE);
    expect(sent).toContain(SKILL);
  });
});

// ---------------------------------------------------------------------------
// GET /api/polish/quota
// ---------------------------------------------------------------------------

describe("GET /api/polish/quota", () => {
  it("200 quota shape: login checked, AI terms NOT required", async () => {
    const mocks = makeDeps([], {
      hasAcceptedCurrentAiTerms: vi.fn(async () => {
        throw new Error("must not be called by the quota route");
      }),
    });
    const response = await handlersOf(mocks).GET(quotaRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);

    const body = (await response.json()) as unknown;
    expect(polishQuotaResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { requestId: string }).requestId).toBe(REQUEST_ID);
    expect((body as { quota: unknown }).quota).toEqual({ limit: 20, remaining: 19, resetAt: RESET_AT_Z });

    expect(mocks.verifyAccessToken).toHaveBeenCalledWith(VALID_TOKEN);
    expect(mocks.hasAcceptedCurrentAiTerms).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("401 UNAUTHORIZED without a token", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).GET(quotaRequest({ token: null }));

    await expectErrorShape(response, 401, "UNAUTHORIZED");
    expect(mocks.getQuota).not.toHaveBeenCalled();
  });

  it("503 AI_DISABLED when the deployment switch is off", async () => {
    const mocks = makeDeps([], { aiPolishEnabled: false });
    const response = await handlersOf(mocks).GET(quotaRequest());

    await expectErrorShape(response, 503, "AI_DISABLED");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
  });

  it("500 INTERNAL_ERROR when the quota read fails", async () => {
    const mocks = makeDeps([], {
      getQuota: vi.fn(async () => {
        throw new PolishQuotaError("INTERNAL_ERROR", "get quota RPC failed");
      }),
    });
    const response = await handlersOf(mocks).GET(quotaRequest());

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
  });
});
