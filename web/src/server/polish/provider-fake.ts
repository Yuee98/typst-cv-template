/**
 * Deterministic fake polish provider (unit 0.4), selected when
 * POLISH_FAKE_LLM=true — vitest suites and local/CI runs without a DeepSeek
 * key.
 *
 * Output is a pure function of the request: no randomness and no wall-clock
 * dependence beyond the simulated delay, so tests can assert exact values.
 * The returned text is always shaped as `{"items":[{"id":...,"polished":...}]}`,
 * matching the prompt contract the orchestrator (unit 2.2) validates against.
 * Each target's ORIGINAL text is echoed unchanged (taken from the structured
 * `targets` metadata, never parsed back out of the prompt strings), so the
 * fake's success path survives the language / protected-span / length
 * validation pipeline exactly like a real polished response must.
 *
 * Codewords scanned across all message contents:
 * - FAIL_UPSTREAM → throws PolishProviderError(UPSTREAM_ERROR)
 * - FAIL_JSON     → resolves with malformed JSON text (exercises the
 *                   orchestrator's JSON-parse failure path)
 * - SLOW          → simulates a call that outlasts `timeoutMs`
 *                   (timeoutMs + FAKE_SLOW_EXTRA_DELAY_MS), so the fake's
 *                   own single-attempt timeout fires first (exercises the
 *                   orchestrator's timeout path)
 *
 * Timeout contract (same as every provider): `timeoutMs` is the hard timeout
 * of this single call. The fake races it against the caller's signal — its
 * own timeout rejects with PolishProviderError("UPSTREAM_TIMEOUT", …), while
 * caller cancellation rejects with the signal's AbortError. The
 * orchestrator's overall multi-attempt deadline is a separate concern (unit
 * 2.2) and is not simulated here.
 *
 * `maxOutputTokens` and `providerUserId` are accepted but ignored: the
 * fake's output is far below any realistic cap, and the id only matters for
 * the real provider's upstream mapping (unit 2.1).
 */

import {
  PolishProviderError,
  type PolishProvider,
  type PolishProviderRequest,
  type PolishProviderResult,
  type PolishProviderUsage,
} from "./provider";
import {
  observedUsage,
  unavailableUsage,
  type AttemptUsageObservationV1,
  type NormalizedUsageV2,
  type PolishInferenceRequestV2,
  type PolishInferenceResultV2,
} from "./inference-v2";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";

export const FAKE_PROVIDER_CODEWORDS = {
  failUpstream: "FAIL_UPSTREAM",
  failJson: "FAIL_JSON",
  slow: "SLOW",
} as const;

export const DEFAULT_FAKE_DELAY_MS = 20;

/**
 * Extra delay added on top of `timeoutMs` when the SLOW codeword is present,
 * so the fake's own timeout always fires before the simulated latency ends.
 */
export const FAKE_SLOW_EXTRA_DELAY_MS = 1000;

/**
 * V2-only deterministic scenarios.  These are fixtures for the orchestrator
 * and ledger conformance tests; they are never selected by the production
 * provider resolver below.
 */
export const FAKE_V2_SCENARIOS = {
  success: "success",
  partialUsage: "partial_usage",
  unavailableUsage: "unavailable_usage",
  rateLimited: "rate_limited",
  serverError: "server_error",
  timeout: "timeout",
} as const;

export type FakeV2Scenario = (typeof FAKE_V2_SCENARIOS)[keyof typeof FAKE_V2_SCENARIOS];

export const FAKE_V2_MAX_RETRY_AFTER_MS = MAX_PROVIDER_RETRY_AFTER_MS;

const FAKE_V2_ROUTE = {
  gatewayRequestId: "fake-gateway-request-001",
  providerRequestId: "fake-provider-request-001",
  actualUpstreamEndpoint: "https://fake.invalid/v2/responses",
  actualModelId: "fake-v2-model",
  routerAttemptCount: 1,
} as const;

type FakeV2Route = PolishInferenceResultV2["route"];

const FAKE_V2_ROUTE_KEYS = new Set<keyof FakeV2Route>([
  "gatewayRequestId",
  "providerRequestId",
  "actualUpstreamEndpoint",
  "actualModelId",
  "routerAttemptCount",
]);

const MAX_FAKE_V2_ROUTE_TOKEN_LENGTH = 256;
const MAX_FAKE_V2_ENDPOINT_LENGTH = 512;
const MAX_FAKE_V2_ROUTER_ATTEMPTS = 100;
const MAX_FAKE_V2_COST_NANOS = BigInt("1000000000000000000000000000000");

/**
 * Small, explicit usage fixtures.  Keeping these values in one place makes
 * conservation and aggregate tests independent of prompt length or clocks.
 */
export const FAKE_V2_USAGE_FIXTURES = {
  reported: {
    schemaVersion: "normalized_usage_v2",
    inputTotalTokens: 12,
    inputCacheReadTokens: 3,
    inputCacheWriteTokens: 4,
    inputStandardTokens: 5,
    outputTokens: 6,
    reasoningTokens: 2,
    cacheUsageReporting: "reported",
    usageComplete: true,
  },
  partial: {
    schemaVersion: "normalized_usage_v2",
    inputTotalTokens: 8,
    inputCacheReadTokens: 3,
    inputCacheWriteTokens: null,
    inputStandardTokens: 5,
    outputTokens: 6,
    reasoningTokens: null,
    cacheUsageReporting: "unavailable",
    usageComplete: false,
  },
} as const satisfies Record<string, NormalizedUsageV2>;

export interface FakePolishInferenceProviderOptions {
  scenario?: FakeV2Scenario;
  /** Simulated latency for the successful/partial paths. */
  delayMs?: number;
  /** Deliberately oversized values are clamped to the shared fake bound. */
  retryAfterMs?: number;
  providerReportedCost?: { currency: string; nanos: string };
  route?: Partial<FakeV2Route>;
}

export type FakePolishInferenceCompletion =
  | {
      kind: "completed";
      result: PolishInferenceResultV2;
      usageObservation: Extract<AttemptUsageObservationV1, { kind: "observed" }>;
    }
  | {
      kind: "failed";
      failure: FakeV2Failure;
      route: FakeV2Route;
      providerBillable: null;
      result: null;
      usageObservation: Extract<AttemptUsageObservationV1, { kind: "unavailable" }>;
    };

export interface FakeV2Failure {
  code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  upstreamStatus?: number;
  retryable: boolean;
  retryAfterMs: number;
  providerRequestId?: string;
}

/** Safe, normalized metadata used by deterministic V2 error fixtures. */
export class FakePolishInferenceProviderError extends Error {
  readonly code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  readonly upstreamStatus?: number;
  readonly retryAfterMs?: number;
  readonly providerRequestId?: string;
  readonly retryable?: boolean;
  readonly usageUnavailable: boolean;

  constructor(
    code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT",
    options: {
      upstreamStatus?: number;
      retryAfterMs?: number;
      providerRequestId?: string;
      retryable?: boolean;
      usageUnavailable?: boolean;
    } = {},
  ) {
    super("fake V2 provider transport failure");
    this.name = "FakePolishInferenceProviderError";
    this.code = code;
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.providerRequestId = options.providerRequestId;
    this.retryable = options.retryable;
    // Transport failures stay errors.  Only the explicit missing-usage
    // scenario is converted by completeAttempt into an observation.
    this.usageUnavailable = options.usageUnavailable ?? false;
  }
}

export interface FakePolishInferenceProviderV2 {
  complete(
    request: PolishInferenceRequestV2,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishInferenceResultV2>;
  /** Preserves the missing-usage failure and attaches its unavailable observation. */
  completeAttempt(
    request: PolishInferenceRequestV2,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<FakePolishInferenceCompletion>;
}

export interface FakePolishProviderOptions {
  /** Simulated per-call latency in milliseconds (SLOW overrides it). */
  delayMs?: number;
}

/**
 * Waits `ms`, racing the fake's own hard `timeoutMs` against caller
 * cancellation: the fake's timeout rejects with UPSTREAM_TIMEOUT, a caller
 * abort rejects with the signal's reason (AbortError).
 */
function sleep(ms: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => {
      clearTimeout(delayTimer);
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const delayTimer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(
        new PolishProviderError(
          "UPSTREAM_TIMEOUT",
          `fake polish provider: single call exceeded its hard timeoutMs (${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedFakeRetryAfterMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), FAKE_V2_MAX_RETRY_AFTER_MS);
}

function assertSafeRouteToken(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`invalid fake V2 route ${field}`);
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid fake V2 route ${field}`);
  }
  if (/(?:bearer|basic)\s+|(?:api[_-]?key|password|secret)\s*[:=]/iu.test(value)) {
    throw new Error(`invalid fake V2 route ${field}`);
  }
  return value;
}

function normalizeFakeV2Route(override: Partial<FakeV2Route> | undefined): FakeV2Route {
  if (override !== undefined &&
    (typeof override !== "object" || override === null || Array.isArray(override))) {
    throw new Error("invalid fake V2 route override");
  }

  if (override !== undefined) {
    for (const key of Object.keys(override)) {
      if (!FAKE_V2_ROUTE_KEYS.has(key as keyof FakeV2Route)) {
        throw new Error("unknown fake V2 route field");
      }
      if ((override as Record<string, unknown>)[key] === undefined) {
        throw new Error(`invalid fake V2 route ${key}`);
      }
    }
  }

  const route: FakeV2Route = { ...FAKE_V2_ROUTE };
  const value = override as Record<string, unknown> | undefined;
  for (const key of FAKE_V2_ROUTE_KEYS) {
    const candidate = value?.[key];
    if (candidate === undefined) continue;
    if (key === "routerAttemptCount") {
      if (
        typeof candidate !== "number" ||
        !Number.isSafeInteger(candidate) ||
        candidate < 1 ||
        candidate > MAX_FAKE_V2_ROUTER_ATTEMPTS
      ) {
        throw new Error(`invalid fake V2 route ${key}`);
      }
      route[key] = candidate;
    } else if (key === "actualUpstreamEndpoint") {
      const endpoint = assertSafeRouteToken(candidate, key, MAX_FAKE_V2_ENDPOINT_LENGTH);
      let parsed: URL;
      try {
        parsed = new URL(endpoint);
      } catch {
        throw new Error(`invalid fake V2 route ${key}`);
      }
      if (
        parsed.protocol !== "https:" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        throw new Error(`invalid fake V2 route ${key}`);
      }
      route[key] = parsed.toString().replace(/\/$/u, "");
    } else {
      route[key] = assertSafeRouteToken(candidate, key, MAX_FAKE_V2_ROUTE_TOKEN_LENGTH);
    }
  }
  return route;
}

function normalizeFakeV2Cost(
  value: { currency: string; nanos: string } | undefined,
): { currency: string; nanos: string } {
  const candidate = value ?? { currency: "CNY", nanos: "123456789" };
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.currency !== "string" ||
    typeof candidate.nanos !== "string" ||
    !/^[A-Z]{3}$/u.test(candidate.currency)
  ) {
    throw new Error("invalid fake V2 providerReportedCost currency");
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(candidate.nanos)) {
    throw new Error("invalid fake V2 providerReportedCost nanos");
  }
  const nanos = BigInt(candidate.nanos);
  if (nanos > MAX_FAKE_V2_COST_NANOS) {
    throw new Error("invalid fake V2 providerReportedCost nanos");
  }
  return { currency: candidate.currency, nanos: nanos.toString() };
}

function toFakeV2Failure(error: FakePolishInferenceProviderError): FakeV2Failure {
  return {
    code: error.code,
    ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
    retryable: error.retryable ?? false,
    retryAfterMs: boundedFakeRetryAfterMs(error.retryAfterMs),
    ...(error.providerRequestId === undefined
      ? {}
      : { providerRequestId: error.providerRequestId }),
  };
}

function sleepV2(ms: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const cleanup = () => {
      clearTimeout(delayTimer);
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const delayTimer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new FakePolishInferenceProviderError("UPSTREAM_TIMEOUT"));
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create a deterministic V2 provider fixture.  It deliberately has no HTTP
 * client and never logs request contents.  The fake is a conformance seam,
 * not a substitute for provider validation or a production adapter.
 */
export function createFakePolishInferenceProvider(
  options: FakePolishInferenceProviderOptions = {},
): FakePolishInferenceProviderV2 {
  const scenario = options.scenario ?? FAKE_V2_SCENARIOS.success;
  if (!(Object.values(FAKE_V2_SCENARIOS) as readonly string[]).includes(scenario)) {
    throw new Error("unknown fake V2 scenario");
  }
  const delayMs = options.delayMs ?? DEFAULT_FAKE_DELAY_MS;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error("invalid fake V2 delayMs");
  }
  const retryAfterMs = boundedFakeRetryAfterMs(options.retryAfterMs);
  const routeSnapshot = normalizeFakeV2Route(options.route);
  const providerReportedCostSnapshot = normalizeFakeV2Cost(options.providerReportedCost);

  const complete = async (
    request: PolishInferenceRequestV2,
    { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishInferenceResultV2> => {
    signal.throwIfAborted();

    if (scenario === FAKE_V2_SCENARIOS.rateLimited) {
      throw new FakePolishInferenceProviderError("UPSTREAM_ERROR", {
        upstreamStatus: 429,
        retryAfterMs,
        providerRequestId: routeSnapshot.providerRequestId,
      });
    }
    if (scenario === FAKE_V2_SCENARIOS.serverError) {
      throw new FakePolishInferenceProviderError("UPSTREAM_ERROR", {
        upstreamStatus: 503,
        providerRequestId: routeSnapshot.providerRequestId,
      });
    }
    if (scenario === FAKE_V2_SCENARIOS.unavailableUsage) {
      throw new FakePolishInferenceProviderError("UPSTREAM_ERROR", {
        providerRequestId: routeSnapshot.providerRequestId,
        retryable: false,
        usageUnavailable: true,
      });
    }

    const slow = scenario === FAKE_V2_SCENARIOS.timeout;
    await sleepV2(slow ? timeoutMs + FAKE_SLOW_EXTRA_DELAY_MS : delayMs, signal, timeoutMs);

    const usage =
      scenario === FAKE_V2_SCENARIOS.partialUsage
        ? { ...FAKE_V2_USAGE_FIXTURES.partial }
        : { ...FAKE_V2_USAGE_FIXTURES.reported };
    const text = JSON.stringify({
      items: request.targets.map((target) => ({ id: target.id, polished: target.text })),
    });

    return {
      schemaVersion: "polish_inference_result_v2",
      text,
      finishReason: "stop",
      usage,
      route: { ...routeSnapshot },
      providerReportedCost: { ...providerReportedCostSnapshot },
    };
  };

  return {
    complete,
    async completeAttempt(request, callOptions) {
      try {
        const result = await complete(request, callOptions);
        const usageObservation = observedUsage(result.usage);
        if (usageObservation.kind !== "observed") {
          throw new Error("fake V2 observed result produced an unavailable usage observation");
        }
        return {
          kind: "completed",
          result,
          usageObservation,
        };
      } catch (error) {
        if (error instanceof FakePolishInferenceProviderError && error.usageUnavailable) {
          const usageObservation = unavailableUsage();
          if (usageObservation.kind !== "unavailable") {
            throw new Error("fake V2 unavailable result produced an observed usage observation");
          }
          return {
            kind: "failed",
            failure: toFakeV2Failure(error),
            route: { ...routeSnapshot },
            providerBillable: null,
            result: null,
            usageObservation,
          };
        }
        throw error;
      }
    },
  };
}

/** Synthetic, deterministic usage estimate (≈4 chars per token). */
function fakeUsage(request: PolishProviderRequest, outputText: string): PolishProviderUsage {
  const promptChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
  const promptTokens = Math.ceil(promptChars / 4);
  return {
    promptTokens,
    completionTokens: Math.ceil(outputText.length / 4),
    cachedReadTokens: 0,
    uncachedReadTokens: promptTokens,
  };
}

export function createFakePolishProvider(options: FakePolishProviderOptions = {}): PolishProvider {
  const delayMs = options.delayMs ?? DEFAULT_FAKE_DELAY_MS;

  return {
    async complete(
      request: PolishProviderRequest,
      { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
    ): Promise<PolishProviderResult> {
      // Cancellation is rethrown as-is (AbortError), never wrapped in a
      // PolishProviderError — the orchestrator distinguishes the two.
      signal.throwIfAborted();

      const corpus = request.messages.map((m) => m.content).join("\n");

      if (corpus.includes(FAKE_PROVIDER_CODEWORDS.failUpstream)) {
        throw new PolishProviderError(
          "UPSTREAM_ERROR",
          "fake polish provider: FAIL_UPSTREAM codeword present in request",
        );
      }

      const slow = corpus.includes(FAKE_PROVIDER_CODEWORDS.slow);
      await sleep(slow ? timeoutMs + FAKE_SLOW_EXTRA_DELAY_MS : delayMs, signal, timeoutMs);

      let text: string;
      if (corpus.includes(FAKE_PROVIDER_CODEWORDS.failJson)) {
        // Malformed on purpose: truncated mid-string, unrecoverable by JSON.parse.
        text = '{"items":[{"id":"i0","polished":"truncated';
      } else {
        const items = request.targets.map((target) => ({ id: target.id, polished: target.text }));
        text = JSON.stringify({ items });
      }

      return { text, finishReason: "stop", usage: fakeUsage(request, text) };
    },
  };
}
