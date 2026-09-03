import { describe, expect, it } from "vitest";

import {
  MAX_ITEM_CHARS,
  MAX_TARGET_CHARS,
  computePolishMaxOutputTokens,
  polishPostRequestSchema,
} from "../../src/lib/polish/contract";
import {
  CANCELLATION_ITEM_COUNT,
  buildCancellationProbeItems,
  observeAbortableRequest,
  readJsonOrNull,
} from "./integration-http.mjs";

describe("integration HTTP body parsing", () => {
  it("returns parsed JSON and tolerates an ordinary non-JSON body", async () => {
    await expect(readJsonOrNull({ json: async () => ({ ok: true }) })).resolves.toEqual({ ok: true });
    await expect(readJsonOrNull({ json: async () => { throw new SyntaxError("not JSON"); } })).resolves.toBeNull();
  });

  it("rethrows a body-read failure after caller cancellation", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("caller aborted", "AbortError");
    let rejectBody;
    const reading = readJsonOrNull(
      { json: () => new Promise((_resolve, reject) => { rejectBody = reject; }) },
      controller.signal,
    );
    controller.abort();
    rejectBody(abortError);
    await expect(reading).rejects.toBe(abortError);
  });

  it("attributes cancellation only to the exact abort rejection", async () => {
    const earlyController = new AbortController();
    const networkError = new Error("socket closed");
    const early = observeAbortableRequest(Promise.reject(networkError), earlyController.signal);
    await Promise.resolve();
    expect(early.isSettled()).toBe(true);

    const lateAbortReason = new DOMException("late abort", "AbortError");
    earlyController.abort(lateAbortReason);
    await expect(early.outcome).resolves.toEqual({ kind: "rejected", error: networkError });

    const activeController = new AbortController();
    const activeAbortReason = new DOMException("active abort", "AbortError");
    let rejectActive;
    const activeRequest = new Promise((_resolve, reject) => { rejectActive = reject; });
    const active = observeAbortableRequest(activeRequest, activeController.signal);
    expect(active.isSettled()).toBe(false);
    activeController.abort(activeAbortReason);
    rejectActive(activeAbortReason);
    await expect(active.outcome).resolves.toEqual({ kind: "aborted", error: activeAbortReason });

    const crossedController = new AbortController();
    const crossedAbortReason = new DOMException("crossed abort", "AbortError");
    const crossedError = new Error("independent failure");
    crossedController.abort(crossedAbortReason);
    const crossed = observeAbortableRequest(Promise.reject(crossedError), crossedController.signal);
    await expect(crossed.outcome).resolves.toEqual({ kind: "rejected", error: crossedError });
  });

  it("keeps the real-provider cancellation probe inside request and output bounds", () => {
    const items = buildCancellationProbeItems();
    const body = {
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      granularity: "section",
      sectionId: "experience",
      language: "zh",
      items,
      context: { level: 0, references: [] },
      expectedRoute: {
        schemaVersion: "expected_route_v1",
        configGeneration: "3",
        profileVersionId: "11111111-1111-4111-8111-111111111111",
        legalBundleVersion: "2026-08-23-multi-provider-v1",
        runtimeContractId: "runtime.deepseek-v2.v1",
      },
    };

    expect(CANCELLATION_ITEM_COUNT).toBe(25);
    expect(items).toHaveLength(CANCELLATION_ITEM_COUNT);
    expect(items.every((item) => item.text.length <= MAX_ITEM_CHARS)).toBe(true);
    expect(items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(MAX_TARGET_CHARS);
    expect(computePolishMaxOutputTokens(items)).toBeLessThan(8_000);
    expect(polishPostRequestSchema.safeParse(body).success).toBe(true);
  });

});
