import { randomUUID } from "node:crypto";
import { type PolishErrorCode, type PolishQuota, type PolishQuotaResponse } from "@/lib/polish/contract";
import { verifyBearerUser } from "./auth";
import { baseHeaders, errorResponse, POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS, toIsoUtc } from "./lifecycle-http";
import type { PolishQuotaRouteDeps } from "./lifecycle-types";

// ---------------------------------------------------------------------------
// GET /api/polish/quota — login only, never the ai_terms gate
// ---------------------------------------------------------------------------

export async function handleQuotaGet(
  request: Request,
  deps: PolishQuotaRouteDeps,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? (() => undefined);
  const requestId = deps.createRequestId?.() ?? randomUUID();
  const startedAt = now();

  const deny = (
    code: PolishErrorCode,
    message: string,
    options?: { retryAfterSeconds?: number; userId?: string },
  ): Response => {
    log({ event: "polish.quota.denied", requestId, userId: options?.userId, code, latencyMs: now() - startedAt });
    return errorResponse(requestId, code, message, options);
  };

  if (!deps.aiPolishEnabled) {
    return deny("AI_DISABLED", "AI polish is not available.", {
      retryAfterSeconds: POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }

  // Login check only (roadmap: the quota read must not require ai_terms).
  const auth = await verifyBearerUser(request.headers.get("authorization"), deps);
  if (!auth.ok) {
    return deny(auth.error.code, auth.error.message);
  }

  try {
    const dbQuota = await deps.getQuota(auth.userId);
    const quota: PolishQuota = { ...dbQuota, resetAt: toIsoUtc(dbQuota.resetAt) };
    log({
      event: "polish.quota.served",
      requestId,
      userId: auth.userId,
      latencyMs: now() - startedAt,
    });
    const body: PolishQuotaResponse = { requestId, quota };
    return Response.json(body, { status: 200, headers: baseHeaders(requestId) });
  } catch {
    return deny("INTERNAL_ERROR", "Failed to read the remaining quota.", { userId: auth.userId });
  }
}
