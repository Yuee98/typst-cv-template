import { expect, vi } from "vitest";
import type { PolishErrorCode } from "@/lib/polish/contract";
import { type PolishProviderResult } from "../../provider";
import { createPolishHandlers, type PolishLogEvent, type PolishRouteDeps } from "../../lifecycle";

export const VALID_TOKEN = "valid-access-token";
export const USER_ID = "user-uuid-1";
export const REQUEST_ID = "req-fixed-id-1";
export const RESERVATION_ID = "11111111-2222-4333-8444-555555555555";
export const RESET_AT = "2026-08-03T00:00:00+00:00";
/** Wire form of RESET_AT: the frozen schema only accepts ISO UTC ("Z"). */
export const RESET_AT_Z = new Date(RESET_AT).toISOString();
export const FIXED_NOW = Date.parse("2026-08-02T12:00:00.000Z");

export const VALID_ZH_TEXT = "负责后端服务开发，将 P99 延迟降低 40%。";

export interface RequestBodyOverrides {
  [key: string]: unknown;
}

export function validRequestBody(overrides: RequestBodyOverrides = {}): Record<string, unknown> {
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

export interface PostOptions {
  token?: string | null;
  rawBody?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  bodyStream?: ReadableStream<Uint8Array>;
}

export function postRequest(options: PostOptions = {}): Request {
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

export function quotaRequest(options: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? VALID_TOKEN}`;
  }
  return new Request("https://test.local/api/polish/quota", { headers });
}

// ---------------------------------------------------------------------------
// Mock provider (per-attempt behaviors, records calls)
// ---------------------------------------------------------------------------

export interface ProviderCall {
  request: Parameters<PolishRouteDeps["provider"]["complete"]>[0];
  options: { signal: AbortSignal; timeoutMs: number };
}

export type ProviderBehavior = (call: ProviderCall) => Promise<PolishProviderResult>;

export function makeMockProvider(behaviors: ProviderBehavior[]) {
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

export function usage(overrides: Partial<PolishProviderResult["usage"]> = {}) {
  return { promptTokens: 100, completionTokens: 50, cachedReadTokens: 60, uncachedReadTokens: 40, ...overrides };
}

/** Echo the targets like the deterministic fake — always valid output. */
export function echoSuccess(call: ProviderCall): Promise<PolishProviderResult> {
  return Promise.resolve({
    text: JSON.stringify({
      items: call.request.targets.map((target) => ({ id: target.id, polished: target.text })),
    }),
    finishReason: "stop",
    usage: usage(),
    providerRequestId: "provider-req-1",
  });
}

export function rejectWith(error: unknown): ProviderBehavior {
  return () => Promise.reject(error);
}

export function resolveWith(result: PolishProviderResult): ProviderBehavior {
  return () => Promise.resolve(result);
}

// ---------------------------------------------------------------------------
// Mock route deps
// ---------------------------------------------------------------------------

export interface DepMocks {
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

export function makeDeps(
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

export function handlersOf(mocks: DepMocks) {
  return createPolishHandlers(mocks.deps);
}

export async function expectErrorShape(
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
