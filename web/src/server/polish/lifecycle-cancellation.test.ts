import { describe, expect, it } from "vitest";
import { postRequest, makeDeps, handlersOf, expectErrorShape } from "./lifecycle-fixtures";

describe("POST /api/polish — cancellation settlement", () => {
  it("cancel after provider call entry: charged, billability unknown without usage (取消照扣)", async () => {    const controller = new AbortController();
    const mocks = makeDeps([
      (call) => {
        controller.abort();
        return Promise.reject(call.options.signal.reason);
      },
    ]);
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    // The client is gone; the response is moot but must still be well-formed.
    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        quotaCharged: true,
        // The call was entered but aborted before any usage came back:
        // billability is UNKNOWN (null), not provably free and not provable cost.
        providerBillable: null,
        metadata: expect.objectContaining({ failureStage: "canceled", attemptCount: 1 }),
      }),
    );
    expect(mocks.logs.some((log) => log.event === "polish.request.canceled")).toBe(true);
  });

  it("cancel before the provider starts: released and refunded", async () => {
    const controller = new AbortController();
    controller.abort();
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.markProviderStarted).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", quotaCharged: false, providerBillable: false }),
    );
  });

  // Next.js (node runtime) aborts request.signal on client disconnect with
  // its ResponseAborted error (name "ResponseAborted" — its only
  // distinguishing feature), not a DOMException AbortError. This is the shape
  // a real `next start` cancellation arrives in (unit 4.1 real-smoke
  // finding); the lifecycle must recognize it as a user cancel (4.1b).
  const nextResponseAborted = () =>
    Object.assign(new Error("The response was aborted by the client."), {
      name: "ResponseAborted",
    });

  it("client disconnect (Next ResponseAborted) after provider call entry: charged, failure_stage canceled", async () => {
    const controller = new AbortController();
    const mocks = makeDeps([
      (call) => {
        // Mirror production: next start aborts request.signal with
        // ResponseAborted, and the real provider rethrows the signal's reason.
        controller.abort(nextResponseAborted());
        return Promise.reject(call.options.signal.reason);
      },
    ]);
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    // The client is gone; the response is moot but must still be well-formed.
    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        quotaCharged: true,
        // The call was entered but aborted before any usage came back:
        // billability is UNKNOWN (null), not provably free and not provable cost.
        providerBillable: null,
        metadata: expect.objectContaining({ failureStage: "canceled", attemptCount: 1 }),
      }),
    );
    expect(mocks.logs.some((log) => log.event === "polish.request.canceled")).toBe(true);
  });

  it("client disconnect (Next ResponseAborted) before the provider starts: released and refunded", async () => {
    const controller = new AbortController();
    controller.abort(nextResponseAborted());
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ signal: controller.signal }));

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
    expect(mocks.providerCalls).toHaveLength(0);
    expect(mocks.markProviderStarted).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", quotaCharged: false, providerBillable: false }),
    );
  });
});
