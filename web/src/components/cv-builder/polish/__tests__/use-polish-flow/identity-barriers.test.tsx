// @vitest-environment jsdom
/** Snapshot document/language/reference identity-barrier coverage for usePolishFlow. */

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  openAndReachPreview,
  openAccepted,
  renderHarness,
  successResponse,
} from "./harness";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 3. snapshot identity barriers (document / language / references)
// ---------------------------------------------------------------------------

describe("write-back identity barriers", () => {
  it("reference drift during preview blocks Accept (nothing written)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    expect(snapshot.referencePaths.length).toBeGreaterThan(0);
    const item = h.flow().state.items[0];
    const before = h.form().getValues(item.path as never);
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(before);
    expect(h.flow().state.items[0].state).toBe("pending");
    expect(h.flow().staleItemIds.has(item.id)).toBe(true);
    expect(h.flow().referencesStale).toBe(true);
  });

  it("reference drift blocks Accept All up front (no partial batch)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const paths = h.flow().state.items.map((item) => item.path);
    const before = paths.map((path) => h.form().getValues(path as never));
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().acceptAll();
    });
    expect(paths.map((path) => h.form().getValues(path as never))).toEqual(before);
    expect(h.flow().state.items.every((item) => item.state === "pending")).toBe(true);
    expect(h.flow().referencesStale).toBe(true);
  });

  it("language change with identical text closes and invalidates the reviewed config", async () => {
    const h = renderHarness();
    await openAccepted(h);
    // Same document, every string identical, only typstLang flipped (cloud reset).
    act(() => {
      h.rerender({ language: "en" });
    });
    act(() => {
      h.flow().confirm();
    });
    // No old-language disclosure remains actionable after the commit.
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().canConfirm).toBe(false);
    expect(h.flow().state.snapshot).toBeNull();
  });

  it("language change during preview blocks Accept", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const item = h.flow().state.items[0];
    const before = h.form().getValues(item.path as never);
    act(() => {
      h.rerender({ language: "en" });
    });
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(before);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().state.items).toHaveLength(0);
  });

  it("rapid zh → en → zh keeps an old ready closure non-actionable", async () => {
    const h = renderHarness();
    await openAccepted(h);
    const oldReadyFlow = h.flow();
    expect(oldReadyFlow.canConfirm).toBe(true);

    act(() => h.rerender({ language: "en" }));
    expect(h.flow().isOpen).toBe(false);
    act(() => h.rerender({ language: "zh" }));
    act(() => oldReadyFlow.confirm());

    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().canConfirm).toBe(false);
  });

  it("document switch during loading aborts and resets", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.rerender({ documentId: "doc-2" });
    });
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().isOpen).toBe(false);
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    });
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().state.items).toHaveLength(0);
  });

  it("document switch during preview aborts and resets", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    act(() => {
      h.rerender({ documentId: "doc-2" });
    });
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().isOpen).toBe(false);
  });

  it("stale references do NOT prevent undoing an accepted item", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const item = h.flow().state.items[0];
    const original = h.form().getValues(item.path as never);
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(item.polished);
    // References drift AFTER the accept: undo must still restore the original.
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().undoAcceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(original);
    expect(h.flow().state.items[0].state).toBe("pending");
  });

  it("target-path drift still blocks Accept (existing expectedCurrent guard)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const item = h.flow().state.items[0];
    const before = h.form().getValues(item.path as never);
    act(() => {
      h.form().setValue(item.path as never, "目标字段被外部改动过，内容足够长。" as never);
    });
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("pending");
    expect(h.flow().staleItemIds.has(item.id)).toBe(true);
    expect(h.form().getValues(item.path as never)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. terms/quota state is keyed to the account
// ---------------------------------------------------------------------------
