import { describe, expect, it, vi } from "vitest";
import { PolishProviderError, type PolishProviderResult } from "./provider";
import { postRequest, usage, echoSuccess, rejectWith, resolveWith, makeDeps, handlersOf, expectErrorShape } from "./lifecycle-fixtures";

describe("POST /api/polish — failure settlement (refund paths)", () => {
  it("504 UPSTREAM_TIMEOUT after two timed-out attempts: refunded, billability unknown", async () => {
    const mocks = makeDeps([
      rejectWith(new PolishProviderError("UPSTREAM_TIMEOUT", "timed out")),
      rejectWith(new PolishProviderError("UPSTREAM_TIMEOUT", "timed out")),
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 504, "UPSTREAM_TIMEOUT");
    expect(mocks.providerCalls).toHaveLength(2);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed_upstream",
        quotaCharged: false,
        // Upstream calls were entered but no usage came back: absence of
        // usage is not proof of zero cost → billability UNKNOWN (null).
        providerBillable: null,
        metadata: expect.objectContaining({ failureStage: "provider_timeout", attemptCount: 2 }),
      }),
    );
  });

  it("502 UPSTREAM_ERROR after two failed attempts: refunded", async () => {
    const mocks = makeDeps([
      rejectWith(new PolishProviderError("UPSTREAM_ERROR", "HTTP 500", { upstreamStatus: 500 })),
      rejectWith(new PolishProviderError("UPSTREAM_ERROR", "HTTP 500", { upstreamStatus: 500 })),
    ]);
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 502, "UPSTREAM_ERROR");
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed_upstream",
        quotaCharged: false,
        metadata: expect.objectContaining({ failureStage: "provider_http" }),
      }),
    );
    // upstreamStatus reaches the structured log, never the response body
    const failed = mocks.logs.find((log) => log.event === "polish.request.failed");
    expect(failed).toMatchObject({ code: "UPSTREAM_ERROR", upstreamStatus: 500 });
  });

  it("502 INVALID_MODEL_OUTPUT after two invalid responses: refunded but billable (content was returned)", async () => {
    const invalid: PolishProviderResult = {
      text: '{"items":[{"id":"i0","polished":"truncated',
      finishReason: "stop",
      usage: usage(),
    };
    const mocks = makeDeps([resolveWith(invalid), resolveWith(invalid)]);
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 502, "INVALID_MODEL_OUTPUT");
    expect(mocks.providerCalls).toHaveLength(2);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "invalid_output",
        quotaCharged: false, // 两次失败返还
        providerBillable: true, // real cost: content WAS produced
        usage: {
          inputCachedTokens: 120,
          inputUncachedTokens: 80,
          outputTokens: 100,
          usageComplete: true,
        },
        metadata: expect.objectContaining({ failureStage: "json_parse", attemptCount: 2 }),
      }),
    );
  });

  it("500 INTERNAL_ERROR + released when mark_provider_started says the reservation is settled", async () => {
    const mocks = makeDeps([echoSuccess], {
      markProviderStarted: vi.fn(async () => ({ started: false, attemptCount: null })),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    const body = await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal quota service error."); // fixed, no internals (relay #10)
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", quotaCharged: false }),
    );
  });
});

