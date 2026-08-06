import { describe, expect, it, vi } from "vitest";
import type { PolishErrorCode } from "@/lib/polish/contract";
import { PolishQuotaError } from "./quota";
import { POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS } from "./lifecycle";
import { RESET_AT, RESET_AT_Z, postRequest, echoSuccess, makeDeps, handlersOf, expectErrorShape } from "./lifecycle-fixtures";

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
