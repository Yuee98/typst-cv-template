// @vitest-environment jsdom
/** Request ownership, cancellation settlement, commit races, and unmount coverage for usePolishFlow. */

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PolishApiError } from "./polish-client";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import {
  abortError,
  flushRealScheduling,
  makeQuota,
  openAccepted,
  openRequiredAndConfirm,
  renderHarness,
  renderRaceParent,
  renderUnmountRace,
  SCOPE,
  successResponse,
} from "./use-polish-flow.test-harness";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 2. in-flight ownership: late settle of a canceled request disturbs nothing
// ---------------------------------------------------------------------------

describe("in-flight request ownership", () => {
  async function cancelAStartB(h: ReturnType<typeof renderHarness>) {
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(1);
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.flow().cancel();
    });
    expect(h.flow().state.phase).toBe("config");
    // B starts before A settles (hook-level; the UI blocks its button until
    // the quota re-read lands — covered in the cancel-quota tests).
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(2);
    expect(h.flow().state.phase).toBe("loading");
  }

  it("cancel A, start B, A resolves successfully → B untouched", async () => {
    const h = renderHarness();
    await cancelAStartB(h);
    const bRequestId = h.flow().state.clientRequestId;
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 3, "srv-A"));
    });
    // A's late success must not move the reducer, quota or terms state; its
    // only side effect is the canceled operation's settle-point quota re-read.
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().state.phase).toBe("loading");
    expect(h.flow().state.clientRequestId).toBe(bRequestId);
    expect(h.flow().quota).toBeNull();
    expect(h.flow().terms.serverRejected).toBe(false);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
    });
    // B is still cancellable and completes normally.
    await act(async () => {
      h.polishCalls[1].deferred.resolve(successResponse(h.polishCalls[1].request, 4, "srv-B"));
    });
    expect(h.flow().state.phase).toBe("preview");
    expect(h.flow().quota?.remaining).toBe(4);
  });

  it("cancel A, start B, A returns 403 AI_TERMS_REQUIRED → B untouched", async () => {
    const h = renderHarness();
    await cancelAStartB(h);
    const bRequestId = h.flow().state.clientRequestId;
    await act(async () => {
      h.polishCalls[0].deferred.reject(new PolishApiError({ code: "AI_TERMS_REQUIRED", status: 403 }));
    });
    // A's 403 must NOT re-show the checkbox or abort B's request.
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().terms.serverRejected).toBe(false);
    expect(h.flow().terms.status).toBe("accepted");
    expect(h.flow().state.phase).toBe("loading");
    expect(h.flow().state.clientRequestId).toBe(bRequestId);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.polishCalls[1].deferred.resolve(successResponse(h.polishCalls[1].request, 4, "srv-B"));
    });
    expect(h.flow().state.phase).toBe("preview");
  });

  it("cancel A, start B, A fails with a network error → B untouched", async () => {
    const h = renderHarness();
    await cancelAStartB(h);
    const bRequestId = h.flow().state.clientRequestId;
    await act(async () => {
      h.polishCalls[0].deferred.reject(
        new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.networkError }),
      );
    });
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().state.phase).toBe("loading");
    expect(h.flow().state.clientRequestId).toBe(bRequestId);
    expect(h.flow().state.error).toBeNull();
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.polishCalls[1].deferred.resolve(successResponse(h.polishCalls[1].request, 4, "srv-B"));
    });
    expect(h.flow().state.phase).toBe("preview");
  });

  it("close during loading aborts; the late response changes nothing", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    act(() => {
      h.flow().close();
    });
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    });
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().state.items).toHaveLength(0);
  });
});



describe("cancel quota refresh", () => {
  it("cancel marks quota stale, blocks confirm, refreshes from the settle point", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.flow().cancel();
    });
    expect(h.flow().state.phase).toBe("config");
    // The pre-request count is discarded; confirm waits for the re-read.
    expect(h.flow().quota).toBeNull();
    expect(h.flow().quotaStatus).toBe("loading");
    expect(h.flow().canConfirm).toBe(false);
    // No re-read yet: it fires from the request's settlement point, not abort().
    expect(h.quotaCalls).toHaveLength(1);
    await act(async () => {
      h.polishCalls[0].deferred.reject(abortError());
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(4) });
    });
    expect(h.flow().quotaStatus).toBe("ready");
    expect(h.flow().quota?.remaining).toBe(4);
    expect(h.flow().canConfirm).toBe(true);
  });

  it("a canceled request resolving successfully still triggers the re-read", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    act(() => {
      h.flow().cancel();
    });
    // The response raced the abort: late success. Quota must still be re-read
    // (and the late response itself must not become the displayed quota).
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 1, "srv-A"));
    });
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().quota).toBeNull();
    expect(h.flow().quotaStatus).toBe("loading");
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(3) });
    });
    expect(h.flow().quota?.remaining).toBe(3);
    expect(h.flow().canConfirm).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// 6. round 2: commit-synchronous invalidation (parent layout-effect race)
// ---------------------------------------------------------------------------



describe("round 2: commit-synchronous invalidation", () => {
  it("account switch committed while acceptance pending: the in-layout resolve sends no request", async () => {
    const h = renderRaceParent();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(false);
    });
    act(() => {
      h.flow().terms.setChecked(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.acceptCalls).toHaveLength(1);
    expect(h.flow().terms.status).toBe("accepting");
    // Resolve A's acceptance the instant the account switch commits — the
    // continuation races the hook's identity publication.
    h.onCommitRef.current = () => h.acceptCalls[0].resolve();
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.switchSession("user-b");
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().terms.status).toBe("unknown");
    expect(h.flow().isOpen).toBe(false);
  });

  it("document switch committed while request in flight: the in-layout response applies nothing", async () => {
    const h = renderRaceParent();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(1);
    expect(h.flow().state.phase).toBe("loading");
    h.onCommitRef.current = () =>
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.switchDocument("doc-2");
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().state.items).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    // The late response must not become the displayed quota; the invalidated
    // in-flight request owes a settle-point re-read instead.
    expect(h.flow().quota?.remaining ?? null).not.toBe(4);
    expect(h.quotaCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 7. round 2: acceptAll validates every target before the first write
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// 8. round 2: a superseded terms acceptance never moves a newer dialog
// ---------------------------------------------------------------------------

describe("round 2: superseded terms acceptance", () => {
  async function closeAndReopenWhileAcceptPending(h: ReturnType<typeof renderHarness>) {
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().close();
    });
    // Reopen on the same account before the old acceptance settles: the gate
    // must be unlocked (never stuck in "accepting") and a fresh query runs.
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    expect(h.flow().terms.status).toBe("checking");
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.hasAcceptedCalls[1].resolve(false);
    });
    expect(h.flow().terms.status).toBe("required");
  }

  it("old accept failure after close+reopen does not error the new dialog", async () => {
    const h = renderHarness();
    await closeAndReopenWhileAcceptPending(h);
    await act(async () => {
      h.acceptCalls[0].reject(new Error("network"));
    });
    expect(h.flow().terms.status).toBe("required");
    expect(h.polishCalls).toHaveLength(0);
  });

  it("old accept success after close+reopen does not overwrite the new query", async () => {
    const h = renderHarness();
    await closeAndReopenWhileAcceptPending(h);
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    // The new query said "required"; the superseded acceptance must not flip it.
    expect(h.flow().terms.status).toBe("required");
    expect(h.polishCalls).toHaveLength(0);
  });

  it("param change during acceptance unlocks the gate and re-queries", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().setLevel(2);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    await act(async () => {
      h.hasAcceptedCalls[1].resolve(false);
      h.acceptCalls[0].resolve();
    });
    // The new query owns the gate: required, not stuck accepting, not
    // flipped by the superseded success.
    expect(h.flow().terms.status).toBe("required");
    expect(h.polishCalls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// 10. round 2: X/close during loading shares cancel's settlement semantics
// ---------------------------------------------------------------------------

describe("round 2: unified loading-close settlement", () => {
  it("close during loading: a pre-settlement reopen read cannot unblock confirm", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.flow().close();
    });
    // Same as cancel(): quota discarded, settlement owed.
    expect(h.flow().quota).toBeNull();
    expect(h.flow().quotaStatus).toBe("loading");
    // Reopen before the canceled request settles: the ordinary open read
    // lands first, but must NOT unblock confirm.
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().quotaStatus).toBe("ready");
    expect(h.flow().quota?.remaining).toBe(5);
    expect(h.flow().canConfirm).toBe(false);
    // The canceled request settles → settle-point re-read → confirm unblocks.
    await act(async () => {
      h.polishCalls[0].deferred.reject(abortError());
    });
    expect(h.quotaCalls).toHaveLength(3);
    await act(async () => {
      h.quotaCalls[2].resolve({ requestId: "q-3", quota: makeQuota(4) });
    });
    expect(h.flow().quota?.remaining).toBe(4);
    expect(h.flow().canConfirm).toBe(true);
  });
});


describe("round 4: commit-synchronous unmount invalidation", () => {
  it("unmount while acceptance pending: resolving inside the unmount commit sends nothing", async () => {
    const h = renderUnmountRace();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(false);
    });
    act(() => {
      h.flow().terms.setChecked(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.acceptCalls).toHaveLength(1);
    expect(h.flow().terms.status).toBe("accepting");
    // Resolve the acceptance INSIDE the unmount commit: the continuation
    // races the child's (passive, pre-fix) cleanup.
    h.onCommitRef.current = () => h.acceptCalls[0].resolve();
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.unmountChild();
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    // No request after unmount, no follow-up quota read, no terms side
    // effects (the gate's continuations were generation-killed at removal).
    expect(h.polishCalls).toHaveLength(0);
    expect(h.quotaCalls).toHaveLength(1);
  });

  it("unmount while request in flight: the operation is already aborted inside the unmount commit", async () => {
    const h = renderUnmountRace();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(1);
    expect(h.flow().state.phase).toBe("loading");
    const signal = h.polishCalls[0].signal;
    expect(signal?.aborted).toBe(false);
    // Inside the unmount commit the child must ALREADY be invalidated: with
    // a passive cleanup (pre-fix) the controller is not aborted yet when the
    // parent's layout effect runs.
    let abortedAtCommit: boolean | null = null;
    h.onCommitRef.current = () => {
      abortedAtCommit = signal?.aborted ?? null;
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    };
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.unmountChild();
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    expect(abortedAtCommit).toBe(true);
    // The late response applied nothing and triggered no follow-up reads.
    expect(h.quotaCalls).toHaveLength(1);
  });
});


