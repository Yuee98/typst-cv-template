import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  finalizePolishRequest,
  getPolishQuota,
  markPolishProviderStarted,
  PolishQuotaError,
  reservePolishRequest,
} from "@/server/polish/quota";

type RpcResult = { data?: unknown; error?: { message: string } | null };

function mockClient(impl: (fn: string, args: unknown) => RpcResult) {
  const rpc = vi.fn((fn: string, args: unknown) =>
    Promise.resolve({ error: null, ...impl(fn, args) }),
  );
  return {
    rpc,
    client: { rpc } as unknown as SupabaseClient,
  };
}

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const REQUEST_ID = "b0000000-0000-4000-8000-000000000001";
const CLIENT_REQUEST_ID = "c0000000-0000-4000-8000-000000000001";
const RESERVATION_ID = "d0000000-0000-4000-8000-000000000001";

describe("reservePolishRequest", () => {
  it("returns the reservation on success and passes ids to the RPC", async () => {
    const { client, rpc } = mockClient(() => ({
      data: {
        allowed: true,
        reservationId: RESERVATION_ID,
        limit: 20,
        remaining: 19,
        resetAt: "2026-08-03T00:00:00+00:00",
      },
    }));

    const reservation = await reservePolishRequest(client, {
      userId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    });

    expect(reservation).toEqual({
      reservationId: RESERVATION_ID,
      limit: 20,
      remaining: 19,
      resetAt: "2026-08-03T00:00:00+00:00",
    });
    expect(rpc).toHaveBeenCalledWith("reserve_ai_polish_request", {
      p_user_id: USER_ID,
      p_request_id: REQUEST_ID,
      p_client_request_id: CLIENT_REQUEST_ID,
    });
  });

  it.each([
    ["QUOTA_EXCEEDED", 429],
    ["RATE_LIMITED", 429],
    ["DUPLICATE_REQUEST", 409],
    ["REQUEST_IN_PROGRESS", 409],
    ["AI_DISABLED", 503],
    ["SERVICE_UNAVAILABLE", 503],
  ] as const)("maps denial %s to a %i PolishQuotaError", async (reason, status) => {
    const { client } = mockClient(() => ({
      data: { allowed: false, reason, message: "denied" },
    }));

    const error = await reservePolishRequest(client, {
      userId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolishQuotaError);
    expect((error as PolishQuotaError).code).toBe(reason);
    expect((error as PolishQuotaError).httpStatus).toBe(status);
  });

  it("carries resetAt / retryAfterSeconds from the denial payload", async () => {
    const { client } = mockClient(() => ({
      data: {
        allowed: false,
        reason: "RATE_LIMITED",
        message: "slow down",
        retryAfterSeconds: 42,
        resetAt: "2026-08-03T00:00:00+00:00",
      },
    }));

    const error = (await reservePolishRequest(client, {
      userId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    }).catch((e: unknown) => e)) as PolishQuotaError;

    expect(error.retryAfterSeconds).toBe(42);
    expect(error.resetAt).toBe("2026-08-03T00:00:00+00:00");
  });

  it("maps an unknown denial reason to INTERNAL_ERROR", async () => {
    const { client } = mockClient(() => ({
      data: { allowed: false, reason: "SOMETHING_NEW" },
    }));

    const error = (await reservePolishRequest(client, {
      userId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    }).catch((e: unknown) => e)) as PolishQuotaError;

    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.httpStatus).toBe(500);
  });

  it("maps an RPC failure to INTERNAL_ERROR", async () => {
    const { client } = mockClient(() => ({
      data: null,
      error: { message: "connection reset" },
    }));

    const error = (await reservePolishRequest(client, {
      userId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    }).catch((e: unknown) => e)) as PolishQuotaError;

    expect(error).toBeInstanceOf(PolishQuotaError);
    expect(error.code).toBe("INTERNAL_ERROR");
  });

  it("rejects a malformed success payload", async () => {
    const { client } = mockClient(() => ({
      data: { allowed: true, remaining: 19 },
    }));

    const error = (await reservePolishRequest(client, {
      userId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    }).catch((e: unknown) => e)) as PolishQuotaError;

    expect(error.code).toBe("INTERNAL_ERROR");
  });

  it("rejects a payload of the wrong shape", async () => {
    const { client } = mockClient(() => ({ data: "not-an-object" }));

    const error = (await reservePolishRequest(client, {
      userId: USER_ID,
      requestId: REQUEST_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    }).catch((e: unknown) => e)) as PolishQuotaError;

    expect(error.code).toBe("INTERNAL_ERROR");
  });
});

describe("markPolishProviderStarted", () => {
  it("returns started=true with the attempt number", async () => {
    const { client, rpc } = mockClient(() => ({
      data: { ok: true, attemptCount: 2 },
    }));

    const mark = await markPolishProviderStarted(client, RESERVATION_ID, "prov-1");

    expect(mark).toEqual({ started: true, attemptCount: 2 });
    expect(rpc).toHaveBeenCalledWith("mark_ai_polish_provider_started", {
      p_reservation_id: RESERVATION_ID,
      p_provider_request_id: "prov-1",
    });
  });

  it("returns started=false when the reservation was already finalized", async () => {
    const { client } = mockClient(() => ({
      data: { ok: false, reason: "ALREADY_FINALIZED" },
    }));

    await expect(markPolishProviderStarted(client, RESERVATION_ID)).resolves.toEqual({
      started: false,
      attemptCount: null,
    });
  });

  it("maps the atomic global-gate denial to SERVICE_UNAVAILABLE (relay #2)", async () => {
    const { client } = mockClient(() => ({
      data: { ok: false, reason: "SERVICE_UNAVAILABLE" },
    }));

    const error = (await markPolishProviderStarted(client, RESERVATION_ID).catch(
      (e: unknown) => e,
    )) as PolishQuotaError;

    expect(error).toBeInstanceOf(PolishQuotaError);
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(error.httpStatus).toBe(503);
    expect(error.message).toBe("AI polish is temporarily unavailable (daily capacity reached).");
  });

  it("maps a mark-time kill-switch / allowlist denial to AI_DISABLED (relay #2)", async () => {
    const { client } = mockClient(() => ({
      data: { ok: false, reason: "AI_DISABLED" },
    }));

    const error = (await markPolishProviderStarted(client, RESERVATION_ID).catch(
      (e: unknown) => e,
    )) as PolishQuotaError;

    expect(error.code).toBe("AI_DISABLED");
    expect(error.httpStatus).toBe(503);
  });

  it("throws INTERNAL_ERROR for an unknown reservation", async () => {
    const { client } = mockClient(() => ({
      data: { ok: false, reason: "NOT_FOUND" },
    }));

    const error = (await markPolishProviderStarted(client, RESERVATION_ID).catch(
      (e: unknown) => e,
    )) as PolishQuotaError;

    expect(error.code).toBe("INTERNAL_ERROR");
  });
});

describe("finalizePolishRequest", () => {
  it("maps usage and metadata to the RPC snake_case payload", async () => {
    const { client, rpc } = mockClient(() => ({
      data: { ok: true, alreadyFinalized: false, status: "succeeded", quotaCharged: true },
    }));

    const result = await finalizePolishRequest(client, {
      reservationId: RESERVATION_ID,
      status: "succeeded",
      quotaCharged: true,
      providerBillable: true,
      usage: {
        inputCachedTokens: 10,
        inputUncachedTokens: 20,
        outputTokens: 5,
        usageComplete: true,
      },
      metadata: {
        granularity: "item",
        itemCount: 1,
        contextLevel: 1,
        language: "zh",
        model: "deepseek-v4-flash",
        failureStage: "provider_timeout",
        latencyMs: 800,
      },
    });

    expect(result).toEqual({ alreadyFinalized: false, status: "succeeded", quotaCharged: true });
    expect(rpc).toHaveBeenCalledWith("finalize_ai_polish_request", {
      p_reservation_id: RESERVATION_ID,
      p_status: "succeeded",
      p_quota_charged: true,
      p_provider_billable: true,
      p_usage: {
        input_cached_tokens: 10,
        input_uncached_tokens: 20,
        output_tokens: 5,
        usage_complete: true,
      },
      p_metadata: {
        granularity: "item",
        item_count: 1,
        context_level: 1,
        language: "zh",
        model: "deepseek-v4-flash",
        prompt_version: undefined,
        validator_version: undefined,
        attempt_count: undefined,
        provider_request_id: undefined,
        finish_reason: undefined,
        failure_stage: "provider_timeout",
        latency_ms: 800,
      },
    });
  });

  it("sends null usage/metadata when omitted", async () => {
    const { client, rpc } = mockClient(() => ({
      data: { ok: true, alreadyFinalized: false, status: "released", quotaCharged: false },
    }));

    await finalizePolishRequest(client, {
      reservationId: RESERVATION_ID,
      status: "released",
      quotaCharged: false,
    });

    expect(rpc).toHaveBeenCalledWith(
      "finalize_ai_polish_request",
      expect.objectContaining({ p_usage: null, p_metadata: null, p_provider_billable: null }),
    );
  });

  it("reports idempotent repeats without throwing", async () => {
    const { client } = mockClient(() => ({
      data: { ok: true, alreadyFinalized: true, status: "succeeded", quotaCharged: true },
    }));

    await expect(
      finalizePolishRequest(client, {
        reservationId: RESERVATION_ID,
        status: "succeeded",
        quotaCharged: true,
      }),
    ).resolves.toEqual({
      alreadyFinalized: true,
      status: "succeeded",
      quotaCharged: true,
      quota: undefined,
    });
  });

  it("passes the atomic post-settlement quota snapshot through (relay #8)", async () => {
    const { client } = mockClient(() => ({
      data: {
        ok: true,
        alreadyFinalized: false,
        status: "succeeded",
        quotaCharged: true,
        quota: { limit: 20, remaining: 19, resetAt: "2026-08-03T00:00:00+00:00" },
      },
    }));

    const result = await finalizePolishRequest(client, {
      reservationId: RESERVATION_ID,
      status: "succeeded",
      quotaCharged: true,
      providerBillable: true,
    });

    expect(result).toEqual({
      alreadyFinalized: false,
      status: "succeeded",
      quotaCharged: true,
      quota: { limit: 20, remaining: 19, resetAt: "2026-08-03T00:00:00+00:00" },
    });
  });

  it("throws INTERNAL_ERROR when the reservation is unknown", async () => {
    const { client } = mockClient(() => ({
      data: { ok: false, reason: "NOT_FOUND" },
    }));

    const error = (await finalizePolishRequest(client, {
      reservationId: RESERVATION_ID,
      status: "released",
      quotaCharged: false,
    }).catch((e: unknown) => e)) as PolishQuotaError;

    expect(error.code).toBe("INTERNAL_ERROR");
  });
});

describe("getPolishQuota", () => {
  it("returns the quota payload", async () => {
    const { client, rpc } = mockClient(() => ({
      data: { limit: 20, remaining: 17, resetAt: "2026-08-03T00:00:00+00:00" },
    }));

    await expect(getPolishQuota(client, USER_ID)).resolves.toEqual({
      limit: 20,
      remaining: 17,
      resetAt: "2026-08-03T00:00:00+00:00",
    });
    expect(rpc).toHaveBeenCalledWith("get_ai_polish_quota", { p_user_id: USER_ID });
  });

  it("maps an RPC failure to INTERNAL_ERROR", async () => {
    const { client } = mockClient(() => ({
      data: null,
      error: { message: "boom" },
    }));

    const error = (await getPolishQuota(client, USER_ID).catch(
      (e: unknown) => e,
    )) as PolishQuotaError;

    expect(error.code).toBe("INTERNAL_ERROR");
  });
});
