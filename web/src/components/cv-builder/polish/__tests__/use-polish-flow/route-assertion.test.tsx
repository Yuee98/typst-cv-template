// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  polishExpectedRouteFromAvailability,
  polishPostRequestSchema,
  type PolishAvailabilityResponse,
} from "@/lib/polish/contract";

import {
  DISABLED_AVAILABILITY_BODY,
  ENABLED_AVAILABILITY_BODY,
} from "../client/fixtures";
import { PolishApiError } from "../../polish-client";
import {
  makeQuota,
  makeSession,
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

const UNACCEPTED_DEEPSEEK_BODY: PolishAvailabilityResponse = {
  ...ENABLED_AVAILABILITY_BODY,
  availability: {
    ...ENABLED_AVAILABILITY_BODY.availability,
    termsAccepted: false,
  },
};

function withAcceptedTerms(
  response: PolishAvailabilityResponse,
): PolishAvailabilityResponse {
  if (!response.availability.enabled) {
    throw new Error("accepted-terms fixture requires enabled availability");
  }
  return {
    ...response,
    availability: { ...response.availability, termsAccepted: true },
  };
}

async function beginDeferredAcceptance() {
  const h = renderHarness(undefined, { deferAvailability: true });
  act(() => h.flow().open(SCOPE));
  await act(async () => {
    h.availabilityCalls[0].deferred.resolve(UNACCEPTED_DEEPSEEK_BODY);
    h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
  });
  act(() => h.flow().terms.setChecked(true));
  act(() => h.flow().confirm());
  expect(h.acceptCalls).toHaveLength(1);
  return h;
}

type DeferredAcceptanceHarness = Awaited<
  ReturnType<typeof beginDeferredAcceptance>
>;

const SECOND_AWAIT_RECONFIGURATIONS: ReadonlyArray<
  readonly [
    string,
    (harness: DeferredAcceptanceHarness) => void,
    Readonly<Record<string, unknown>>,
  ]
> = [
  ["context level", (harness) => harness.flow().setLevel(2), { level: 2 }],
  [
    "style preset",
    (harness) => harness.flow().setStylePreset("concise"),
    { stylePreset: "concise" },
  ],
  [
    "custom style instruction",
    (harness) => harness.flow().setStyleInstruction("直接、具体"),
    { styleInstruction: "直接、具体" },
  ],
];

const LATE_SECOND_READ_OUTCOMES: ReadonlyArray<
  readonly [string, (harness: DeferredAcceptanceHarness) => void]
> = [
  [
    "success",
    (harness) =>
      harness.availabilityCalls[1].deferred.resolve(
        withAcceptedTerms(ENABLED_AVAILABILITY_BODY),
      ),
  ],
  [
    "rejection",
    (harness) =>
      harness.availabilityCalls[1].deferred.reject(new TypeError("network")),
  ],
  [
    "cancellation",
    (harness) =>
      harness.availabilityCalls[1].deferred.reject(
        new DOMException("aborted", "AbortError"),
      ),
  ],
  [
    "timeout",
    (harness) =>
      harness.availabilityCalls[1].deferred.reject(
        new PolishApiError({ code: "CLIENT_TIMEOUT" }),
      ),
  ],
];

const SECOND_AWAIT_INVALIDATIONS: ReadonlyArray<
  readonly [string, (harness: DeferredAcceptanceHarness) => void]
> = [
  ["close", (harness) => harness.flow().close()],
  [
    "account switch",
    (harness) => harness.rerender({ session: makeSession("user-b") }),
  ],
  ["document switch", (harness) => harness.rerender({ documentId: "doc-2" })],
  ["manual availability refresh", (harness) => harness.flow().availabilityRetry()],
];

afterEach(() => {
  cleanup();
});

describe("usePolishFlow exact route assertion", () => {
  it("POSTs frozen content plus only a fresh id and the exact six-key assertion", async () => {
    const h = renderHarness();
    await openAccepted(h);
    expect(h.availabilityCalls[0].expectedUserId).toBe("user-a");
    expect(h.quotaOwners).toEqual(["user-a"]);

    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(1);
    expect(h.polishCalls[0].expectedUserId).toBe("user-a");
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
    expect(h.acceptCalls[0].userId).toBe("user-a");
    await act(async () => h.acceptCalls[0].resolve());
    expect(h.polishCalls).toHaveLength(0);
    expect(h.hasAcceptedCalls).toHaveLength(2);
    expect(h.availabilityCalls[1].expectedUserId).toBe("user-a");
    await act(async () => h.hasAcceptedCalls[1].resolve(true));
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
    expect(h.polishCalls).toHaveLength(1);
    expect(h.availabilityCalls).toHaveLength(3);
    await act(async () => {
      h.availabilityCalls[2].deferred.resolve(
        withAcceptedTerms(MIMO_AVAILABILITY_BODY),
      );
    });

    expect(h.polishCalls).toHaveLength(2);
    expect(h.polishCalls[1].request.clientRequestId).not.toBe(firstClientRequestId);
    expect(h.polishCalls[1].request.expectedRoute).toEqual(
      polishExpectedRouteFromAvailability(MIMO_AVAILABILITY_BODY.availability),
    );
  });

  it("requires explicit reconfirmation when the post-acceptance authority changed", async () => {
    const randomUuid = vi.spyOn(crypto, "randomUUID");
    try {
      const h = await beginDeferredAcceptance();
      await act(async () => h.acceptCalls[0].resolve());
      const uuidCountBeforeFreshProof = randomUuid.mock.calls.length;
      expect(h.polishCalls).toHaveLength(0);
      expect(h.availabilityCalls).toHaveLength(2);

      await act(async () => {
        h.availabilityCalls[1].deferred.resolve(
          withAcceptedTerms(MIMO_AVAILABILITY_BODY),
        );
      });

      expect(randomUuid.mock.calls).toHaveLength(uuidCountBeforeFreshProof);
      expect(h.polishCalls).toHaveLength(0);
      expect(h.flow().routeChangedHint).toBe(true);
      expect(h.flow().availabilityCandidate?.displayDisclosure.key).toBe(
        "mimo-cn-v1",
      );
      expect(h.flow().canConfirm).toBe(true);

      act(() => h.flow().confirm());
      expect(h.polishCalls).toHaveLength(1);
      expect(h.polishCalls[0].request.expectedRoute).toEqual(
        polishExpectedRouteFromAvailability(MIMO_AVAILABILITY_BODY.availability),
      );
    } finally {
      randomUuid.mockRestore();
    }
  });

  it("does not send when the fresh authority still reports terms unaccepted", async () => {
    const h = await beginDeferredAcceptance();
    await act(async () => h.acceptCalls[0].resolve());
    await act(async () => {
      h.availabilityCalls[1].deferred.resolve(UNACCEPTED_DEEPSEEK_BODY);
    });

    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().terms).toMatchObject({ status: "required", checked: false });
    expect(h.flow().canConfirm).toBe(false);
  });

  it("does not send when post-acceptance availability is disabled or fails", async () => {
    const disabled = await beginDeferredAcceptance();
    await act(async () => disabled.acceptCalls[0].resolve());
    await act(async () => {
      disabled.availabilityCalls[1].deferred.resolve(DISABLED_AVAILABILITY_BODY);
    });
    expect(disabled.polishCalls).toHaveLength(0);
    expect(disabled.flow().availabilityStatus).toBe("disabled");

    cleanup();
    const failed = await beginDeferredAcceptance();
    await act(async () => failed.acceptCalls[0].resolve());
    await act(async () => {
      failed.availabilityCalls[1].deferred.reject(new TypeError("network"));
    });
    expect(failed.polishCalls).toHaveLength(0);
    expect(failed.flow().availabilityStatus).toBe("error");
  });

  it("fails closed on unknown fresh legal/disclosure authority and language drift during the second await", async () => {
    const unknown = await beginDeferredAcceptance();
    await act(async () => unknown.acceptCalls[0].resolve());
    await act(async () => {
      unknown.availabilityCalls[1].deferred.resolve({
        ...ENABLED_AVAILABILITY_BODY,
        availability: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          displayDisclosure: {
            ...ENABLED_AVAILABILITY_BODY.availability.displayDisclosure,
            key: "unknown-provider-v1",
          },
          termsAccepted: true,
        },
      });
    });
    expect(unknown.polishCalls).toHaveLength(0);
    expect(unknown.flow().availabilityStatus).toBe("error");

    cleanup();
    const unknownBundle = await beginDeferredAcceptance();
    await act(async () => unknownBundle.acceptCalls[0].resolve());
    await act(async () => {
      unknownBundle.availabilityCalls[1].deferred.resolve({
        ...ENABLED_AVAILABILITY_BODY,
        availability: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          legalBundleVersion: "future-legal-bundle-v2",
          termsAccepted: true,
        },
      });
    });
    expect(unknownBundle.polishCalls).toHaveLength(0);
    expect(unknownBundle.flow().availabilityStatus).toBe("error");

    cleanup();
    const drifted = await beginDeferredAcceptance();
    await act(async () => drifted.acceptCalls[0].resolve());
    expect(drifted.availabilityCalls).toHaveLength(2);
    act(() => drifted.rerender({ language: "en" }));
    expect(drifted.availabilityCalls[1].signal?.aborted).toBe(true);
    await act(async () => {
      drifted.availabilityCalls[1].deferred.resolve({
        ...ENABLED_AVAILABILITY_BODY,
        availability: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          termsAccepted: true,
        },
      });
    });
    expect(drifted.polishCalls).toHaveLength(0);
    expect(drifted.flow().isOpen).toBe(false);
  });

  it("rebuilds instead of sending when form content drifts during the second await", async () => {
    const h = await beginDeferredAcceptance();
    await act(async () => h.acceptCalls[0].resolve());
    act(() => {
      h.form().setValue("skills.0.body", "第二次 authority await 期间变化" as never);
    });
    await act(async () => {
      h.availabilityCalls[1].deferred.resolve({
        ...ENABLED_AVAILABILITY_BODY,
        availability: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          termsAccepted: true,
        },
      });
    });

    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().configChangedHint).toBe(true);
    expect(h.flow().state.snapshot?.apiRequest.items[0].text).toBe(
      "第二次 authority await 期间变化",
    );
  });

  it.each(SECOND_AWAIT_RECONFIGURATIONS)(
    "%s replaces an operation-owned second read and requires explicit reconfirmation",
    async (_label, reconfigure, expectedParams) => {
      const h = await beginDeferredAcceptance();
      await act(async () => h.acceptCalls[0].resolve());
      expect(h.availabilityCalls).toHaveLength(2);

      act(() => reconfigure(h));

      expect(h.availabilityCalls[1].signal?.aborted).toBe(true);
      expect(h.availabilityCalls).toHaveLength(3);
      expect(h.availabilityCalls[2].signal?.aborted).toBe(false);
      expect(h.flow().availabilityStatus).toBe("loading");
      expect(h.flow().availabilityCandidate).toBeNull();
      expect(h.flow().state.params).toEqual(expect.objectContaining(expectedParams));
      expect(h.polishCalls).toHaveLength(0);

      await act(async () => {
        h.availabilityCalls[1].deferred.resolve(
          withAcceptedTerms(ENABLED_AVAILABILITY_BODY),
        );
      });
      expect(h.flow().availabilityStatus).toBe("loading");
      expect(h.availabilityCalls[2].signal?.aborted).toBe(false);
      expect(h.polishCalls).toHaveLength(0);

      await act(async () => {
        h.availabilityCalls[2].deferred.resolve(
          withAcceptedTerms(ENABLED_AVAILABILITY_BODY),
        );
      });
      expect(h.flow().availabilityStatus).toBe("ready");
      expect(h.flow().terms.status).toBe("accepted");
      expect(h.flow().canConfirm).toBe(true);
      expect(h.polishCalls).toHaveLength(0);

      act(() => h.flow().confirm());
      expect(h.polishCalls).toHaveLength(1);
    },
  );

  it.each(LATE_SECOND_READ_OUTCOMES)(
    "keeps the replacement authority read owned after the old second read has a late %s",
    async (_label, settleOldRead) => {
      const h = await beginDeferredAcceptance();
      await act(async () => h.acceptCalls[0].resolve());

      act(() => h.flow().setLevel(2));
      expect(h.availabilityCalls).toHaveLength(3);
      const replacementRead = h.availabilityCalls[2];

      await act(async () => settleOldRead(h));
      expect(replacementRead.signal?.aborted).toBe(false);
      expect(h.flow().availabilityStatus).toBe("loading");
      expect(h.flow().availabilityCandidate).toBeNull();
      expect(h.polishCalls).toHaveLength(0);

      await act(async () => {
        replacementRead.deferred.resolve(
          withAcceptedTerms(ENABLED_AVAILABILITY_BODY),
        );
      });
      expect(h.flow().availabilityStatus).toBe("ready");
      expect(h.flow().canConfirm).toBe(true);
      expect(h.polishCalls).toHaveLength(0);
    },
  );

  it("keeps one replacement read through repeated custom-instruction setters", async () => {
    const h = await beginDeferredAcceptance();
    await act(async () => h.acceptCalls[0].resolve());

    act(() => h.flow().setStyleInstruction("直"));
    expect(h.availabilityCalls).toHaveLength(3);
    const replacementRead = h.availabilityCalls[2];

    act(() => h.flow().setStyleInstruction("直接"));
    act(() => h.flow().setStyleInstruction("直接、具体"));
    expect(h.availabilityCalls).toHaveLength(3);
    expect(replacementRead.signal?.aborted).toBe(false);

    await act(async () => {
      h.availabilityCalls[1].deferred.reject(new TypeError("late old read"));
      replacementRead.deferred.resolve(
        withAcceptedTerms(ENABLED_AVAILABILITY_BODY),
      );
    });
    expect(h.flow().state.params.styleInstruction).toBe("直接、具体");
    expect(h.flow().availabilityStatus).toBe("ready");
    expect(h.flow().canConfirm).toBe(true);
    expect(h.polishCalls).toHaveLength(0);

    act(() => h.flow().confirm());
    expect(h.polishCalls).toHaveLength(1);
    expect(h.polishCalls[0].request.styleInstruction).toBe("直接、具体");
  });

  it.each(SECOND_AWAIT_INVALIDATIONS)(
    "%s invalidates the post-acceptance authority continuation",
    async (_label, invalidate) => {
      const h = await beginDeferredAcceptance();
      await act(async () => h.acceptCalls[0].resolve());
      expect(h.availabilityCalls).toHaveLength(2);

      act(() => invalidate(h));
      expect(h.availabilityCalls[1].signal?.aborted).toBe(true);
      await act(async () => {
        h.availabilityCalls[1].deferred.resolve(
          withAcceptedTerms(ENABLED_AVAILABILITY_BODY),
        );
      });

      expect(h.polishCalls).toHaveLength(0);
    },
  );

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
