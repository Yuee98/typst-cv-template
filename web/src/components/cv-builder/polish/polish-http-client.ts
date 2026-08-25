import {
  polishAvailabilityResponseSchema,
  polishErrorResponseSchema,
  polishQuotaResponseSchema,
  polishSuccessResponseSchema,
  type PolishErrorCode,
} from "@/lib/polish/contract";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import { PolishApiError } from "./polish-api-error";
import type { PolishApiClient } from "./polish-client";

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
    getAvailability: (availabilityOptions) =>
      request(
        "/api/polish/availability",
        { method: "GET", signal: availabilityOptions?.signal },
        (body, status) => {
          const parsed = polishAvailabilityResponseSchema.safeParse(body);
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
