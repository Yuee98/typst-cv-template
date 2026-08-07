// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useCvDocuments } from "@/components/cv-builder/hooks/use-cv-documents";
import type { CvDocumentSummary } from "@/lib/cv/storage";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.localStorage.clear();
});

function summary(id: string, storageKind: CvDocumentSummary["storageKind"]): CvDocumentSummary {
  return {
    id,
    title: `${id} title`,
    storageKind,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

describe("useCvDocuments account boundary", () => {
  it("atomically removes an active cloud identity before another account loads", () => {
    const activeDocumentIdRef = { current: null as string | null };
    const initializedRef = { current: false };
    const hook = renderHook(() => useCvDocuments({ activeDocumentIdRef, initializedRef }));
    const accountACloud = summary("account-a-cloud", "cloud");
    const local = summary("local-1", "local");

    act(() => {
      hook.result.current.setOrderedDocuments([accountACloud, local]);
      hook.result.current.setActiveDocumentId(accountACloud.id);
    });
    expect(hook.result.current.activeDocument).toEqual(accountACloud);

    let removedActive = false;
    act(() => {
      removedActive = hook.result.current.removeCloudSummaries();
    });

    expect(removedActive).toBe(true);
    expect(hook.result.current.documents).toEqual([local]);
    expect(hook.result.current.activeDocumentId).toBeNull();
    expect(hook.result.current.activeDocument).toBeNull();
    expect(activeDocumentIdRef.current).toBeNull();

    const accountBCloud = summary("account-b-cloud", "cloud");
    act(() => {
      hook.result.current.replaceCloudSummaries([accountBCloud]);
    });
    expect(hook.result.current.documents).toEqual([accountBCloud, local]);
    expect(hook.result.current.activeDocumentId).toBeNull();
  });
});
