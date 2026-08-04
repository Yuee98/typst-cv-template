import { describe, expect, it } from "vitest";

import {
  baselineOnFormLoad,
  baselineOnPersisted,
  cloudDraftTick,
  createCvBaseline,
  isDraftRedundant,
  matchesCvBaseline,
  sameCvData,
  stableSerializeCvData,
} from "@/lib/cv/baseline";
import { DEFAULT_SECTION_ORDER, type CvData } from "@/lib/cv/schema";

function makeSectionTitles(): CvData["sectionTitles"] {
  return Object.fromEntries(
    DEFAULT_SECTION_ORDER.map((id) => [id, { title: id, isDisplay: true, pageBreakBefore: false }]),
  ) as CvData["sectionTitles"];
}

function makeCvData(body = "hello"): CvData {
  return {
    schemaVersion: 7,
    typstLang: "zh",
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    header: { name: "Jane Doe", subtitle: "", email: "", phone: "", selfName: "" },
    sectionTitles: makeSectionTitles(),
    profile: [{ body }],
    skills: [],
    experience: [],
    education: [],
    research: [],
    publications: [],
    additional: [],
  };
}

function withBody(data: CvData, body: string): CvData {
  return { ...data, profile: [{ body }] };
}

/** Deep clone with every object's key order reversed. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, nested]) => [key, reverseKeys(nested)]),
    );
  }
  return value;
}

describe("stableSerializeCvData", () => {
  it("is invariant under recursive object key reordering", () => {
    const data = makeCvData();
    const shuffled = reverseKeys(data) as CvData;

    expect(stableSerializeCvData(shuffled)).toBe(stableSerializeCvData(data));
    expect(sameCvData(shuffled, data)).toBe(true);
  });

  it("is sensitive to array order (bullet order is meaningful)", () => {
    const data = makeCvData();
    const forward: CvData = { ...data, profile: [{ body: "a" }, { body: "b" }] };
    const backward: CvData = { ...data, profile: [{ body: "b" }, { body: "a" }] };

    expect(stableSerializeCvData(forward)).not.toBe(stableSerializeCvData(backward));
    expect(sameCvData(forward, backward)).toBe(false);
  });

  it("is sensitive to nested value changes and deterministic per input", () => {
    const data = makeCvData();
    const renamed = { ...data, header: { ...data.header, name: "John Doe" } };

    expect(sameCvData(renamed, data)).toBe(false);
    expect(stableSerializeCvData(data)).toBe(stableSerializeCvData(makeCvData()));
  });
});

describe("matchesCvBaseline", () => {
  it("matches only for the same documentId and equal data", () => {
    const data = makeCvData();
    const baseline = createCvBaseline("doc-1", data);

    expect(matchesCvBaseline(baseline, "doc-1", reverseKeys(data) as CvData)).toBe(true);
    expect(matchesCvBaseline(baseline, "doc-2", data)).toBe(false);
    expect(matchesCvBaseline(null, "doc-1", data)).toBe(false);
    expect(matchesCvBaseline(baseline, null, data)).toBe(false);
    expect(matchesCvBaseline(baseline, "doc-1", withBody(data, "changed"))).toBe(false);
  });
});

describe("baselineOnFormLoad", () => {
  it("cloud load without draft: baseline = server data, dirty = false", () => {
    const server = makeCvData();
    const { baseline, dirty } = baselineOnFormLoad("doc-1", server, server);

    expect(dirty).toBe(false);
    expect(baseline.documentId).toBe("doc-1");
    expect(matchesCvBaseline(baseline, "doc-1", server)).toBe(true);
  });

  it("cloud draft recovery with draft != server: form gets the draft, baseline stays server data, dirty = true", () => {
    const server = makeCvData();
    const draft = withBody(server, "unsaved draft edit");
    const { baseline, dirty } = baselineOnFormLoad("doc-1", draft, server);

    expect(dirty).toBe(true);
    // The draft must never become the baseline.
    expect(matchesCvBaseline(baseline, "doc-1", server)).toBe(true);
    expect(matchesCvBaseline(baseline, "doc-1", draft)).toBe(false);
  });

  it("cloud draft recovery with draft == server: dirty = false", () => {
    const server = makeCvData();
    const draft = reverseKeys(server) as CvData;
    const { dirty } = baselineOnFormLoad("doc-1", draft, server);

    expect(dirty).toBe(false);
  });

  it("encrypted unlock: baseline = decrypted persisted data, dirty = false", () => {
    const decrypted = makeCvData();
    const { baseline, dirty } = baselineOnFormLoad("doc-enc", decrypted);

    expect(dirty).toBe(false);
    expect(matchesCvBaseline(baseline, "doc-enc", reverseKeys(decrypted) as CvData)).toBe(true);
  });

  it("discard: form and baseline both return to the persisted data, dirty = false", () => {
    const persisted = makeCvData();
    const edited = withBody(persisted, "edits to discard");

    const before = baselineOnFormLoad("doc-1", persisted);
    expect(matchesCvBaseline(before.baseline, "doc-1", edited)).toBe(false);

    const after = baselineOnFormLoad("doc-1", persisted);
    expect(after.dirty).toBe(false);
    expect(matchesCvBaseline(after.baseline, "doc-1", persisted)).toBe(true);
  });
});

describe("baselineOnPersisted", () => {
  it("local save success: baseline advances to the saved data, dirty = false", () => {
    const s0 = makeCvData();
    const s1 = withBody(s0, "saved edit");
    const result = baselineOnPersisted({
      baseline: createCvBaseline("doc-1", s0),
      activeDocumentId: "doc-1",
      savedDocumentId: "doc-1",
      savedData: s1,
      currentData: s1,
    });

    expect(result).not.toBeNull();
    expect(result?.dirty).toBe(false);
    expect(matchesCvBaseline(result?.baseline, "doc-1", s1)).toBe(true);
    expect(matchesCvBaseline(result?.baseline, "doc-1", s0)).toBe(false);
  });

  it("local save failure: baseline stays at S0 and the form keeps reading dirty", () => {
    const s0 = makeCvData();
    const s1 = withBody(s0, "unsaved edit");
    const baseline = createCvBaseline("doc-1", s0);

    // Failure path: baselineOnPersisted is never called; the next debounced
    // tick derives dirty from the untouched baseline.
    expect(matchesCvBaseline(baseline, "doc-1", s1)).toBe(false);

    // A later successful save of S1 recovers to clean.
    const result = baselineOnPersisted({
      baseline,
      activeDocumentId: "doc-1",
      savedDocumentId: "doc-1",
      savedData: s1,
      currentData: s1,
    });
    expect(result?.dirty).toBe(false);
  });

  it("save in flight while the form keeps editing: dirty is re-derived from the live form data", () => {
    const s0 = makeCvData();
    const s1 = withBody(s0, "snapshot sent to the server");
    const s2 = withBody(s0, "further typing during the save");

    const result = baselineOnPersisted({
      baseline: createCvBaseline("doc-1", s0),
      activeDocumentId: "doc-1",
      savedDocumentId: "doc-1",
      savedData: s1,
      currentData: s2,
    });

    expect(result).not.toBeNull();
    expect(matchesCvBaseline(result?.baseline, "doc-1", s1)).toBe(true);
    expect(result?.dirty).toBe(true);
  });

  it("unparseable current form data is treated as dirty", () => {
    const s0 = makeCvData();
    const result = baselineOnPersisted({
      baseline: createCvBaseline("doc-1", s0),
      activeDocumentId: "doc-1",
      savedDocumentId: "doc-1",
      savedData: s0,
      currentData: null,
    });

    expect(result?.dirty).toBe(true);
  });

  it("save of document A completing after document B was activated is refused", () => {
    const a = makeCvData("a");
    const b = makeCvData("b");
    const baselineB = createCvBaseline("doc-b", b);

    const result = baselineOnPersisted({
      baseline: baselineB,
      activeDocumentId: "doc-b",
      savedDocumentId: "doc-a",
      savedData: a,
      currentData: b,
    });

    // Refused: the caller leaves B's baseline and dirty flag untouched.
    expect(result).toBeNull();
    expect(matchesCvBaseline(baselineB, "doc-b", b)).toBe(true);
  });

  it("is also refused when the baseline has already moved to another document", () => {
    const a = makeCvData("a");
    const c = makeCvData("c");

    const result = baselineOnPersisted({
      baseline: createCvBaseline("doc-c", c),
      activeDocumentId: "doc-a",
      savedDocumentId: "doc-a",
      savedData: a,
      currentData: a,
    });

    expect(result).toBeNull();
  });

  it("allows rebasing when no baseline exists yet for the active document", () => {
    const a = makeCvData("a");
    const result = baselineOnPersisted({
      baseline: null,
      activeDocumentId: "doc-a",
      savedDocumentId: "doc-a",
      savedData: a,
      currentData: a,
    });

    expect(result?.dirty).toBe(false);
    expect(matchesCvBaseline(result?.baseline, "doc-a", a)).toBe(true);
  });
});

describe("cloudDraftTick", () => {
  it("edit then revert: dirty keeps the draft, back-at-baseline clears it and reads clean", () => {
    const s0 = makeCvData();
    const s1 = withBody(s0, "cloud edit");
    const baseline = createCvBaseline("doc-1", s0);

    expect(cloudDraftTick(baseline, "doc-1", s1)).toEqual({ dirty: true, action: "save-draft" });
    expect(cloudDraftTick(baseline, "doc-1", reverseKeys(s0) as CvData)).toEqual({
      dirty: false,
      action: "clear-draft",
    });
  });
});

describe("isDraftRedundant", () => {
  it("recovery: a draft identical to the server data is cleared, a differing draft is kept", () => {
    const server = makeCvData();
    const identicalDraft = reverseKeys(server) as CvData;
    const differingDraft = withBody(server, "real unsaved work");

    expect(isDraftRedundant(identicalDraft, server)).toBe(true);
    expect(isDraftRedundant(differingDraft, server)).toBe(false);
    expect(isDraftRedundant(null, server)).toBe(false);

    // The full recovery decision: redundant draft → cleared, form loads clean;
    // differing draft → kept, form loads dirty against the server baseline.
    const recoveredClean = baselineOnFormLoad("doc-1", identicalDraft, server);
    expect(recoveredClean.dirty).toBe(false);
    const recoveredDirty = baselineOnFormLoad("doc-1", differingDraft, server);
    expect(recoveredDirty.dirty).toBe(true);
  });
});
