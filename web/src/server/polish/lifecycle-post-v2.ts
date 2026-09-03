import { randomUUID } from "node:crypto";

import {
  polishExpectedRouteSchema,
  polishPostRequestSchema,
  polishRequestSchema,
  polishSuccessResponseSchema,
  type PolishErrorCode,
  type PolishExpectedRoute,
  type PolishSuccessResponse,
} from "@/lib/polish/contract";
import { verifyBearerUser } from "./auth";
import {
  executePolishLifecycleV2,
  type PolishLifecycleV2Failure,
  type PolishLifecycleV2FailureCode,
  type PolishLifecycleV2Input,
  type PolishLifecycleV2Result,
} from "./lifecycle-v2";
import {
  parseExpectedRouteV1,
  type ExpectedRouteV1,
} from "./lifecycle-v2-contract";
import {
  baseHeaders,
  errorResponse,
  POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
  readBoundedBody,
  secondsUntil,
} from "./lifecycle-http";

interface PublicFailureProjection {
  readonly code: PolishErrorCode;
  readonly message: string;
  readonly unavailableRetry: boolean;
}

const PUBLIC_FAILURE_BY_V2_CODE = {
  INVALID_INPUT: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  AI_DISABLED: {
    code: "AI_DISABLED",
    message: "AI polish is not available.",
    unavailableRetry: true,
  },
  SERVICE_UNAVAILABLE: {
    code: "SERVICE_UNAVAILABLE",
    message: "AI polish is temporarily unavailable.",
    unavailableRetry: true,
  },
  QUOTA_EXCEEDED: {
    code: "QUOTA_EXCEEDED",
    message: "Daily AI polish quota exceeded.",
    unavailableRetry: false,
  },
  RATE_LIMITED: {
    code: "RATE_LIMITED",
    message: "Too many AI polish requests; please try again later.",
    unavailableRetry: false,
  },
  DUPLICATE_REQUEST: {
    code: "DUPLICATE_REQUEST",
    message: "This polish request was already completed.",
    unavailableRetry: false,
  },
  REQUEST_IN_PROGRESS: {
    code: "REQUEST_IN_PROGRESS",
    message: "This polish request is already in progress.",
    unavailableRetry: false,
  },
  AI_ROUTE_CHANGED: {
    code: "AI_ROUTE_CHANGED",
    message: "The AI route changed; refresh availability and confirm again.",
    unavailableRetry: false,
  },
  AI_TERMS_REQUIRED: {
    code: "AI_TERMS_REQUIRED",
    message: "Acceptance of the current AI terms is required before polishing.",
    unavailableRetry: false,
  },
  RESERVATION_UNKNOWN: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  EXECUTION_NOT_FOUND: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  EXECUTION_ALREADY_FINALIZED: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  EXECUTION_INVALID: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  PROFILE_UNAVAILABLE: {
    code: "SERVICE_UNAVAILABLE",
    message: "AI polish is temporarily unavailable.",
    unavailableRetry: true,
  },
  ATTEMPT_START_DENIED: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  ATTEMPT_STATE_UNKNOWN: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  ATTEMPT_PERSISTENCE_ERROR: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
  UPSTREAM_ERROR: {
    code: "UPSTREAM_ERROR",
    message: "The AI provider failed; please try again.",
    unavailableRetry: false,
  },
  UPSTREAM_TIMEOUT: {
    code: "UPSTREAM_TIMEOUT",
    message: "The AI provider timed out; please try again.",
    unavailableRetry: false,
  },
  INVALID_MODEL_OUTPUT: {
    code: "INVALID_MODEL_OUTPUT",
    message: "The AI returned unusable output; please try again.",
    unavailableRetry: false,
  },
  CANCELED: {
    code: "INTERNAL_ERROR",
    message: "The polish request was canceled.",
    unavailableRetry: false,
  },
  SETTLEMENT_CONFLICT: {
    code: "INTERNAL_ERROR",
    message: "Failed to settle the polish request.",
    unavailableRetry: false,
  },
  SETTLEMENT_REJECTED: {
    code: "INTERNAL_ERROR",
    message: "Failed to settle the polish request.",
    unavailableRetry: false,
  },
  INTERNAL_ERROR: {
    code: "INTERNAL_ERROR",
    message: "Failed to process the polish request.",
    unavailableRetry: false,
  },
} as const satisfies Record<PolishLifecycleV2FailureCode, PublicFailureProjection>;

export interface PolishPostV2HttpLogEvent {
  readonly event: "polish.v2.http.denied" | "polish.v2.http.served";
  readonly requestId: string;
  readonly code?: PolishErrorCode;
  readonly attemptCount?: number;
  readonly settlement?: string;
  readonly latencyMs: number;
}

export interface PolishPostV2Deps {
  verifyAccessToken(token: string): Promise<string | null>;
  executeLifecycle(input: PolishLifecycleV2Input): Promise<PolishLifecycleV2Result>;
  now?: () => number;
  createRequestId?: () => string;
  logger?: (event: PolishPostV2HttpLogEvent) => void;
}

/** Public-to-internal conversion is assertion-only and independently strict. */
export function toExpectedRouteV1(value: PolishExpectedRoute): ExpectedRouteV1 {
  return parseExpectedRouteV1(polishExpectedRouteSchema.parse(value));
}

function normalizedResetAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizedRetryAfter(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : undefined;
}

function publicFailureOptions(
  failure: PolishLifecycleV2Failure,
  projection: PublicFailureProjection,
  now: number,
): { resetAt?: string; retryAfterSeconds?: number } {
  const resetAt = normalizedResetAt(failure.resetAt);
  const providerRetry = normalizedRetryAfter(failure.retryAfterSeconds);
  const retryAfterSeconds =
    failure.code === "QUOTA_EXCEEDED" && resetAt !== undefined
      ? secondsUntil(resetAt, now)
      : (providerRetry ??
        (projection.unavailableRetry
          ? POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS
          : undefined));
  return {
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

export async function handlePolishPostV2(
  request: Request,
  deps: PolishPostV2Deps,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const requestId = deps.createRequestId?.() ?? randomUUID();
  const startedAt = now();
  const safeLog = (event: PolishPostV2HttpLogEvent): void => {
    try {
      deps.logger?.(event);
    } catch {
      // Observability is non-authoritative and contains no user/content data.
    }
  };
  const deny = (
    code: PolishErrorCode,
    message: string,
    options?: { resetAt?: string; retryAfterSeconds?: number; attemptCount?: number; settlement?: string },
  ): Response => {
    safeLog({
      event: "polish.v2.http.denied",
      requestId,
      code,
      attemptCount: options?.attemptCount,
      settlement: options?.settlement,
      latencyMs: now() - startedAt,
    });
    return errorResponse(requestId, code, message, options);
  };

  // Login only. Exact route-bundle acceptance is checked atomically by the
  // V2 reservation RPC after route equality and before any admission write.
  const auth = await verifyBearerUser(request.headers.get("authorization"), deps);
  if (!auth.ok) return deny(auth.error.code, auth.error.message);

  const body = await readBoundedBody(request);
  if (!body.ok) return deny(body.code, body.message);

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(body.text);
  } catch {
    return deny("INVALID_REQUEST", "Request body must be a valid JSON object.");
  }

  const parsed = polishPostRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return deny(
      "INVALID_REQUEST",
      `Request failed validation (${path}${issue?.message ?? "invalid"}).`,
    );
  }

  const { expectedRoute: publicExpectedRoute, ...requestFields } = parsed.data;
  const polishRequest = polishRequestSchema.parse(requestFields);
  const expectedRoute = toExpectedRouteV1(publicExpectedRoute);

  let result: PolishLifecycleV2Result;
  try {
    result = await deps.executeLifecycle({
      authenticatedUserId: auth.userId,
      requestId,
      clientRequestId: polishRequest.clientRequestId,
      request: polishRequest,
      expectedRoute,
      signal: request.signal,
    });
  } catch {
    return deny("INTERNAL_ERROR", "Failed to process the polish request.");
  }

  // Cross-bind the non-HTTP lifecycle result to this server-generated request
  // identity before projecting any success or error.
  if (result.requestId !== requestId) {
    return deny("INTERNAL_ERROR", "Failed to process the polish request.");
  }

  if (!result.ok) {
    const projection = PUBLIC_FAILURE_BY_V2_CODE[result.code];
    return deny(projection.code, projection.message, {
      ...publicFailureOptions(result, projection, now()),
      attemptCount: result.attemptCount,
      settlement: result.settlement,
    });
  }

  const responseBody = polishSuccessResponseSchema.safeParse({
    requestId,
    items: result.items,
    quota: {
      ...result.quota,
      resetAt: normalizedResetAt(result.quota.resetAt),
    },
  });
  if (!responseBody.success) {
    return deny("INTERNAL_ERROR", "Failed to process the polish response.", {
      attemptCount: result.attemptCount,
      settlement: result.settlement,
    });
  }

  const body200: PolishSuccessResponse = responseBody.data;
  safeLog({
    event: "polish.v2.http.served",
    requestId,
    attemptCount: result.attemptCount,
    settlement: result.settlement,
    latencyMs: now() - startedAt,
  });
  return Response.json(body200, { status: 200, headers: baseHeaders(requestId) });
}

export function createPolishPostV2Handler(
  deps: PolishPostV2Deps,
): (request: Request) => Promise<Response> {
  return (request) => handlePolishPostV2(request, deps);
}

/** Production composition helper; tests may inject a narrower executor. */
export function bindPolishLifecycleV2(
  deps: Parameters<typeof executePolishLifecycleV2>[1],
): PolishPostV2Deps["executeLifecycle"] {
  return (input) => executePolishLifecycleV2(input, deps);
}
