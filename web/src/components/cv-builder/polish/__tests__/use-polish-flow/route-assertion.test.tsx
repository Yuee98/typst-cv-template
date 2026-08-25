// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  polishExpectedRouteFromAvailability,
  polishPostRequestSchema,
  type PolishAvailabilityResponse,
} from "@/lib/polish/contract";

import { ENABLED_AVAILABILITY_BODY } from "../client/fixtures";
import { PolishApiError } from "../../polish-client";
import {
  makeQuota,
  openAccepted,
  openRequiredAndConfirm,
  renderHarness,
  SCOPE,
} from "./harness";

const MIMO_AVAILABILITY_BODY: PolishAvailabilityResponse = {
  requestId: "srv-availability-mimo",
  availability: {
    enabled: true,
    configGeneration: "43",
    routingPolicyVersionId: "00000000-0000-4000-8000-000000000043",
    profileVersionId: "22222222-2222-4222-8222-222222222222",
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    runtimeContractId: "runtime.mimo-v2.v1",
    runtimeContractSha256: "b".repeat(64),
    displayDisclosure: {
      key: "mimo-cn-v1",
      providerName: "MiMo",
      modelName: "MiMo V2.5 Pro",
    },
    termsAccepted: false,
  },
};

afterEach(() => {
  cleanup();
});

describe("usePolishFlow exact route assertion", () => {
  it("POSTs frozen content plus only a fresh id and the exact six-key assertion", async () => {
    const h = renderHarness();
    await openAccepted(h);

    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(1);
    const request = h.polishCalls[0].request;
    expect(polishPostRequestSchema.safeParse(request).success).toBe(true);
    expect(request.clientRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Object.keys(request.expectedRoute).sort()).toEqual([
      "configGeneration",
      "legalBundleVersion",
      "profileVersionId",
      "runtimeContractId",
      "runtimeContractSha256",
      "schemaVersion",
    ]);
    expect(request.expectedRoute).toEqual(
      polishExpectedRouteFromAvailability(ENABLED_AVAILABILITY_BODY.availability),
    );
    const serialized = JSON.stringify(request);
    for (const forbidden of [
      "providerName",
      "modelName",
      "routingPolicyVersionId",
      "displayDisclosure",
      "endpointAlias",
      "priceVersionId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("binds the acceptance write to the displayed candidate's exact legal bundle", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);

    expect(h.acceptCalls).toHaveLength(1);
    expect(h.acceptCalls[0].legalBundleVersion).toBe(
      ENABLED_AVAILABILITY_BODY.availability.legalBundleVersion,
    );
    await act(async () => h.acceptCalls[0].resolve());
    expect(h.polishCalls).toHaveLength(1);
    expect(h.polishCalls[0].request.expectedRoute.legalBundleVersion).toBe(
      h.acceptCalls[0].legalBundleVersion,
    );
  });

  it("kills an acceptance continuation when availability is refreshed", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);

    act(() => h.flow().availabilityRetry());
    expect(h.flow().availabilityStatus).toBe("loading");
    expect(h.flow().availabilityCandidate).toBeNull();
    expect(h.hasAcceptedCalls).toHaveLength(2);

    await act(async () => h.acceptCalls[0].resolve());
    expect(h.polishCalls).toHaveLength(0);

    await act(async () => h.hasAcceptedCalls[1].resolve(true));
    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().terms.status).toBe("accepted");
  });

  it("handles AI_ROUTE_CHANGED by refreshing and requiring an explicit new confirm", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => h.flow().confirm());
    const firstClientRequestId = h.polishCalls[0].request.clientRequestId;

    await act(async () => {
      h.polishCalls[0].deferred.reject(
        new PolishApiError({ code: "AI_ROUTE_CHANGED", status: 409 }),
      );
    });

    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().routeChangedHint).toBe(true);
    expect(h.flow().availabilityStatus).toBe("loading");
    expect(h.flow().availabilityCandidate).toBeNull();
    expect(h.flow().canConfirm).toBe(false);
    expect(h.polishCalls).toHaveLength(1);
    expect(h.hasAcceptedCalls).toHaveLength(2);

    await act(async () => h.hasAcceptedCalls[1].resolve(true));
    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().routeChangedHint).toBe(true);
    expect(h.polishCalls).toHaveLength(1);

    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(2);
    expect(h.polishCalls[1].request.clientRequestId).not.toBe(firstClientRequestId);
    expect(h.flow().routeChangedHint).toBe(false);
  });

  it("refreshes a 403 to a changed MiMo route, then accepts and reconfirms it", async () => {
    const h = renderHarness(undefined, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));
    await act(async () => {
      h.availabilityCalls[0].deferred.resolve(ENABLED_AVAILABILITY_BODY);
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    });
    expect(h.flow().terms.status).toBe("accepted");

    act(() => h.flow().confirm());
    const firstClientRequestId = h.polishCalls[0].request.clientRequestId;
    await act(async () => {
      h.polishCalls[0].deferred.reject(
        new PolishApiError({ code: "AI_TERMS_REQUIRED", status: 403 }),
      );
    });
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().availabilityStatus).toBe("loading");
    expect(h.polishCalls).toHaveLength(1);

    await act(async () => {
      h.availabilityCalls[1].deferred.resolve(MIMO_AVAILABILITY_BODY);
    });
    expect(h.flow().availabilityCandidate?.displayDisclosure).toEqual({
      key: "mimo-cn-v1",
      providerName: "MiMo",
      modelName: "MiMo V2.5 Pro",
    });
    expect(h.flow().routeChangedHint).toBe(true);
    expect(h.flow().terms).toMatchObject({
      status: "required",
      serverRejected: true,
      checked: false,
    });
    expect(h.flow().canConfirm).toBe(false);

    act(() => h.flow().terms.setChecked(true));
    act(() => h.flow().confirm());
    expect(h.acceptCalls[0].legalBundleVersion).toBe(
      MIMO_AVAILABILITY_BODY.availability.legalBundleVersion,
    );
    await act(async () => h.acceptCalls[0].resolve());

    expect(h.polishCalls).toHaveLength(2);
    expect(h.polishCalls[1].request.clientRequestId).not.toBe(firstClientRequestId);
    expect(h.polishCalls[1].request.expectedRoute).toEqual(
      polishExpectedRouteFromAvailability(MIMO_AVAILABILITY_BODY.availability),
    );
  });

  it("fails closed when the server selects a legal bundle this build cannot display", async () => {
    const h = renderHarness(undefined, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));
    await act(async () => {
      h.availabilityCalls[0].deferred.resolve({
        ...ENABLED_AVAILABILITY_BODY,
        availability: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          legalBundleVersion: "future-legal-bundle-v2",
        },
      });
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    });

    expect(h.flow().availabilityStatus).toBe("error");
    expect(h.flow().availabilityCandidate).toBeNull();
    expect(h.flow().canConfirm).toBe(false);
    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(0);
  });
});
