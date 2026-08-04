import { describe, expect, it } from "vitest";

import type { PolishItem, PolishItemStatus } from "./polish-reducer";
import {
  captureSnapshotPathValues,
  checkWriteBack,
  isSnapshotStale,
  planWriteBack,
} from "./stale-guard";

const snapshotPaths = {
  targets: [
    { path: "profile.0.body" },
    { path: "profile.1.body" },
  ],
  referencePaths: ["skills.0.label", "skills.1.body"],
};

function getValueFrom(record: Record<string, unknown>) {
  return (path: string) => record[path];
}

describe("captureSnapshotPathValues / isSnapshotStale", () => {
  const formValues = {
    "profile.0.body": "original zero",
    "profile.1.body": "original one",
    "skills.0.label": "Languages",
    "skills.1.body": "TypeScript, Go",
  };

  it("captures every target and reference path", () => {
    const captured = captureSnapshotPathValues(snapshotPaths, getValueFrom(formValues));
    expect(captured).toEqual(formValues);
  });

  it("is not stale while all captured values hold", () => {
    const captured = captureSnapshotPathValues(snapshotPaths, getValueFrom(formValues));
    expect(isSnapshotStale(captured, getValueFrom({ ...formValues }))).toBe(false);
  });

  it("detects drift on a target path (external edit / cloud sync)", () => {
    const captured = captureSnapshotPathValues(snapshotPaths, getValueFrom(formValues));
    const drifted = { ...formValues, "profile.1.body": "edited elsewhere" };
    expect(isSnapshotStale(captured, getValueFrom(drifted))).toBe(true);
  });

  it("detects drift on a reference path (context changed)", () => {
    const captured = captureSnapshotPathValues(snapshotPaths, getValueFrom(formValues));
    const drifted = { ...formValues, "skills.0.label": "Programming languages" };
    expect(isSnapshotStale(captured, getValueFrom(drifted))).toBe(true);
  });

  it("treats a removed field (undefined) as drift", () => {
    const captured = captureSnapshotPathValues(snapshotPaths, getValueFrom(formValues));
    const drifted = { ...formValues };
    delete (drifted as Record<string, unknown>)["profile.0.body"];
    expect(isSnapshotStale(captured, getValueFrom(drifted))).toBe(true);
  });

  it("onlyPaths narrows the check (in-preview reference hint ignores accepted targets)", () => {
    const captured = captureSnapshotPathValues(snapshotPaths, getValueFrom(formValues));
    // An accepted target legitimately changed its own value…
    const afterAccept = { ...formValues, "profile.0.body": "polished zero" };
    expect(isSnapshotStale(captured, getValueFrom(afterAccept))).toBe(true);
    // …but the reference-only check stays clean until a reference drifts.
    expect(
      isSnapshotStale(captured, getValueFrom(afterAccept), snapshotPaths.referencePaths),
    ).toBe(false);
    const referenceDrifted = { ...afterAccept, "skills.1.body": "Rust" };
    expect(
      isSnapshotStale(captured, getValueFrom(referenceDrifted), snapshotPaths.referencePaths),
    ).toBe(true);
    // Paths not in the capture are ignored.
    expect(isSnapshotStale(captured, getValueFrom(afterAccept), ["header.name"])).toBe(false);
  });
});

describe("planWriteBack", () => {
  const base = { original: "orig", polished: "pol" };
  const item = (state: PolishItem["state"]): PolishItem => ({
    id: "i0",
    path: "profile.0.body",
    state,
    ...base,
  });

  it("pending → accepted expects the original and writes the polished text", () => {
    expect(planWriteBack(item("pending"), "accepted")).toEqual({
      expectedBefore: "orig",
      value: "pol",
      write: true,
    });
  });

  it("accepted → pending (undo) expects the polished text and reverts to original", () => {
    expect(planWriteBack(item("accepted"), "pending")).toEqual({
      expectedBefore: "pol",
      value: "orig",
      write: true,
    });
  });

  it("accepted → rejected expects the polished text and reverts to original", () => {
    expect(planWriteBack(item("accepted"), "rejected")).toEqual({
      expectedBefore: "pol",
      value: "orig",
      write: true,
    });
  });

  it("rejected → accepted expects the original and writes the polished text", () => {
    expect(planWriteBack(item("rejected"), "accepted")).toEqual({
      expectedBefore: "orig",
      value: "pol",
      write: true,
    });
  });

  it.each([
    ["pending", "rejected"],
    ["rejected", "pending"],
    ["pending", "pending"],
    ["accepted", "accepted"],
    ["rejected", "rejected"],
  ] as Array<[PolishItemStatus, PolishItemStatus]>)(
    "%s → %s never writes the form",
    (state, next) => {
      const plan = planWriteBack(item(state), next);
      expect(plan.write).toBe(false);
      expect(plan.value).toBe(plan.expectedBefore);
    },
  );
});

describe("checkWriteBack", () => {
  const plan = { expectedBefore: "orig", value: "pol", write: true };

  it("passes when the live value matches the expected one", () => {
    expect(checkWriteBack(plan, "orig")).toEqual({ ok: true });
  });

  it("blocks as stale when the field drifted", () => {
    expect(checkWriteBack(plan, "edited")).toEqual({ ok: false, reason: "stale" });
    expect(checkWriteBack(plan, undefined)).toEqual({ ok: false, reason: "stale" });
  });
});
