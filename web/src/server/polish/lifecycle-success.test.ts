import { describe, expect, it, vi } from "vitest";
import { polishSuccessResponseSchema } from "@/lib/polish/contract";
import { PolishProviderError } from "./provider";
import { PolishQuotaError } from "./quota";
import { USER_ID, REQUEST_ID, RESERVATION_ID, RESET_AT, RESET_AT_Z, VALID_ZH_TEXT, postRequest, echoSuccess, rejectWith, makeDeps, handlersOf, expectErrorShape } from "./lifecycle-fixtures";

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

  it("retry succeeds after a usage-less transport failure: 200, attempt-2 tokens charged, usageComplete=false (#1)", async () => {
    const mocks = makeDeps([
      rejectWith(new PolishProviderError("UPSTREAM_ERROR", "upstream 500")),
      echoSuccess,
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    expect(mocks.providerCalls).toHaveLength(2);
    // one user-visible request == one quota charge (Invariant 6); every
    // provider attempt was marked (global cost accounting, Invariant 7)
    expect(mocks.markProviderStarted).toHaveBeenCalledTimes(2);
    // Only attempt 2 returned usage; attempt 1 may still have generated
    // tokens upstream that we cannot account for → usageComplete=false
    // permanently, even though the run SUCCEEDED (round-2 #1).
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        quotaCharged: true,
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: false,
        },
        metadata: expect.objectContaining({ attemptCount: 2 }),
      }),
    );
  });

  it("retry succeeds after a missing usage block (UPSTREAM_ERROR): 200, usageComplete=false (#1)", async () => {
    // The DeepSeek layer rejects a 200 response without a usage block as a
    // controlled UPSTREAM_ERROR (covered in deepseek.test.ts); at the route
    // level it settles exactly like any other usage-less transport failure.
    const mocks = makeDeps([
      rejectWith(
        new PolishProviderError(
          "UPSTREAM_ERROR",
          "DeepSeek response is missing the usage block or its required totals",
        ),
      ),
      echoSuccess,
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    expect(mocks.providerCalls).toHaveLength(2);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        quotaCharged: true,
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: false,
        },
      }),
    );
  });

  it("200 when the finalize response is lost but the idempotent retry confirms succeeded+charged (#3)", async () => {
    const mocks = makeDeps([echoSuccess], {
      finalize: vi
        .fn()
        .mockRejectedValueOnce(
          new PolishQuotaError("INTERNAL_ERROR", "finalize RPC failed: connection reset"),
        )
        .mockResolvedValueOnce({
          alreadyFinalized: true,
          status: "succeeded",
          quotaCharged: true,
          quota: { limit: 20, remaining: 18, resetAt: RESET_AT },
        }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: unknown; items: unknown };
    expect(body.items).toEqual([{ id: "i0", polished: VALID_ZH_TEXT }]);
    // The quota snapshot comes from the retry's atomic response.
    expect(body.quota).toEqual({ limit: 20, remaining: 18, resetAt: RESET_AT_Z });
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(mocks.getQuota).not.toHaveBeenCalled();
  });

  it("200 when the first finalize never landed and the retry commits fresh (alreadyFinalized=false) (#3)", async () => {
    const mocks = makeDeps([echoSuccess], {
      finalize: vi
        .fn()
        .mockRejectedValueOnce(
          new PolishQuotaError("INTERNAL_ERROR", "finalize RPC failed: connection reset"),
        )
        .mockResolvedValueOnce({
          alreadyFinalized: false,
          quota: { limit: 20, remaining: 18, resetAt: RESET_AT },
        }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: unknown };
    expect(body.quota).toEqual({ limit: 20, remaining: 18, resetAt: RESET_AT_Z });
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
  });

  it("500 when the finalize retry reports a conflicting persisted state (not succeeded/charged) (#3)", async () => {
    const mocks = makeDeps([echoSuccess], {
      finalize: vi
        .fn()
        .mockRejectedValueOnce(
          new PolishQuotaError("INTERNAL_ERROR", "finalize RPC failed: connection reset"),
        )
        .mockResolvedValueOnce({ alreadyFinalized: true, status: "released", quotaCharged: false }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(mocks.logs.some((log) => log.event === "polish.finalize_failed")).toBe(true);
  });

  it("200 when both finalize attempts fail: verified output + reserve-snapshot quota, reconciler settles later (#3)", async () => {
    const mocks = makeDeps([echoSuccess], {
      finalize: vi.fn(async () => {
        throw new PolishQuotaError("INTERNAL_ERROR", "finalize RPC failed");
      }),
      getQuota: vi.fn(async () => {
        throw new PolishQuotaError("INTERNAL_ERROR", "get quota RPC failed: connection reset");
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    // Settlement state is unknown, but "charged + no output" is the one
    // outcome that must never happen: the verified result IS returned, the
    // quota falls back to the reserve-time snapshot, and the failure is
    // logged loudly for the reconciler (verdict option b).
    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: unknown; items: unknown };
    expect(body.items).toEqual([{ id: "i0", polished: VALID_ZH_TEXT }]);
    expect(body.quota).toEqual({ limit: 20, remaining: 19, resetAt: RESET_AT_Z });
    expect(mocks.finalize).toHaveBeenCalledTimes(2); // one idempotent retry
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
