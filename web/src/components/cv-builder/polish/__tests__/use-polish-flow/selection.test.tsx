// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { fixtureAvailability } from "@/lib/polish/fixtures";
import { makeQuota, openAccepted, openRequiredAndConfirm, renderHarness, SCOPE } from "./harness";
afterEach(cleanup);
describe("explicit provider selection", () => {
  it("preselects the rule default and submits a different selected provider", async () => {
    const h = renderHarness();
    await openAccepted(h);
    expect(h.flow().availabilityCandidate?.selectedConfigId).toBe("1");
    act(() => h.flow().selectConfiguration("2"));
    expect(h.flow().availabilityCandidate?.selectedConfigId).toBe("2");
    act(() => h.flow().confirm());
    expect(h.polishCalls[0].request.expectedRoute).toMatchObject({
      configId: "2",
      configRevision: "1",
      providerDocumentAuditId: "12"
    });
  });
  it("selects a third Google recipient and accepts only its exact disclosure", async () => {
    const response = fixtureAvailability([1, 2, 3]);
    const google = response.availability.configurations[2];
    google.displayName = "Google Gemini";
    google.status = "CONSENT_REQUIRED";
    google.legalDisplay.provider = { ...google.legalDisplay.provider,
      recipient_name: "Google Gemini",
      zh_title: "Google Gemini 数据处理说明", en_title: "Google Gemini processing disclosure"
    };
    const h = renderHarness({}, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q", quota: makeQuota(20) });
      h.availabilityCalls[0].deferred.resolve(response);
    });
    act(() => h.flow().selectConfiguration(google.configId));
    expect(h.flow().canConfirm).toBe(false);
    act(() => h.flow().terms.setChecked(true));
    act(() => h.flow().confirm());
    expect(h.acceptCalls).toHaveLength(1);
    expect(h.acceptCalls[0].legalDisplay).toMatchObject({
      provider: { recipient_name: "Google Gemini", document_audit_id: "13" },
    });
    expect(h.polishCalls).toHaveLength(0);
    await act(async () => h.acceptCalls[0].resolve());
    const accepted = structuredClone(response);
    accepted.availability.configurations[2].status = "READY";
    await act(async () => h.availabilityCalls[1].deferred.resolve(accepted));
    expect(h.polishCalls).toHaveLength(1);
    expect(h.polishCalls[0].request.expectedRoute).toMatchObject({
      configId: google.configId, configRevision: "1", providerDocumentAuditId: "13",
    });
  });
  it("clears an expired selection and never silently replaces it with the default", async () => {
    const h = renderHarness({}, {
      deferAvailability: true
    });
    act(() => h.flow().open(SCOPE));
    await act(async () => {
      h.quotaCalls[0].resolve({
        requestId: "q",
        quota: makeQuota(20)
      });
      h.availabilityCalls[0].deferred.resolve(fixtureAvailability([1, 2]));
    });
    act(() => h.flow().selectConfiguration("2"));
    act(() => h.flow().availabilityRetry());
    await act(async () => {
      h.availabilityCalls[1].deferred.resolve(fixtureAvailability([1, 3]));
    });
    expect(h.flow().availabilityCandidate?.selectedConfigId).toBeNull();
    expect(h.flow().canConfirm).toBe(false);
    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(0);
    act(() => h.flow().selectConfiguration("3"));
    expect(h.flow().canConfirm).toBe(true);
  });
  it("retains a still-eligible choice across time-rule refresh", async () => {
    const h = renderHarness({}, {
      deferAvailability: true
    });
    act(() => h.flow().open(SCOPE));
    await act(async () => {
      h.quotaCalls[0].resolve({
        requestId: "q",
        quota: makeQuota(20)
      });
      h.availabilityCalls[0].deferred.resolve(fixtureAvailability([1, 2]));
    });
    act(() => h.flow().availabilityRetry());
    await act(async () => {
      h.availabilityCalls[1].deferred.resolve(fixtureAvailability([1, 3]));
    });
    expect(h.flow().availabilityCandidate?.selectedConfigId).toBe("1");
    expect(h.flow().canConfirm).toBe(true);
  });
  it("switching providers invalidates a pending consent continuation", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    expect(h.acceptCalls[0].legalDisplay.provider.document_audit_id).toBe("11");
    act(() => h.flow().selectConfiguration("2"));
    expect(h.flow().terms.checked).toBe(false);
    await act(async () => h.acceptCalls[0].resolve());
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().availabilityCandidate?.selectedConfigId).toBe("2");
  });
  it("focus refreshes availability and rejects unavailable options", async () => {
    const response = fixtureAvailability();
    response.availability.configurations[1].status = "UNAVAILABLE";
    const h = renderHarness({}, {
      availabilityResponse: response
    });
    await openAccepted(h);
    act(() => h.flow().selectConfiguration("2"));
    expect(h.flow().availabilityCandidate?.selectedConfigId).toBe("1");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(h.availabilityCalls).toHaveLength(2);
  });
});
