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
    expect(h.flow().availabilityCandidate?.selectedOptionId).toBe("opt_000000000001");
    act(() => h.flow().selectOption("opt_000000000002"));
    expect(h.flow().availabilityCandidate?.selectedOptionId).toBe("opt_000000000002");
    act(() => h.flow().confirm());
    expect(h.polishCalls[0].request.expectedRoute).toMatchObject({
      selectedOptionId: "opt_000000000002",
      profileVersionId: "pfv_000000000002",
      disclosureId: "lds_000000000002"
    });
  });
  it("selects a third Google recipient and accepts only its exact disclosure", async () => {
    const response = fixtureAvailability([1, 2, 3]);
    const google = response.availability.options[2];
    google.providerName = "Google Gemini";
    google.modelName = "gemini-3.8-flash";
    google.status = "CONSENT_REQUIRED";
    google.legalDisplay = {
      ...google.legalDisplay,
      providerId: "prv_000000000003",
      recipientCode: "GOOGLE_AI_STUDIO",
      modelId: "gemini-3.8-flash",
      en: { ...google.legalDisplay.en, providerLabel: "Google Gemini", modelLabel: "gemini-3.8-flash" },
      zh: { ...google.legalDisplay.zh, providerLabel: "Google Gemini", modelLabel: "gemini-3.8-flash" },
    };
    const h = renderHarness({}, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q", quota: makeQuota(20) });
      h.availabilityCalls[0].deferred.resolve(response);
    });
    act(() => h.flow().selectOption(google.optionId));
    expect(h.flow().canConfirm).toBe(false);
    act(() => h.flow().terms.setChecked(true));
    act(() => h.flow().confirm());
    expect(h.acceptCalls).toHaveLength(1);
    expect(h.acceptCalls[0].legalDisplay).toMatchObject({
      recipientCode: "GOOGLE_AI_STUDIO", disclosureId: "lds_000000000003", modelId: "gemini-3.8-flash",
    });
    expect(h.polishCalls).toHaveLength(0);
    await act(async () => h.acceptCalls[0].resolve());
    const accepted = structuredClone(response);
    accepted.availability.options[2].status = "READY";
    await act(async () => h.availabilityCalls[1].deferred.resolve(accepted));
    expect(h.polishCalls).toHaveLength(1);
    expect(h.polishCalls[0].request.expectedRoute).toMatchObject({
      selectedOptionId: google.optionId, profileVersionId: "pfv_000000000003", disclosureId: "lds_000000000003",
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
    act(() => h.flow().selectOption("opt_000000000002"));
    act(() => h.flow().availabilityRetry());
    await act(async () => {
      h.availabilityCalls[1].deferred.resolve(fixtureAvailability([1, 3]));
    });
    expect(h.flow().availabilityCandidate?.selectedOptionId).toBeNull();
    expect(h.flow().canConfirm).toBe(false);
    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(0);
    act(() => h.flow().selectOption("opt_000000000003"));
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
    expect(h.flow().availabilityCandidate?.selectedOptionId).toBe("opt_000000000001");
    expect(h.flow().canConfirm).toBe(true);
  });
  it("switching providers invalidates a pending consent continuation", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    expect(h.acceptCalls[0].legalDisplay.disclosureId).toBe("lds_000000000001");
    act(() => h.flow().selectOption("opt_000000000002"));
    expect(h.flow().terms.checked).toBe(false);
    await act(async () => h.acceptCalls[0].resolve());
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().availabilityCandidate?.selectedOptionId).toBe("opt_000000000002");
  });
  it("focus refreshes availability and rejects unavailable options", async () => {
    const response = fixtureAvailability();
    response.availability.options[1].status = "UNAVAILABLE";
    const h = renderHarness({}, {
      availabilityResponse: response
    });
    await openAccepted(h);
    act(() => h.flow().selectOption("opt_000000000002"));
    expect(h.flow().availabilityCandidate?.selectedOptionId).toBe("opt_000000000001");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(h.availabilityCalls).toHaveLength(2);
  });
});
