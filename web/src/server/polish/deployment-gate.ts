import { randomUUID } from "node:crypto";

import {
  errorResponse,
  POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from "./lifecycle-http";

export type PolishHttpHandler = (request: Request) => Promise<Response>;

export function isPolishDeploymentEnabled(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Deployment-owned request gate shared by every generated AI API route.
 *
 * The boolean is captured when the handler module is composed, so changing the
 * environment requires a new deployment. A disabled route never delegates to
 * authentication, request parsing, Supabase, lifecycle, or provider code.
 */
export function withPolishDeploymentGate(
  enabled: boolean,
  handler: PolishHttpHandler,
  createRequestId: () => string = randomUUID,
): PolishHttpHandler {
  if (enabled) return handler;

  return async () => {
    const requestId = createRequestId();
    return errorResponse(requestId, "AI_DISABLED", "AI polish is not available.", {
      retryAfterSeconds: POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  };
}
