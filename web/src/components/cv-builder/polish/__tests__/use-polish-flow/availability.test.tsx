// @vitest-environment jsdom

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DISABLED_AVAILABILITY_BODY,
  ENABLED_AVAILABILITY_BODY,
} from "../client/fixtures";
import {
  makeQuota,
  makeSession,
  renderHarness,
  SCOPE,
} from "./harness";

describe("usePolishFlow runtime availability", () => {
  it("performs no render-time, signed-out or document-less availability read", () => {
    const initial = renderHarness();
    expect(initial.availabilityCalls).toHaveLength(0);

    const signedOut = renderHarness({ session: null });
    act(() => signedOut.flow().open(SCOPE));
    expect(signedOut.availabilityCalls).toHaveLength(0);
    expect(signedOut.flow().availabilityStatus).toBe("idle");
    expect(signedOut.flow().canConfirm).toBe(false);

    const noDocument = renderHarness({ documentId: null });
    act(() => noDocument.flow().open(SCOPE));
    expect(noDocument.availabilityCalls).toHaveLength(0);
    expect(noDocument.flow().isOpen).toBe(false);
  });

  it("publishes one exact enabled candidate and makes it a hard confirm gate", async () => {
    const h = renderHarness(undefined, { deferAvailability: true });

    act(() => h.flow().open(SCOPE));
    expect(h.availabilityCalls).toHaveLength(1);
    expect(h.flow().availabilityStatus).toBe("loading");
    expect(h.flow().availabilityCandidate).toBeNull();
    expect(h.flow().canConfirm).toBe(false);

    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(0);

    await act(async () => {
      h.availabilityCalls[0].deferred.resolve(ENABLED_AVAILABILITY_BODY);
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    });

    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().availabilityCandidate).toEqual(ENABLED_AVAILABILITY_BODY.availability);
    expect(h.flow().canConfirm).toBe(true);
  });

  it("keeps an ordinary initial availability read alive across configuration changes", async () => {
    const h = renderHarness(undefined, { deferAvailability: true });

    act(() => h.flow().open(SCOPE));
    expect(h.availabilityCalls).toHaveLength(1);
    act(() => h.flow().setLevel(2));

    expect(h.availabilityCalls).toHaveLength(1);
    expect(h.availabilityCalls[0].signal?.aborted).toBe(false);
    expect(h.flow().state.params.level).toBe(2);

    await act(async () => {
      h.availabilityCalls[0].deferred.resolve(ENABLED_AVAILABILITY_BODY);
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    });
    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().state.snapshot?.apiRequest.context.level).toBe(2);
    expect(h.flow().canConfirm).toBe(true);
  });

  it("clears stale disclosure immediately and lets only the newest refresh publish", async () => {
    const h = renderHarness(undefined, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));

    await act(async () => {
      h.availabilityCalls[0].deferred.resolve(ENABLED_AVAILABILITY_BODY);
    });
    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().availabilityCandidate).toEqual(ENABLED_AVAILABILITY_BODY.availability);

    act(() => h.flow().availabilityRetry());
    expect(h.availabilityCalls).toHaveLength(2);
    expect(h.flow().availabilityStatus).toBe("loading");
    expect(h.flow().availabilityCandidate).toBeNull();

    act(() => h.flow().availabilityRetry());
    expect(h.availabilityCalls).toHaveLength(3);
    expect(h.availabilityCalls[1].signal?.aborted).toBe(true);

    await act(async () => {
      h.availabilityCalls[1].deferred.resolve(ENABLED_AVAILABILITY_BODY);
    });
    expect(h.flow().availabilityStatus).toBe("loading");
    expect(h.flow().availabilityCandidate).toBeNull();

    await act(async () => {
      h.availabilityCalls[2].deferred.resolve(ENABLED_AVAILABILITY_BODY);
    });
    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().availabilityCandidate).toEqual(ENABLED_AVAILABILITY_BODY.availability);
  });

  it("treats disabled and failed reads as candidate-free non-confirmable states", async () => {
    const h = renderHarness(undefined, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));

    await act(async () => {
      h.availabilityCalls[0].deferred.resolve(DISABLED_AVAILABILITY_BODY);
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    });
    expect(h.flow().availabilityStatus).toBe("disabled");
    expect(h.flow().availabilityCandidate).toBeNull();
    expect(h.flow().canConfirm).toBe(false);
    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(0);

    act(() => h.flow().availabilityRetry());
    expect(h.flow().availabilityStatus).toBe("loading");
    await act(async () => {
      h.availabilityCalls[1].deferred.reject(new TypeError("network failed"));
    });
    expect(h.flow().availabilityStatus).toBe("error");
    expect(h.flow().availabilityCandidate).toBeNull();
    expect(h.flow().canConfirm).toBe(false);
  });

  it("keeps an enabled but legally unknown display key non-confirmable", async () => {
    const h = renderHarness(undefined, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));

    await act(async () => {
      h.availabilityCalls[0].deferred.resolve({
        ...ENABLED_AVAILABILITY_BODY,
        availability: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          displayDisclosure: {
            key: "future-provider-v1",
            providerName: "Future Provider",
            modelName: "Future Model",
          },
        },
      });
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    });

    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().availabilityCandidate?.displayDisclosure.key).toBe("future-provider-v1");
    expect(h.flow().canConfirm).toBe(false);
    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(0);
  });

  it("revokes close and account-switch reads before late results can publish", async () => {
    const closeHarness = renderHarness(undefined, { deferAvailability: true });
    act(() => closeHarness.flow().open(SCOPE));
    act(() => closeHarness.flow().close());
    expect(closeHarness.availabilityCalls[0].signal?.aborted).toBe(true);
    act(() => closeHarness.flow().availabilityRetry());
    expect(closeHarness.availabilityCalls).toHaveLength(1);
    await act(async () => {
      closeHarness.availabilityCalls[0].deferred.resolve(ENABLED_AVAILABILITY_BODY);
    });
    expect(closeHarness.flow().availabilityStatus).toBe("idle");
    expect(closeHarness.flow().availabilityCandidate).toBeNull();

    const accountHarness = renderHarness(undefined, { deferAvailability: true });
    act(() => accountHarness.flow().open(SCOPE));
    act(() => accountHarness.rerender({ session: makeSession("user-b") }));
    expect(accountHarness.availabilityCalls[0].signal?.aborted).toBe(true);
    await act(async () => {
      accountHarness.availabilityCalls[0].deferred.resolve(ENABLED_AVAILABILITY_BODY);
    });
    expect(accountHarness.flow().availabilityStatus).toBe("idle");
    expect(accountHarness.flow().availabilityCandidate).toBeNull();

    act(() => accountHarness.flow().open(SCOPE));
    expect(accountHarness.availabilityCalls).toHaveLength(2);
    await act(async () => {
      accountHarness.availabilityCalls[1].deferred.resolve(ENABLED_AVAILABILITY_BODY);
    });
    expect(accountHarness.flow().availabilityStatus).toBe("ready");

    const documentHarness = renderHarness(undefined, { deferAvailability: true });
    act(() => documentHarness.flow().open(SCOPE));
    act(() => documentHarness.rerender({ documentId: "doc-2" }));
    expect(documentHarness.availabilityCalls[0].signal?.aborted).toBe(true);
    await act(async () => {
      documentHarness.availabilityCalls[0].deferred.resolve(ENABLED_AVAILABILITY_BODY);
    });
    expect(documentHarness.flow().availabilityStatus).toBe("idle");
    expect(documentHarness.flow().availabilityCandidate).toBeNull();
  });

  it("aborts the active availability read on unmount", () => {
    const h = renderHarness(undefined, { deferAvailability: true });
    act(() => h.flow().open(SCOPE));
    h.unmount();
    expect(h.availabilityCalls[0].signal?.aborted).toBe(true);
  });
});
