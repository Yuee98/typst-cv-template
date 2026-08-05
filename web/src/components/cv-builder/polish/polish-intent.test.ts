import { describe, expect, it } from "vitest";

import {
  PENDING_POLISH_INTENT_KEY,
  PENDING_POLISH_INTENT_TTL_MS,
  clearPendingPolishIntent,
  savePendingPolishIntent,
  takePendingPolishIntent,
  type PendingPolishIntent,
  type StorageLike,
} from "./polish-intent";
import type { PolishScope } from "./scope-builder";

function createFakeStorage(): StorageLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

const SCOPE: PolishScope = {
  sectionId: "experience",
  granularity: "item",
  itemId: "1.2.0",
};

function intent(overrides: Partial<PendingPolishIntent> = {}): PendingPolishIntent {
  return { documentId: "doc-1", scope: SCOPE, createdAt: 1_000_000, ...overrides };
}

describe("savePendingPolishIntent / takePendingPolishIntent", () => {
  it("round-trips a stashed scope for the same document", () => {
    const storage = createFakeStorage();
    savePendingPolishIntent(intent(), storage);
    expect(takePendingPolishIntent("doc-1", { now: 1_000_001, storage })).toEqual(SCOPE);
  });

  it("is single-use: the stored value is cleared on read", () => {
    const storage = createFakeStorage();
    savePendingPolishIntent(intent(), storage);
    takePendingPolishIntent("doc-1", { now: 1_000_001, storage });
    expect(storage.entries.has(PENDING_POLISH_INTENT_KEY)).toBe(false);
    expect(takePendingPolishIntent("doc-1", { now: 1_000_002, storage })).toBeNull();
  });

  it("preserves entryId/itemId exactly", () => {
    const storage = createFakeStorage();
    const scope: PolishScope = {
      sectionId: "education",
      granularity: "item",
      entryId: "3",
      itemId: "3.1",
    };
    savePendingPolishIntent(intent({ scope }), storage);
    expect(takePendingPolishIntent("doc-1", { now: 1_000_001, storage })).toEqual(scope);
  });

  it("preserves groupId exactly", () => {
    const storage = createFakeStorage();
    const scope: PolishScope = {
      sectionId: "experience",
      granularity: "group",
      groupId: "3",
    };
    savePendingPolishIntent(intent({ scope }), storage);
    expect(takePendingPolishIntent("doc-1", { now: 1_000_001, storage })).toEqual(scope);
  });

  it("discards an intent stashed for a different document", () => {
    const storage = createFakeStorage();
    savePendingPolishIntent(intent({ documentId: "doc-1" }), storage);
    expect(takePendingPolishIntent("doc-2", { now: 1_000_001, storage })).toBeNull();
    expect(storage.entries.has(PENDING_POLISH_INTENT_KEY)).toBe(false);
  });

  it("discards an intent older than the TTL", () => {
    const storage = createFakeStorage();
    savePendingPolishIntent(intent(), storage);
    const expiredAt = 1_000_000 + PENDING_POLISH_INTENT_TTL_MS + 1;
    expect(takePendingPolishIntent("doc-1", { now: expiredAt, storage })).toBeNull();
  });

  it("accepts an intent just inside the TTL", () => {
    const storage = createFakeStorage();
    savePendingPolishIntent(intent(), storage);
    const freshAt = 1_000_000 + PENDING_POLISH_INTENT_TTL_MS - 1;
    expect(takePendingPolishIntent("doc-1", { now: freshAt, storage })).toEqual(SCOPE);
  });

  it("discards an intent with createdAt far in the future (clock skew)", () => {
    const storage = createFakeStorage();
    savePendingPolishIntent(intent(), storage);
    expect(takePendingPolishIntent("doc-1", { now: 1_000_000 - 120_000, storage })).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const storage = createFakeStorage();
    storage.setItem(PENDING_POLISH_INTENT_KEY, "{not json");
    expect(takePendingPolishIntent("doc-1", { now: 1_000_001, storage })).toBeNull();
  });

  it.each([
    ["unknown section", { sectionId: "header", granularity: "item", itemId: "0" }],
    ["unknown granularity", { sectionId: "profile", granularity: "document" }],
    ["malformed itemId", { sectionId: "profile", granularity: "item", itemId: "a.b" }],
    ["non-string entryId", { sectionId: "profile", granularity: "entry", entryId: 3 }],
    ["malformed groupId", { sectionId: "experience", granularity: "group", groupId: "company" }],
  ])("returns null for an off-shape scope (%s)", (_label, scope) => {
    const storage = createFakeStorage();
    storage.setItem(
      PENDING_POLISH_INTENT_KEY,
      JSON.stringify({ documentId: "doc-1", scope, createdAt: 1_000_000 }),
    );
    expect(takePendingPolishIntent("doc-1", { now: 1_000_001, storage })).toBeNull();
  });

  it("returns null when nothing was stashed", () => {
    expect(takePendingPolishIntent("doc-1", { storage: createFakeStorage() })).toBeNull();
  });

  it("no-ops without storage (SSR / blocked storage)", () => {
    savePendingPolishIntent(intent(), null);
    clearPendingPolishIntent(null);
    expect(takePendingPolishIntent("doc-1", { storage: null })).toBeNull();
  });
});

describe("clearPendingPolishIntent", () => {
  it("removes the stashed value", () => {
    const storage = createFakeStorage();
    savePendingPolishIntent(intent(), storage);
    clearPendingPolishIntent(storage);
    expect(storage.entries.has(PENDING_POLISH_INTENT_KEY)).toBe(false);
  });
});
