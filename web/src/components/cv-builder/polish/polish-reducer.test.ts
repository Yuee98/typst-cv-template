import { describe, expect, it } from "vitest";

import {
  countItems,
  createInitialState,
  expectedCurrent,
  POLISH_CLIENT_ERROR_CODES,
  polishReducer,
  type PolishAction,
  type PolishParams,
  type PolishSnapshotBase,
  type PolishState,
  type PolishTarget,
} from "@/components/cv-builder/polish/polish-reducer";

const targets: PolishTarget[] = [
  { id: "i0", path: "sections.0.items.0", text: "orig zero" },
  { id: "i1", path: "sections.0.items.1", text: "orig one" },
];
const snapshot: PolishSnapshotBase = { documentId: "doc-1", targets };
const params: PolishParams = { level: 1 };

function confirm(clientRequestId: string): PolishAction {
  return { type: "CONFIRM", params, snapshot, clientRequestId };
}

function success(
  clientRequestId: string,
  items: ReadonlyArray<{ id: string; polished: string }> = [
    { id: "i0", polished: "polished zero" },
    { id: "i1", polished: "polished one" },
  ],
): PolishAction {
  return { type: "REQUEST_SUCCESS", clientRequestId, serverRequestId: "srv-1", items };
}

function failure(clientRequestId: string, code = "UPSTREAM_TIMEOUT"): PolishAction {
  return {
    type: "REQUEST_FAILURE",
    clientRequestId,
    serverRequestId: "srv-2",
    error: { code },
  };
}

function inConfig(): PolishState {
  return polishReducer(createInitialState(), { type: "CONFIGURE", params, snapshot });
}

function inLoading(clientRequestId = "rid-1"): PolishState {
  return polishReducer(inConfig(), confirm(clientRequestId));
}

function inPreview(clientRequestId = "rid-1"): PolishState {
  return polishReducer(inLoading(clientRequestId), success(clientRequestId));
}

describe("initial state / CONFIGURE", () => {
  it("starts in config with the default level 1", () => {
    const state = createInitialState();
    expect(state.phase).toBe("config");
    expect(state.params).toEqual({ level: 1 });
    expect(state.snapshot).toBeNull();
    expect(state.clientRequestId).toBeNull();
    expect(state.items).toEqual([]);
  });

  it("CONFIGURE refreshes params and snapshot and clears the stale flag", () => {
    const stale: PolishState = { ...createInitialState(), snapshotStale: true };
    const next = polishReducer(stale, {
      type: "CONFIGURE",
      params: { level: 2 },
      snapshot,
    });
    expect(next.params).toEqual({ level: 2 });
    expect(next.snapshot).toBe(snapshot);
    expect(next.snapshotStale).toBe(false);
  });

  it("CONFIGURE is a no-op outside config", () => {
    const loading = inLoading();
    expect(
      polishReducer(loading, { type: "CONFIGURE", params, snapshot }),
    ).toBe(loading);
  });
});

describe("CONFIRM purity", () => {
  it("is deterministic: same (state, action) -> equal result (Strict Mode safe)", () => {
    const state = inConfig();
    const action = confirm("rid-1");
    expect(polishReducer(state, action)).toEqual(polishReducer(state, action));
  });

  it("moves the caller-minted clientRequestId into state and enters loading", () => {
    const loading = polishReducer(inConfig(), confirm("rid-1"));
    expect(loading.phase).toBe("loading");
    expect(loading.clientRequestId).toBe("rid-1");
    expect(loading.error).toBeNull();
    expect(loading.items).toEqual([]);
  });

  it("is a no-op in loading and preview", () => {
    const loading = inLoading();
    expect(polishReducer(loading, confirm("rid-x"))).toBe(loading);
    const preview = inPreview();
    expect(polishReducer(preview, confirm("rid-x"))).toBe(preview);
  });

  it("retry after failure and rerun both require a freshly minted id", () => {
    const failed = polishReducer(inLoading("rid-1"), failure("rid-1"));
    expect(failed.phase).toBe("error");
    const retried = polishReducer(failed, confirm("rid-2"));
    expect(retried.phase).toBe("loading");
    expect(retried.clientRequestId).toBe("rid-2");
    expect(retried.clientRequestId).not.toBe("rid-1");
    expect(retried.error).toBeNull();

    const rerun = polishReducer(inPreview("rid-3"), { type: "RERUN" });
    const reconfirmed = polishReducer(rerun, confirm("rid-4"));
    expect(reconfirmed.clientRequestId).toBe("rid-4");
    expect(reconfirmed.clientRequestId).not.toBe("rid-3");
  });
});

describe("REQUEST_SUCCESS", () => {
  it("enters preview with one pending item per snapshot target", () => {
    const preview = inPreview();
    expect(preview.phase).toBe("preview");
    expect(preview.serverRequestId).toBe("srv-1");
    expect(preview.items).toEqual([
      {
        id: "i0",
        path: "sections.0.items.0",
        original: "orig zero",
        polished: "polished zero",
        state: "pending",
      },
      {
        id: "i1",
        path: "sections.0.items.1",
        original: "orig one",
        polished: "polished one",
        state: "pending",
      },
    ]);
  });

  it("ignores a response whose clientRequestId does not match the in-flight request", () => {
    const loading = inLoading("rid-1");
    expect(polishReducer(loading, success("wrong-rid"))).toBe(loading);
  });

  it("ignores success delivered outside loading (duplicate/late delivery)", () => {
    const preview = inPreview("rid-1");
    expect(polishReducer(preview, success("rid-1"))).toBe(preview);
    const config = inConfig();
    expect(polishReducer(config, success("rid-1"))).toBe(config);
  });
});

describe("REQUEST_FAILURE", () => {
  it("enters error and passes the server error through verbatim", () => {
    const loading = inLoading("rid-1");
    const failed = polishReducer(loading, {
      type: "REQUEST_FAILURE",
      clientRequestId: "rid-1",
      serverRequestId: "srv-9",
      error: { code: "QUOTA_EXCEEDED", resetAt: "2026-01-01T00:00:00Z" },
    });
    expect(failed.phase).toBe("error");
    expect(failed.error).toEqual({
      code: "QUOTA_EXCEEDED",
      resetAt: "2026-01-01T00:00:00Z",
    });
    expect(failed.serverRequestId).toBe("srv-9");
    expect(failed.clientRequestId).toBeNull();
  });

  it("ignores failures with a mismatched id or delivered outside loading", () => {
    const loading = inLoading("rid-1");
    expect(polishReducer(loading, failure("wrong-rid"))).toBe(loading);
    const preview = inPreview("rid-1");
    expect(polishReducer(preview, failure("rid-1"))).toBe(preview);
  });
});

describe("ABORT", () => {
  it("cancels the in-flight request back to config and clears the dedup key", () => {
    const aborted = polishReducer(inLoading("rid-1"), { type: "ABORT" });
    expect(aborted.phase).toBe("config");
    expect(aborted.clientRequestId).toBeNull();
    expect(aborted.error).toBeNull();
  });

  it("makes both a late success and a late failure no-ops", () => {
    const loading = inLoading("rid-1");
    const aborted = polishReducer(loading, { type: "ABORT" });
    expect(polishReducer(aborted, success("rid-1"))).toBe(aborted);
    expect(polishReducer(aborted, failure("rid-1"))).toBe(aborted);
  });

  it("is a no-op outside loading", () => {
    const preview = inPreview();
    expect(polishReducer(preview, { type: "ABORT" })).toBe(preview);
    const config = inConfig();
    expect(polishReducer(config, { type: "ABORT" })).toBe(config);
  });
});

describe("MARK_SNAPSHOT_STALE", () => {
  it("degrades a success arriving for a stale snapshot to a SNAPSHOT_STALE error", () => {
    const loading = polishReducer(inLoading("rid-1"), {
      type: "MARK_SNAPSHOT_STALE",
    });
    const next = polishReducer(loading, success("rid-1"));
    expect(next.phase).toBe("error");
    expect(next.error?.code).toBe(POLISH_CLIENT_ERROR_CODES.snapshotStale);
  });

  it("only flags in preview: item actions keep working", () => {
    const preview = polishReducer(inPreview(), { type: "MARK_SNAPSHOT_STALE" });
    expect(preview.snapshotStale).toBe(true);
    const accepted = polishReducer(preview, { type: "ACCEPT_ITEM", id: "i0" });
    expect(accepted.items[0].state).toBe("accepted");
  });

  it("is idempotent and is cleared by CONFIRM", () => {
    const loading = polishReducer(inLoading("rid-1"), {
      type: "MARK_SNAPSHOT_STALE",
    });
    expect(polishReducer(loading, { type: "MARK_SNAPSHOT_STALE" })).toBe(loading);
    const failed = polishReducer(loading, failure("rid-1"));
    const reconfirmed = polishReducer(failed, confirm("rid-2"));
    expect(reconfirmed.snapshotStale).toBe(false);
  });
});

describe("response validation (untrusted model output)", () => {
  it("rejects a missing item id as INVALID_RESPONSE", () => {
    const loading = inLoading("rid-1");
    const next = polishReducer(
      loading,
      success("rid-1", [{ id: "i0", polished: "x" }]),
    );
    expect(next.phase).toBe("error");
    expect(next.error?.code).toBe(POLISH_CLIENT_ERROR_CODES.invalidResponse);
  });

  it("rejects an extra item id as INVALID_RESPONSE", () => {
    const loading = inLoading("rid-1");
    const next = polishReducer(
      loading,
      success("rid-1", [
        { id: "i0", polished: "x" },
        { id: "i1", polished: "y" },
        { id: "i2", polished: "z" },
      ]),
    );
    expect(next.error?.code).toBe(POLISH_CLIENT_ERROR_CODES.invalidResponse);
  });

  it("rejects an empty polished string", () => {
    const loading = inLoading("rid-1");
    const next = polishReducer(
      loading,
      success("rid-1", [
        { id: "i0", polished: "x" },
        { id: "i1", polished: "" },
      ]),
    );
    expect(next.error?.code).toBe(POLISH_CLIENT_ERROR_CODES.invalidResponse);
  });

  it("rejects whitespace-only polished output", () => {
    for (const blank of ["   ", "\n\t", " \u3000 "]) {
      const loading = inLoading("rid-1");
      const next = polishReducer(
        loading,
        success("rid-1", [
          { id: "i0", polished: "x" },
          { id: "i1", polished: blank },
        ]),
      );
      expect(next.phase).toBe("error");
      expect(next.error?.code).toBe(POLISH_CLIENT_ERROR_CODES.invalidResponse);
    }
  });

  it("accepts padded but real content and stores it untrimmed", () => {
    const loading = inLoading("rid-1");
    const preview = polishReducer(
      loading,
      success("rid-1", [
        { id: "i0", polished: "  polished zero  " },
        { id: "i1", polished: "polished one" },
      ]),
    );
    expect(preview.phase).toBe("preview");
    expect(preview.items[0].polished).toBe("  polished zero  ");
  });
});

describe("item transitions", () => {
  it("accept / undo-accept round-trips through pending", () => {
    const preview = inPreview();
    const accepted = polishReducer(preview, { type: "ACCEPT_ITEM", id: "i0" });
    expect(accepted.items[0].state).toBe("accepted");
    const undone = polishReducer(accepted, { type: "UNDO_ACCEPT_ITEM", id: "i0" });
    expect(undone.items[0].state).toBe("pending");
  });

  it("reject / undo-reject round-trips through pending", () => {
    const preview = inPreview();
    const rejected = polishReducer(preview, { type: "REJECT_ITEM", id: "i1" });
    expect(rejected.items[1].state).toBe("rejected");
    const undone = polishReducer(rejected, { type: "UNDO_REJECT_ITEM", id: "i1" });
    expect(undone.items[1].state).toBe("pending");
  });

  it("switches directly between accepted and rejected", () => {
    const rejected = polishReducer(inPreview(), { type: "REJECT_ITEM", id: "i0" });
    const accepted = polishReducer(rejected, { type: "ACCEPT_ITEM", id: "i0" });
    expect(accepted.items[0].state).toBe("accepted");
    const rejectedAgain = polishReducer(accepted, { type: "REJECT_ITEM", id: "i0" });
    expect(rejectedAgain.items[0].state).toBe("rejected");
  });

  it("keeps state identity on every no-op", () => {
    const preview = inPreview();
    // undo guards only fire from the matching state
    expect(polishReducer(preview, { type: "UNDO_ACCEPT_ITEM", id: "i0" })).toBe(preview);
    expect(polishReducer(preview, { type: "UNDO_REJECT_ITEM", id: "i0" })).toBe(preview);
    // unknown id
    expect(polishReducer(preview, { type: "ACCEPT_ITEM", id: "nope" })).toBe(preview);
    // item actions outside preview
    const loading = inLoading();
    expect(polishReducer(loading, { type: "ACCEPT_ITEM", id: "i0" })).toBe(loading);
    expect(polishReducer(loading, { type: "REJECT_ALL" })).toBe(loading);
    // accepting an already accepted item
    const accepted = polishReducer(preview, { type: "ACCEPT_ITEM", id: "i0" });
    expect(polishReducer(accepted, { type: "ACCEPT_ITEM", id: "i0" })).toBe(accepted);
  });
});

describe("bulk accept / reject", () => {
  it("ACCEPT_ALL and REJECT_ALL flip every item and are idempotent", () => {
    const preview = inPreview();
    const allAccepted = polishReducer(preview, { type: "ACCEPT_ALL" });
    expect(countItems(allAccepted.items)).toEqual({ pending: 0, accepted: 2, rejected: 0 });
    expect(polishReducer(allAccepted, { type: "ACCEPT_ALL" })).toBe(allAccepted);

    const allRejected = polishReducer(allAccepted, { type: "REJECT_ALL" });
    expect(countItems(allRejected.items)).toEqual({ pending: 0, accepted: 0, rejected: 2 });
    expect(polishReducer(allRejected, { type: "REJECT_ALL" })).toBe(allRejected);
  });
});

describe("RERUN", () => {
  it("returns to config, drops results, keeps params/snapshot; accepted write-back survives", () => {
    const accepted = polishReducer(inPreview("rid-1"), { type: "ACCEPT_ITEM", id: "i0" });
    const rerun = polishReducer(accepted, { type: "RERUN" });
    expect(rerun.phase).toBe("config");
    expect(rerun.items).toEqual([]);
    expect(rerun.clientRequestId).toBeNull();
    expect(rerun.error).toBeNull();
    expect(rerun.params).toEqual(params);
    expect(rerun.snapshot).toBe(snapshot);

    // The form now holds the accepted value; the next CONFIRM carries a
    // snapshot rebuilt from it, so the accepted text becomes the new baseline.
    const rebuilt: PolishSnapshotBase = {
      documentId: "doc-1",
      targets: [
        { id: "i0", path: "sections.0.items.0", text: "polished zero" },
        { id: "i1", path: "sections.0.items.1", text: "orig one" },
      ],
    };
    const loading = polishReducer(rerun, {
      type: "CONFIRM",
      params,
      snapshot: rebuilt,
      clientRequestId: "rid-2",
    });
    const preview = polishReducer(loading, success("rid-2"));
    expect(preview.items[0].original).toBe("polished zero");
  });

  it("also works from error and is a no-op in loading", () => {
    const failed = polishReducer(inLoading("rid-1"), failure("rid-1"));
    expect(polishReducer(failed, { type: "RERUN" }).phase).toBe("config");
    const loading = inLoading();
    expect(polishReducer(loading, { type: "RERUN" })).toBe(loading);
  });
});

describe("RESET", () => {
  it("returns to a fresh config state and keeps the params", () => {
    const preview = inPreview();
    const reset = polishReducer(preview, { type: "RESET" });
    expect(reset).toEqual(createInitialState(preview.params));
    expect(reset.params).toEqual(params);
    expect(reset.snapshot).toBeNull();
  });
});

describe("expectedCurrent", () => {
  it("is polished for accepted items and original otherwise", () => {
    const preview = inPreview();
    const accepted = polishReducer(preview, { type: "ACCEPT_ITEM", id: "i0" });
    const rejected = polishReducer(accepted, { type: "REJECT_ITEM", id: "i1" });
    expect(expectedCurrent(rejected.items[0])).toBe("polished zero");
    expect(expectedCurrent(rejected.items[1])).toBe("orig one");

    const undone = polishReducer(rejected, { type: "UNDO_ACCEPT_ITEM", id: "i0" });
    expect(expectedCurrent(undone.items[0])).toBe("orig zero");
  });
});
