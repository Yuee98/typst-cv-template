// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { createLocalCvDocument, duplicateCvDocument, initializeCvDocumentLibrary, loadCvDocument, removeCvDocument, renameCvDocument, sortCvDocumentSummariesByStoredOrder, storeCvDocumentOrder, updateLocalCvDocumentData } from "@/lib/cv/storage";
import { clearCvDraft, loadCvDraft, saveCvDraft } from "@/lib/cv/draft-storage";
const LEGACY_KEY = "typst-cv-builder:data";
const INDEX_KEY = "typst-cv-builder:documents:index";
const ORDER_KEY = "typst-cv-builder:documents:order";
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe("CV document library persistence", () => {
  it("ignores the historical single-document key, including current-format content", () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify({
      ...sampleCvDataEn,
      header: {
        ...sampleCvDataEn.header,
        name: "Do not restore"
      }
    }));
    const library = initializeCvDocumentLibrary(sampleCvDataEn, "Fallback CV");
    const document = library.activeDocumentId ? loadCvDocument(library.activeDocumentId) : null;
    expect(library.documents).toHaveLength(1);
    expect(library.activeDocumentId).toBe(library.documents[0]?.id);
    expect(library.documents[0]?.title).toBe(sampleCvDataEn.header.name);
    expect(document?.data).toEqual(sampleCvDataEn);
    expect(window.localStorage.getItem(INDEX_KEY)).not.toBeNull();
  });
  it("uses supplied current default data for a new library", () => {
    const data = cloneCvData(sampleCvDataEn);
    data.header.name = "";
    const library = initializeCvDocumentLibrary(data, "Fallback CV");
    const document = library.activeDocumentId ? loadCvDocument(library.activeDocumentId) : null;
    expect(library.documents[0]?.title).toBe("Fallback CV");
    expect(document?.data).toEqual(data);
  });
  it("rejects an unsupported index without overwriting it", () => {
    window.localStorage.setItem(INDEX_KEY, "not-json");
    expect(() => initializeCvDocumentLibrary(sampleCvDataEn)).toThrow("Unsupported");
    expect(window.localStorage.getItem(INDEX_KEY)).toBe("not-json");
  });
  it("rejects invalid documents while ignoring corrupt optional sort preferences", () => {
    const document = createLocalCvDocument(sampleCvDataEn, "Local");
    window.localStorage.setItem(`typst-cv-builder:documents:${document.id}`, "{");
    window.localStorage.setItem(ORDER_KEY, "[");
    expect(() => loadCvDocument(document.id)).toThrow("Unsupported");
    expect(window.localStorage.getItem(`typst-cv-builder:documents:${document.id}`)).toBe("{");
    expect(() => sortCvDocumentSummariesByStoredOrder([])).not.toThrow();
  });
  it("preserves explicit order and handles missing or stale order entries deterministically", () => {
    const first = createLocalCvDocument(sampleCvDataEn, "First");
    const second = createLocalCvDocument(sampleCvDataEn, "Second");
    const summaries = [{
      id: first.id,
      title: first.title,
      storageKind: first.storageKind,
      createdAt: first.createdAt,
      updatedAt: first.updatedAt
    }, {
      id: second.id,
      title: second.title,
      storageKind: second.storageKind,
      createdAt: second.createdAt,
      updatedAt: second.updatedAt
    }];
    storeCvDocumentOrder(summaries);
    expect(sortCvDocumentSummariesByStoredOrder([summaries[1]!, summaries[0]!])).toEqual(summaries);
    window.localStorage.setItem(ORDER_KEY, JSON.stringify([`local:${second.id}`, "local:stale"]));
    const input = [summaries[0]!, summaries[1]!];
    const firstResult = sortCvDocumentSummariesByStoredOrder(input);
    const secondResult = sortCvDocumentSummariesByStoredOrder(input);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual(input);
  });
  it("renames, duplicates, updates, and removes local documents consistently", () => {
    const original = createLocalCvDocument(sampleCvDataEn, "Original");
    const renamed = renameCvDocument(original.id, "  Renamed  ");
    expect(renamed.find(document => document.id === original.id)?.title).toBe("Renamed");
    expect(loadCvDocument(original.id)?.title).toBe("Renamed");
    const duplicate = duplicateCvDocument(original.id);
    expect(duplicate).not.toBeNull();
    expect(duplicate?.title).toBe("Renamed Copy");
    expect(duplicate?.data).toEqual(sampleCvDataEn);
    expect(window.localStorage.getItem("typst-cv-builder:documents:active")).toBe(duplicate?.id);
    const updatedData = cloneCvData(sampleCvDataEn);
    updatedData.header.subtitle = "Updated subtitle";
    const updated = updateLocalCvDocumentData(original.id, updatedData);
    expect(updated?.data).toEqual(updatedData);
    expect(loadCvDocument(original.id)?.data).toEqual(updatedData);
    const afterRemove = removeCvDocument(duplicate!.id);
    expect(afterRemove.documents.some(document => document.id === duplicate!.id)).toBe(false);
    expect(afterRemove.activeDocumentId).toBe(original.id);
    expect(loadCvDocument(duplicate!.id)).toBeNull();
  });
});
describe("CV drafts", () => {
  it("saves, loads, and clears a draft", () => {
    const draft = cloneCvData(sampleCvDataEn);
    draft.header.subtitle = "Unsaved draft";
    saveCvDraft("user-1", "cv-1", draft, "1");
    expect(loadCvDraft("user-1", "cv-1")).toEqual({
      contract: "cv_draft_1",
      baseRevision: "1",
      data: draft
    });
    clearCvDraft("user-1", "cv-1");
    expect(loadCvDraft("user-1", "cv-1")).toBeNull();
  });
  it("rejects corrupt drafts and treats unavailable or quota-failing storage as best effort", () => {
    window.localStorage.setItem("typst-cv-builder:draft:uninitialized:user-1:cv-1", "not-json");
    expect(loadCvDraft("user-1", "cv-1")).toBeNull();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    expect(() => saveCvDraft("user-1", "cv-1", sampleCvDataEn, "1")).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    expect(loadCvDraft("user-1", "cv-1")).toBeNull();
    expect(getItem).toHaveBeenCalled();
  });
  it("does nothing for an absent user identity", () => {
    expect(() => saveCvDraft(null, "cv-1", sampleCvDataEn, "1")).not.toThrow();
    expect(loadCvDraft(null, "cv-1")).toBeNull();
    expect(() => clearCvDraft(undefined, "cv-1")).not.toThrow();
  });
});
