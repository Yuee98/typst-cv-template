import { describe, expect, it, vi } from "vitest";
import { PolishProviderError, type PolishProviderResult } from "../../provider";
import { PolishQuotaError } from "../../quota";
import { POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS } from "../../lifecycle";
import { postRequest, usage, echoSuccess, rejectWith, resolveWith, makeDeps, handlersOf, expectErrorShape } from "./fixtures";

describe("POST /api/polish — terminal progress settlement (relay #3)", () => {
  const INVALID_WITH_USAGE: PolishProviderResult = {
    text: JSON.stringify({ items: [{ id: "i0", polished: "将延迟降低 99%。" }] }), // loses P99/40%
    finishReason: "stop",
    usage: usage(),
    providerRequestId: "provider-req-1",
  };

  it("attempt 1 invalid with usage → abort before attempt 2: canceled, charged once, attempt-1 usage recorded COMPLETE (#1)", async () => {
    const controller = new AbortController();
    const mocks = makeDeps([
      () => {
        // The caller aborts AFTER attempt 1 returned its (invalid) result,
        // so the orchestrator's loop-top check fires before attempt 2.
        controller.abort();
        return Promise.resolve(INVALID_WITH_USAGE);
      },
    ]);
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.providerCalls).toHaveLength(1); // attempt 2 never started
    expect(mocks.markProviderStarted).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        quotaCharged: true, // one user-visible request == one charge
        providerBillable: true, // attempt-1 content WAS produced
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          // Round-2 #1: the only entered attempt RETURNED its usage, so the
          // accounting is complete — cancellation alone does not degrade it.
          usageComplete: true,
        },
        metadata: expect.objectContaining({
          failureStage: "canceled",
          attemptCount: 1,
          providerRequestId: "provider-req-1",
        }),
      }),
    );
  });

  it("attempt 1 transport failure WITHOUT usage → attempt 2 invalid WITH usage: usageComplete=false (#1)", async () => {
    const mocks = makeDeps([
      rejectWith(new PolishProviderError("UPSTREAM_ERROR", "upstream 500")),
      resolveWith(INVALID_WITH_USAGE),
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 502, "INVALID_MODEL_OUTPUT");
    expect(mocks.providerCalls).toHaveLength(2);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "invalid_output",
        quotaCharged: false,
        providerBillable: true,
        // Only attempt 2's tokens are known; attempt 1 may have generated
        // untracked tokens upstream → incomplete despite the later result.
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

  it("cancel while attempt 2 is in flight: usageComplete=false, attemptCount + providerRequestId in metadata/log (#1/#5)", async () => {
    const controller = new AbortController();
    const mocks = makeDeps([
      resolveWith(INVALID_WITH_USAGE),
      (call) => {
        controller.abort();
        return Promise.reject(call.options.signal.reason);
      },
    ]);
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.providerCalls).toHaveLength(2);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        quotaCharged: true,
        providerBillable: true,
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: false, // attempt 2 was in flight: its tokens unknowable
        },
        metadata: expect.objectContaining({
          failureStage: "canceled",
          attemptCount: 2,
          providerRequestId: "provider-req-1",
        }),
      }),
    );
    const canceled = mocks.logs.find((log) => log.event === "polish.request.canceled");
    expect(canceled).toMatchObject({ attempts: 2, providerRequestId: "provider-req-1" });
  });

  it("attempt 1 invalid with usage → attempt-2 mark fails: refunded, attempt-1 usage still recorded and billable", async () => {
    const mocks = makeDeps([resolveWith(INVALID_WITH_USAGE)], {
      markProviderStarted: vi
        .fn()
        .mockResolvedValueOnce({ started: true, attemptCount: 1 })
        .mockRejectedValueOnce(
          new PolishQuotaError("INTERNAL_ERROR", "mark_provider_started RPC failed: connection reset"),
        ),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    const body = await expectErrorShape(response, 500, "INTERNAL_ERROR");
    // Raw RPC detail never crosses the API (relay #10).
    expect(body.error.message).toBe("Internal quota service error.");
    expect(mocks.providerCalls).toHaveLength(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        // NOT "released": attempt 1 really reached the provider (#3.2).
        status: "failed_upstream",
        quotaCharged: false, // refunded: no usable result
        providerBillable: true, // attempt-1 usage is a proven cost
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: true,
        },
        // #5: infra-failure settlements also carry the attempt count and the
        // last provider request id from the progress snapshot.
        metadata: expect.objectContaining({
          attemptCount: 1,
          providerRequestId: "provider-req-1",
        }),
      }),
    );
  });

  it("abort while the first mark RPC is pending: provider not called, user quota refunded", async () => {
    const controller = new AbortController();
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => {
        // The caller aborts DURING the ledger mark; the RPC still succeeds.
        controller.abort();
        return { started: true, attemptCount: 1 };
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    // A successful ledger mark is NOT evidence of an upstream call (#3.3):
    // the orchestrator rechecks the signal after the mark and never enters
    // the provider, so the request is released, not charged.
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "released",
        quotaCharged: false,
        providerBillable: false,
      }),
    );
  });

  it("global-cap denial at attempt 2: no provider call, refunded, attempt-1 usage kept, 503 not 500 (relay #2)", async () => {
    const mocks = makeDeps([resolveWith(INVALID_WITH_USAGE)], {
      markProviderStarted: vi
        .fn()
        .mockResolvedValueOnce({ started: true, attemptCount: 1 })
        .mockRejectedValueOnce(
          new PolishQuotaError(
            "SERVICE_UNAVAILABLE",
            "AI polish is temporarily unavailable (daily capacity reached).",
          ),
        ),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "SERVICE_UNAVAILABLE");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
    expect(mocks.providerCalls).toHaveLength(1); // attempt 2 never called the provider
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed_upstream",
        quotaCharged: false, // user refunded: no usable result delivered
        providerBillable: true, // attempt-1 usage retained as cost
        usage: {
          inputCachedTokens: 60,
          inputUncachedTokens: 40,
          outputTokens: 50,
          usageComplete: true,
        },
        // #5: the global-gate path also reports attempt count + request id.
        metadata: expect.objectContaining({
          attemptCount: 1,
          providerRequestId: "provider-req-1",
        }),
      }),
    );
  });

  it("global-cap denial at attempt 1: released, refunded, 503", async () => {
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => {
        throw new PolishQuotaError(
          "SERVICE_UNAVAILABLE",
          "AI polish is temporarily unavailable (daily capacity reached).",
        );
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "SERVICE_UNAVAILABLE");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "released",
        quotaCharged: false,
        providerBillable: false,
        // #5: no attempt was ever entered — the count is reported as 0.
        metadata: expect.objectContaining({ attemptCount: 0 }),
      }),
    );
  });

  it("kill-switch denial (AI_DISABLED) at the mark: released, refunded, 503 AI_DISABLED", async () => {
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => {
        throw new PolishQuotaError("AI_DISABLED", "AI polish is currently disabled.");
      }),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "AI_DISABLED");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", quotaCharged: false, providerBillable: false }),
    );
  });
});
