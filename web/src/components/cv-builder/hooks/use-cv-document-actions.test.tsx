// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForm } from "react-hook-form";

import { useCvDocumentActions } from "@/components/cv-builder/hooks/use-cv-document-actions";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";
import { MissingPassphraseError } from "@/lib/cv/storage-adapters";

import messages from "../../../../messages/en.json";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.localStorage.clear();
});

function summary(id: string, storageKind: CvDocumentSummary["storageKind"] = "local"): CvDocumentSummary {
  return {
    id,
    title: id,
    storageKind,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderActions({
  activeDocument = summary("active"),
  documents = [activeDocument, summary("target")],
}: {
  activeDocument?: CvDocumentSummary;
  documents?: CvDocumentSummary[];
} = {}) {
  const adapters = {
    local: {
      delete: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({ data: sampleCvDataEn, summary: activeDocument }),
      rename: vi.fn().mockResolvedValue(activeDocument),
      save: vi.fn().mockResolvedValue(activeDocument),
    },
    cloud: {
      delete: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({ data: sampleCvDataEn, summary: documents[1] }),
      rename: vi.fn().mockResolvedValue(documents[1]),
      save: vi.fn().mockResolvedValue(documents[1]),
    },
    encrypted: {
      delete: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({ data: sampleCvDataEn, summary: documents[1] }),
      rename: vi.fn().mockResolvedValue(documents[1]),
      save: vi.fn().mockResolvedValue(documents[1]),
    },
  };
  const saveCurrentDocument = vi.fn().mockResolvedValue(true);
  const handleStorageDeferredError = vi.fn().mockReturnValue(false);
  const loadDataIntoForm = vi.fn();
  const loadDraft = vi.fn().mockReturnValue(null);
  const onError = vi.fn();
  const replaceLocalDocumentSummary = vi.fn();
  const resetActiveDocument = vi.fn();
  const setActiveDocumentId = vi.fn();
  const setOrderedDocuments = vi.fn();
  const upsertDocumentSummary = vi.fn();

  const result = renderHook(
    ({ userId, currentActive, currentDocuments }: { userId: string | null; currentActive: CvDocumentSummary; currentDocuments: CvDocumentSummary[] }) => {
      const form = useForm<CvData>({ defaultValues: cloneCvData(sampleCvDataEn) });
      const actions = useCvDocumentActions({
        userId,
        activeDocument: currentActive,
        activeDocumentId: currentActive.id,
        clearDraft: vi.fn(),
        documents: currentDocuments,
        form,
        handleStorageDeferredError,
        loadDataIntoForm,
        loadDraft,
        onError,
        replaceLocalDocumentSummary,
        resetActiveDocument,
        saveCurrentDocument,
        setActiveDocumentId,
        setOrderedDocuments,
        storageAdapters: adapters as unknown as CvStorageAdapters,
        upsertDocumentSummary,
      });
      return { actions, form };
    },
    {
      initialProps: { userId: null as string | null, currentActive: activeDocument, currentDocuments: documents },
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    },
  );

  return {
    adapters,
    handleStorageDeferredError,
    loadDataIntoForm,
    onError,
    replaceLocalDocumentSummary,
    resetActiveDocument,
    result: result.result,
    rerenderAccount(userId: string | null, currentActive = activeDocument, currentDocuments = documents) {
      result.rerender({ userId, currentActive, currentDocuments });
    },
    saveCurrentDocument,
    setActiveDocumentId,
    setOrderedDocuments,
    upsertDocumentSummary,
  };
}

describe("useCvDocumentActions transition save gates", () => {
  it("blocks switching away from an active local document after a failed silent save", async () => {
    const h = renderActions();
    h.saveCurrentDocument.mockResolvedValueOnce(false);

    await act(async () => {
      await h.result.current.actions.selectDocument("target");
    });

    expect(h.saveCurrentDocument).toHaveBeenCalledWith({ silent: true });
    expect(h.adapters.local.load).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
  });

  it("blocks create-empty/sample transitions after a failed silent save", async () => {
    const h = renderActions();
    h.saveCurrentDocument.mockResolvedValueOnce(false);

    await act(async () => {
      await h.result.current.actions.createDocumentFromData(sampleCvDataEn, "New CV");
    });

    expect(h.saveCurrentDocument).toHaveBeenCalledWith({ silent: true });
    expect(h.replaceLocalDocumentSummary).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("typst-cv-builder:documents:index")).toBeNull();
  });

  it("keeps rename ungated", async () => {
    const h = renderActions();
    h.saveCurrentDocument.mockResolvedValueOnce(false);

    await act(async () => {
      await h.result.current.actions.renameDocument("target", "Renamed");
    });

    expect(h.saveCurrentDocument).not.toHaveBeenCalled();
    expect(h.adapters.local.rename).toHaveBeenCalledWith(expect.objectContaining({ id: "target" }), "Renamed");
    expect(h.upsertDocumentSummary).toHaveBeenCalled();
  });

  it("keeps duplicate ungated and uses the persisted source snapshot", async () => {
    const h = renderActions();
    const source = cloneCvData(sampleCvDataEn);
    source.header.name = "Persisted source";
    h.adapters.local.load.mockResolvedValueOnce({ data: source, summary: summary("target") });
    h.saveCurrentDocument.mockResolvedValueOnce(false);

    await act(async () => {
      await h.result.current.actions.duplicateDocument("target", { title: "Copy" });
    });

    expect(h.saveCurrentDocument).not.toHaveBeenCalled();
    expect(h.adapters.local.load).toHaveBeenCalledWith(
      expect.objectContaining({ id: "target" }),
      { passphraseOverride: undefined },
    );
    expect(h.replaceLocalDocumentSummary).toHaveBeenCalled();
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(expect.any(String), source);
  });

  it("keeps delete ungated and performs its current active-document reset", async () => {
    const h = renderActions();
    h.saveCurrentDocument.mockResolvedValueOnce(false);

    await act(async () => {
      await h.result.current.actions.deleteDocument("active");
    });

    expect(h.saveCurrentDocument).not.toHaveBeenCalled();
    expect(h.adapters.local.delete).toHaveBeenCalledWith(expect.objectContaining({ id: "active" }));
    expect(h.setOrderedDocuments).toHaveBeenCalled();
    expect(h.setActiveDocumentId).toHaveBeenCalledWith(null);
    expect(h.resetActiveDocument).toHaveBeenCalled();
  });
});

describe("useCvDocumentActions account-owned completions", () => {
  it.each([false, true])("does not let A's late delete replace a later account visit's list or active form (return to A: %s)", async returnToA => {
    const a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: a, documents: [a] });
    h.rerenderAccount("user-a");
    let finish!: () => void;
    h.adapters.cloud.delete.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.deleteDocument(a.id); });
    h.rerenderAccount("user-b", b, [b]);
    if (returnToA) h.rerenderAccount("user-a", b, [b]);
    const dataB = cloneCvData(sampleCvDataEn); dataB.header.name = "B's active form";
    act(() => h.result.current.form.reset(dataB));
    await act(async () => { finish(); await pending; });
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
    expect(h.setActiveDocumentId).not.toHaveBeenCalled();
    expect(h.resetActiveDocument).not.toHaveBeenCalled();
    expect(h.result.current.form.getValues()).toEqual(dataB);
  });
  it("does not show A's late rename error or unlock modal to B", async () => {
    const a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: a, documents: [a] });
    h.rerenderAccount("user-a");
    let fail!: (error: Error) => void;
    h.adapters.cloud.rename.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.renameDocument(a.id, "Renamed A"); });
    h.rerenderAccount("user-b", b, [b]);
    await act(async () => { fail(new Error("A-only error")); await pending; });
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.handleStorageDeferredError).not.toHaveBeenCalled();
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
  });
  it.each(["selectDocument", "duplicateDocument"] as const)("does not adopt A's late %s result under B", async operation => {
    const a = summary("a", "cloud"), target = summary("a-target", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: a, documents: [a, target] });
    h.rerenderAccount("user-a");
    let finish!: (value: { data: CvData; summary: CvDocumentSummary }) => void;
    h.adapters.cloud.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions[operation](target.id); });
    h.rerenderAccount("user-b", b, [b]);
    await act(async () => { finish({ data: sampleCvDataEn, summary: target }); await pending; });
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
    expect(h.replaceLocalDocumentSummary).not.toHaveBeenCalled();
  });
  it("does not create a local document for A when its required save returns under B", async () => {
    const a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: a, documents: [a] });
    h.rerenderAccount("user-a");
    let finish!: (value: boolean) => void;
    h.saveCurrentDocument.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.createDocumentFromData(sampleCvDataEn, "A's local copy"); });
    h.rerenderAccount("user-b", b, [b]);
    await act(async () => { finish(true); await pending; });
    expect(h.replaceLocalDocumentSummary).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
  });
});

describe("useCvDocumentActions deferred storage failures", () => {
  it("opens the existing unlock path while leaving target state unchanged", async () => {
    const active = summary("active", "local");
    const target = summary("target", "encrypted");
    const h = renderActions({ activeDocument: active, documents: [active, target] });
    h.adapters.encrypted.load.mockRejectedValueOnce(new MissingPassphraseError(target.id, "en"));
    h.handleStorageDeferredError.mockReturnValueOnce(true);

    await act(async () => {
      await h.result.current.actions.selectDocument(target.id);
    });

    expect(h.handleStorageDeferredError).toHaveBeenCalledWith(expect.any(MissingPassphraseError), "unlock");
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
    expect(h.setActiveDocumentId).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
});
