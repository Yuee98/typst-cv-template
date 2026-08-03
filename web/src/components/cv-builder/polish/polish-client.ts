/**
 * Client layer for POST /api/polish and GET /api/polish/quota.
 *
 * - `createPolishHttpClient` is the real client: Bearer token from the
 *   Supabase session (via the injected `getAccessToken`), a hard client-side
 *   timeout on top of the caller's AbortSignal, and response bodies parsed
 *   against the shared contract schemas — anything off-contract becomes a
 *   transport-level error code, never an unchecked cast.
 * - `createMockPolishClient` is the development stand-in for the backend
 *   (task: mock 模式 — NEXT_PUBLIC_AI_POLISH_ENABLED on but no backend):
 *   deterministic output in the same response shape as the 0.4 fake
 *   provider's envelope, a decrementing in-memory quota, dedup semantics,
 *   and the FAIL_UPSTREAM / FAIL_JSON / SLOW codewords for error paths.
 * - `createPolishClientFromEnv` picks mock when NEXT_PUBLIC_AI_POLISH_MOCK is
 *   "true" outside production, else the HTTP client. `usePolishFlow` accepts
 *   an injected client, so tests and the dev harness never need the env.
 *
 * Error discipline (Invariant 8): error messages never embed response
 * bodies, CV text, or AI output — codes and schema issue paths only.
 */

import {
  polishErrorResponseSchema,
  polishQuotaResponseSchema,
  polishRequestSchema,
  polishSuccessResponseSchema,
  type PolishErrorCode,
  type PolishQuotaResponse,
  type PolishRequest,
  type PolishSuccessResponse,
} from "@/lib/polish/contract";

import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";

export interface PolishApiClient {
  polish(
    request: PolishRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PolishSuccessResponse>;
  getQuota(options?: { signal?: AbortSignal }): Promise<PolishQuotaResponse>;
}

/**
 * Error raised by the client. `code` is a contract error code when the
 * server answered with a well-formed error body, a status-mapped contract
 * code when it answered but not in the contract shape, or a
 * POLISH_TRANSPORT_ERROR_CODES value when no usable response exists.
 */
export class PolishApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly resetAt?: string;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;

  constructor(init: {
    code: string;
    message?: string;
    status?: number;
    resetAt?: string;
    retryAfterSeconds?: number;
    requestId?: string;
  }) {
    super(init.message ?? init.code);
    this.name = "PolishApiError";
    this.code = init.code;
    this.status = init.status;
    this.resetAt = init.resetAt;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.requestId = init.requestId;
  }
}

/** Roadmap: server deadline is 45s; the client adds transport slack. */
export const DEFAULT_POLISH_CLIENT_TIMEOUT_MS = 50_000;

export interface CreatePolishHttpClientOptions {
  /** Resolves the current Supabase access token (null when signed out). */
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Prefix for the API paths (defaults to same-origin ""). */
  baseUrl?: string;
  timeoutMs?: number;
}

/** Fallback code mapping when a non-2xx body fails the error schema. */
function fallbackCodeForStatus(status: number): PolishErrorCode {
  switch (status) {
    case 400:
      return "INVALID_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "AI_TERMS_REQUIRED";
    case 409:
      return "REQUEST_IN_PROGRESS";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 429:
      return "RATE_LIMITED";
    case 502:
      return "UPSTREAM_ERROR";
    case 503:
      return "SERVICE_UNAVAILABLE";
    case 504:
      return "UPSTREAM_TIMEOUT";
    default:
      return "INTERNAL_ERROR";
  }
}

function invalidBodyError(path: string, status?: number): PolishApiError {
  return new PolishApiError({
    code: POLISH_TRANSPORT_ERROR_CODES.invalidResponseBody,
    message: `polish response failed contract validation at "${path}"`,
    status,
  });
}

interface WiredSignal {
  signal: AbortSignal;
  cleanup: () => void;
  isCallerAborted: () => boolean;
  isTimedOut: () => boolean;
}

/** Combine the caller's signal with the client-side hard timeout. */
function wireSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): WiredSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
    isCallerAborted: () => Boolean(callerSignal?.aborted),
    isTimedOut: () => timedOut,
  };
}

export function createPolishHttpClient(options: CreatePolishHttpClientOptions): PolishApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLISH_CLIENT_TIMEOUT_MS;

  async function request<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
    parse: (body: unknown, status: number) => T,
  ): Promise<T> {
    const wired = wireSignal(init.signal, timeoutMs);
    try {
      const token = await options.getAccessToken();
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (init.body !== undefined) headers["Content-Type"] = "application/json";

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: init.method,
          headers,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: wired.signal,
        });
      } catch (fetchError) {
        if (fetchError instanceof PolishApiError) throw fetchError;
        if (wired.isCallerAborted()) {
          throw new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted });
        }
        if (wired.isTimedOut()) {
          throw new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.clientTimeout });
        }
        throw new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.networkError });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw invalidBodyError("body", response.status);
      }

      if (!response.ok) {
        const parsedError = polishErrorResponseSchema.safeParse(body);
        if (parsedError.success) {
          throw new PolishApiError({
            code: parsedError.data.error.code,
            message: parsedError.data.error.message,
            status: response.status,
            resetAt: parsedError.data.error.resetAt,
            retryAfterSeconds: parsedError.data.error.retryAfterSeconds,
            requestId: parsedError.data.requestId,
          });
        }
        // Off-contract error body: map by status, honoring Retry-After.
        const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
        throw new PolishApiError({
          code: fallbackCodeForStatus(response.status),
          status: response.status,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
          requestId: response.headers.get("X-Request-Id") ?? undefined,
        });
      }

      return parse(body, response.status);
    } finally {
      wired.cleanup();
    }
  }

  return {
    polish: (polishRequest, polishOptions) =>
      request(
        "/api/polish",
        { method: "POST", body: polishRequest, signal: polishOptions?.signal },
        (body, status) => {
          const parsed = polishSuccessResponseSchema.safeParse(body);
          if (!parsed.success) {
            throw invalidBodyError(parsed.error.issues[0]?.path.join(".") ?? "body", status);
          }
          return parsed.data;
        },
      ),
    getQuota: (quotaOptions) =>
      request("/api/polish/quota", { method: "GET", signal: quotaOptions?.signal }, (body, status) => {
        const parsed = polishQuotaResponseSchema.safeParse(body);
        if (!parsed.success) {
          throw invalidBodyError(parsed.error.issues[0]?.path.join(".") ?? "body", status);
        }
        return parsed.data;
      }),
  };
}

// ---------------------------------------------------------------------------
// Development mock
// ---------------------------------------------------------------------------

/** Codewords scanned in `styleInstruction`, mirroring the 0.4 fake provider. */
export const MOCK_CLIENT_CODEWORDS = {
  failUpstream: "FAIL_UPSTREAM",
  failJson: "FAIL_JSON",
  slow: "SLOW",
} as const;

export interface CreateMockPolishClientOptions {
  /** Simulated latency per call (SLOW overrides it with `slowDelayMs`). */
  delayMs?: number;
  /** Latency for the SLOW codeword; should exceed any client timeout in use. */
  slowDelayMs?: number;
  /** Daily quota limit; each successful polish consumes one. */
  quotaLimit?: number;
}

/** Deterministic pseudo-polish: whitespace collapse, else a visible marker. */
export function mockPolishText(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed !== text ? collapsed : `[mock] ${text}`;
}

function nextUtcMidnight(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * In-memory mock of the polish API for development without a backend. The
 * response envelope matches polishSuccessResponseSchema /
 * polishQuotaResponseSchema exactly; quota and dedup state live for the
 * lifetime of the returned client instance.
 */
export function createMockPolishClient(
  options: CreateMockPolishClientOptions = {},
): PolishApiClient {
  const delayMs = options.delayMs ?? 600;
  const slowDelayMs = options.slowDelayMs ?? 60_000;
  const quotaLimit = options.quotaLimit ?? 20;
  let used = 0;
  let requestCounter = 0;
  const seenClientRequestIds = new Set<string>();

  function quota() {
    return {
      limit: quotaLimit,
      remaining: Math.max(0, quotaLimit - used),
      resetAt: nextUtcMidnight(),
    };
  }

  return {
    async polish(polishRequest, polishOptions) {
      const parsed = polishRequestSchema.safeParse(polishRequest);
      if (!parsed.success) {
        throw new PolishApiError({ code: "INVALID_REQUEST", status: 400 });
      }
      if (seenClientRequestIds.has(polishRequest.clientRequestId)) {
        throw new PolishApiError({
          code: "DUPLICATE_REQUEST",
          message: "mock: clientRequestId already consumed",
          status: 409,
        });
      }

      const instruction = polishRequest.styleInstruction ?? "";
      const slow = instruction.includes(MOCK_CLIENT_CODEWORDS.slow);
      await abortableDelay(slow ? slowDelayMs : delayMs, polishOptions?.signal);

      if (instruction.includes(MOCK_CLIENT_CODEWORDS.failUpstream)) {
        throw new PolishApiError({ code: "UPSTREAM_ERROR", status: 502 });
      }
      if (instruction.includes(MOCK_CLIENT_CODEWORDS.failJson)) {
        // The real pipeline would burn a retry and surface this from the
        // orchestrator; the mock maps the codeword straight to it.
        throw new PolishApiError({ code: "INVALID_MODEL_OUTPUT", status: 502 });
      }

      const remaining = quotaLimit - used;
      if (remaining <= 0) {
        throw new PolishApiError({
          code: "QUOTA_EXCEEDED",
          status: 429,
          resetAt: nextUtcMidnight(),
        });
      }

      seenClientRequestIds.add(polishRequest.clientRequestId);
      used += 1;
      requestCounter += 1;
      return {
        requestId: `mock-req-${requestCounter}`,
        items: polishRequest.items.map((item) => ({
          id: item.id,
          polished: mockPolishText(item.text),
        })),
        quota: quota(),
      };
    },

    async getQuota(quotaOptions) {
      await abortableDelay(Math.min(delayMs, 200), quotaOptions?.signal);
      return { requestId: "mock-quota", quota: quota() };
    },
  };
}

/**
 * Default client selection: the development mock when
 * NEXT_PUBLIC_AI_POLISH_MOCK="true" (never in production), otherwise the
 * real HTTP client. UI code should prefer injecting a client into
 * usePolishFlow; this factory is the wiring for the real entry points.
 */
export function createPolishClientFromEnv(
  options: CreatePolishHttpClientOptions,
): PolishApiClient {
  if (
    process.env.NEXT_PUBLIC_AI_POLISH_MOCK === "true" &&
    process.env.NODE_ENV !== "production"
  ) {
    return createMockPolishClient();
  }
  return createPolishHttpClient(options);
}
