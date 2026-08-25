// @vitest-environment jsdom
/** Prerequisite, terms, quota, and account-generation coverage for usePolishFlow. */

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  abortError,
  makeQuota,
  makeSession,
  openAccepted,
  openRequiredAndConfirm,
  renderHarness,
  SCOPE,
} from "./harness";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. terms-acceptance window: dismissal/change during accept() sends nothing
// ---------------------------------------------------------------------------

describe("terms-acceptance window", () => {
  it("sends the reviewed snapshot after acceptance (happy path)", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    const disclosed = h.flow().state.snapshot;
    expect(disclosed).not.toBeNull();
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.hasAcceptedCalls).toHaveLength(2);
    await act(async () => {
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.polishCalls).toHaveLength(1);
    const sent = h.polishCalls[0].request;
    // Content is frozen; only the id changes and the reviewed route assertion
    // is added outside the form-derived snapshot.
    expect(sent.clientRequestId).not.toBe(disclosed!.apiRequest.clientRequestId);
    const { expectedRoute, ...sentContent } = sent;
    expect({ ...sentContent, clientRequestId: "fixed" }).toEqual({
      ...disclosed!.apiRequest,
      clientRequestId: "fixed",
    });
    expect(expectedRoute).toEqual({
      schemaVersion: "expected_route_v1",
      configGeneration: "42",
      profileVersionId: "11111111-1111-4111-8111-111111111111",
      legalBundleVersion: "2026-08-23-multi-provider-v1",
      runtimeContractId: "runtime.deepseek-v2.v1",
      runtimeContractSha256: "a".repeat(64),
    });
    expect(h.acceptCalls[0].legalBundleVersion).toBe(expectedRoute.legalBundleVersion);
    expect(h.flow().state.phase).toBe("loading");
  });

  it("close during acceptance → no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().close();
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().state.phase).toBe("config");
  });

  it("unmount during acceptance → no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    h.unmount();
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
  });

  it("document switch during acceptance → no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.rerender({ documentId: "doc-2" });
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().state.phase).toBe("config");
  });

  it("level change during acceptance → disclosure rebuilt, no silent send", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().setLevel(2);
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().state.phase).toBe("config");
    // The disclosure was rebuilt with the new level for explicit re-review.
    expect(h.flow().state.params.level).toBe(2);
    expect(h.flow().state.snapshot?.apiRequest.context.level).toBe(2);
  });

  it("form change during acceptance → disclosure rebuilt + hint, no silent send", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    const targetPath = h.flow().state.snapshot!.targets[0].path;
    act(() => {
      h.form().setValue(targetPath as never, "云端同步进来的新内容，长度足够。" as never);
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().configChangedHint).toBe(true);
  });

  it("failed acceptance write → terms error, no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    await act(async () => {
      h.acceptCalls[0].reject(new Error("network"));
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().terms.status).toBe("error");
    expect(h.flow().state.phase).toBe("config");
  });
});



describe("account keying", () => {
  it("account change resets terms/quota and closes the dialog; B must re-query", async () => {
    const h = renderHarness();
    await openAccepted(h);
    expect(h.flow().terms.status).toBe("accepted");
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    expect(h.flow().terms.status).toBe("unknown");
    expect(h.flow().terms.checked).toBe(false);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().quota).toBeNull();
    // B opens the dialog: a fresh query runs and confirm waits for it.
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    expect(h.flow().terms.status).toBe("checking");
    expect(h.flow().canConfirm).toBe(false);
    expect(h.availabilityCalls[1].expectedUserId).toBe("user-b");
    expect(h.quotaOwners).toEqual(["user-a", "user-b"]);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(7) });
      h.hasAcceptedCalls[1].resolve(false);
    });
    expect(h.flow().terms.status).toBe("required");
    // B has not consented yet.
    expect(h.flow().canConfirm).toBe(false);
    act(() => {
      h.flow().terms.setChecked(true);
    });
    expect(h.flow().canConfirm).toBe(true);
  });

  it("a late resolve of A's terms query never lands in B's gate", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(1);
    // Switch accounts BEFORE A's query resolves.
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    expect(h.flow().terms.status).toBe("checking");
    // A's query resolves late: dropped, B still checking.
    await act(async () => {
      h.hasAcceptedCalls[0].resolve(true);
    });
    expect(h.flow().terms.status).toBe("checking");
    await act(async () => {
      h.hasAcceptedCalls[1].resolve(true);
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(7) });
    });
    expect(h.flow().terms.status).toBe("accepted");
  });

  it("account change during terms acceptance → no request, gate reset", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().terms.status).toBe("unknown");
    expect(h.flow().isOpen).toBe(false);
  });

  it("a late resolve of A's quota query never lands in B's quota display", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(1);
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(1) });
    });
    expect(h.flow().quota).toBeNull();
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(9) });
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().quota?.remaining).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 5. cancel discards the quota display until the settle-point re-read lands
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// 9. round 2: quota/terms continuations are generation-scoped + account-owned
// ---------------------------------------------------------------------------

describe("round 2: quota/terms generation and account ownership", () => {
  it("A cancels, account switches to B, A settles: B's quota state untouched", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    act(() => {
      h.flow().cancel();
    });
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.hasAcceptedCalls).toHaveLength(2);
    // A's canceled request settles: no settle-point re-read under B.
    await act(async () => {
      h.polishCalls[0].deferred.reject(abortError());
    });
    expect(h.quotaCalls).toHaveLength(2);
    // B's own read completes normally — never stuck in the loading state an
    // old-account settle could otherwise leave behind.
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(9) });
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().quotaStatus).toBe("ready");
    expect(h.flow().quota?.remaining).toBe(9);
  });

  it("two same-account quota reads resolving out of order: the newer wins", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(1);
    act(() => {
      h.flow().quotaRetry();
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(9) });
    });
    expect(h.flow().quota?.remaining).toBe(9);
    // The older read resolves late: dropped, never overwrites the newer one.
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(1) });
    });
    expect(h.flow().quota?.remaining).toBe(9);
  });

  it("two same-account terms queries resolving out of order: the newer result stands", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(1);
    act(() => {
      h.flow().refreshTerms();
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    await act(async () => {
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().terms.status).toBe("accepted");
    await act(async () => {
      h.hasAcceptedCalls[0].resolve(false);
    });
    expect(h.flow().terms.status).toBe("accepted");
  });
});
