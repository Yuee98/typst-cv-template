// @vitest-environment jsdom
/** Preview accept-all and effect-tiered transition coverage for usePolishFlow. */

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { openAndReachPreview, renderHarness } from "./use-polish-flow.test-harness";

afterEach(() => {
  cleanup();
});

describe("round 2: acceptAll full-batch preflight", () => {
  it("target drift on a later item blocks the whole batch (first target untouched)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const items = h.flow().state.items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const beforeFirst = h.form().getValues(items[0].path as never);
    act(() => {
      h.form().setValue(items[1].path as never, "第二项被外部改动过，内容足够长。" as never);
    });
    act(() => {
      h.flow().acceptAll();
    });
    expect(h.form().getValues(items[0].path as never)).toBe(beforeFirst);
    expect(h.flow().state.items.every((item) => item.state === "pending")).toBe(true);
    expect(h.flow().staleItemIds.has(items[1].id)).toBe(true);
  });

  it("an externally reverted accepted item blocks the whole batch", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const items = h.flow().state.items;
    act(() => {
      h.flow().acceptItem(items[0].id);
    });
    expect(h.form().getValues(items[0].path as never)).toBe(items[0].polished);
    // External edit clobbers the accepted write-back: reducer and form diverged.
    act(() => {
      h.form().setValue(items[0].path as never, "外部还原成了别的内容，长度足够。" as never);
    });
    const beforeSecond = h.form().getValues(items[1].path as never);
    act(() => {
      h.flow().acceptAll();
    });
    expect(h.form().getValues(items[1].path as never)).toBe(beforeSecond);
    expect(h.flow().state.items[1].state).toBe("pending");
    expect(h.flow().staleItemIds.has(items[0].id)).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// 11. round 2: write-back barriers tiered by the transition's actual effect
// ---------------------------------------------------------------------------

describe("round 2: effect-tiered write-back barriers", () => {
  it("reference drift does not block rejecting a pending item", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const item = h.flow().state.items[0];
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().rejectItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("rejected");
    expect(h.flow().staleItemIds.has(item.id)).toBe(false);
  });

  it("language drift does not block rejecting a pending item", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const item = h.flow().state.items[0];
    act(() => {
      h.rerender({ language: "en" });
    });
    act(() => {
      h.flow().rejectItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("rejected");
  });

  it("reference drift does not block undoing a rejection", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const item = h.flow().state.items[0];
    act(() => {
      h.flow().rejectItem(item.id);
    });
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().undoRejectItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("pending");
  });

  it("Reject All restores accepted values despite reference drift", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const items = h.flow().state.items;
    const original = h.form().getValues(items[0].path as never);
    act(() => {
      h.flow().acceptItem(items[0].id);
    });
    expect(h.form().getValues(items[0].path as never)).toBe(items[0].polished);
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().rejectAll();
    });
    expect(h.form().getValues(items[0].path as never)).toBe(original);
    expect(h.flow().state.items.every((item) => item.state === "rejected")).toBe(true);
  });
});

