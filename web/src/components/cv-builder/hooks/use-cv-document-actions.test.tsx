// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForm } from "react-hook-form";
import { useState } from "react";

import { useCvDocumentActions } from "@/components/cv-builder/hooks/use-cv-document-actions";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";
import { MissingPassphraseError } from "@/lib/cv/storage-adapters";
import { clearUserEncryptionPasswords } from "@/lib/cv/encryption-storage";
import { pauseEncryptedLoad } from "./__tests__/encrypted-load-boundary";

import messages from "../../../../messages/en.json";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
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
  adoptForm = false,
}: {
  activeDocument?: CvDocumentSummary;
  documents?: CvDocumentSummary[];
  adoptForm?: boolean;
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
      const [loadedDocumentId, setLoadedDocumentId] = useState(currentActive.id);
      const selected = adoptForm ? currentDocuments.find(document => document.id === loadedDocumentId) ?? currentActive : currentActive;
      const actions = useCvDocumentActions({
        userId,
        activeDocument: selected,
        activeDocumentId: adoptForm ? loadedDocumentId : currentActive.id,
        clearDraft: vi.fn(),
        documents: currentDocuments,
        form,
        handleStorageDeferredError,
        loadDataIntoForm: (...args) => {
          loadDataIntoForm(...args);
          if (adoptForm) {
            setLoadedDocumentId(args[0]);
            form.reset(cloneCvData(args[1]));
          }
        },
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
      return { actions, form, loadedDocumentId, isDirty: form.formState.isDirty };
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
    loadDraft,
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
  it.each(["selectDocument", "duplicateDocument"] as const)("does not finish cached-password %s decryption after a batched sign-out and same-user return", async operation => {
    const active = summary("active", "cloud");
    const encrypted = summary("encrypted-a", "encrypted");
    const h = renderActions({ activeDocument: active, documents: [active, encrypted], adoptForm: true });
    h.rerenderAccount("user-a");
    const paused = await pauseEncryptedLoad("user-a", encrypted);
    h.adapters.encrypted.load.mockImplementationOnce(paused.load);
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions[operation](encrypted.id); });
    await paused.entered;
    act(() => {
      clearUserEncryptionPasswords("user-a");
      h.rerenderAccount(null);
      h.rerenderAccount("user-a");
    });
    await act(async () => { paused.finish(); await pending; });
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
    expect(h.replaceLocalDocumentSummary).not.toHaveBeenCalled();
    expect(h.result.current.form.getValues().header.subtitle).toBe(sampleCvDataEn.header.subtitle);
    expect(window.localStorage.getItem("typst-cv-builder:documents:index")).toBeNull();
    expect(h.onError).not.toHaveBeenCalled();
  });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}

function namedData(name: string) {
  const data = cloneCvData(sampleCvDataEn);
  data.header.name = name;
  return data;
}

describe("useCvDocumentActions latest form intent", () => {
  it.each(["cloud", "encrypted"] as const)("passes the loaded %s body's revision into form adoption", async storageKind => {
    const active = summary("active", "cloud"), target = summary("target", storageKind);
    const h = renderActions({ activeDocument: active, documents: [active, target], adoptForm: true });
    const loaded = namedData("Loaded revision 1");
    const draft = namedData("Recovered draft");
    h.adapters[storageKind].load.mockResolvedValueOnce({ data: loaded, summary: target, cloudRevision: "1" });
    if (storageKind === "cloud") h.loadDraft.mockReturnValueOnce(draft);
    await act(async () => { await h.result.current.actions.selectDocument(target.id); });
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(target.id, storageKind === "cloud" ? draft : loaded, {
      baselineData: loaded,
      cloudRevision: "1",
    });
  });

  it("does not invent a cloud revision for a local load", async () => {
    const active = summary("active", "cloud"), target = summary("target", "local");
    const h = renderActions({ activeDocument: active, documents: [active, target] });
    h.adapters.local.load.mockResolvedValueOnce({ data: sampleCvDataEn, summary: target });
    await act(async () => { await h.result.current.actions.selectDocument(target.id); });
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(target.id, sampleCvDataEn, { baselineData: sampleCvDataEn });
  });

  it("keeps B active and dirty when an earlier same-account A selection resolves last", async () => {
    const active = summary("active", "cloud"), a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: active, documents: [active, a, b], adoptForm: true });
    h.rerenderAccount("same-user");
    const old = deferred<{ data: CvData; summary: CvDocumentSummary }>();
    h.adapters.cloud.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ data: namedData("B persisted"), summary: b });
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.selectDocument(a.id); });
    await act(async () => { await h.result.current.actions.selectDocument(b.id); });
    act(() => { h.result.current.form.setValue("header.name", "B unsaved edit", { shouldDirty: true }); });
    expect(h.result.current.loadedDocumentId).toBe(b.id);
    expect(h.result.current.isDirty).toBe(true);
    await act(async () => { old.resolve({ data: namedData("A persisted"), summary: a }); await pending; });
    expect(h.result.current.loadedDocumentId).toBe(b.id);
    expect(h.result.current.form.getValues("header.name")).toBe("B unsaved edit");
    expect(h.result.current.isDirty).toBe(true);
    expect(h.loadDataIntoForm).toHaveBeenCalledTimes(1);
    expect(h.upsertDocumentSummary).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)("selecting the active document cancels a pending selection's %s", async completion => {
    const b = summary("b", "cloud"), a = summary("a", "encrypted");
    const h = renderActions({ activeDocument: b, documents: [b, a], adoptForm: true });
    const old = deferred<{ data: CvData; summary: CvDocumentSummary }>();
    h.adapters.encrypted.load.mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.selectDocument(a.id); });
    act(() => { h.result.current.form.setValue("header.name", "Keep editing B", { shouldDirty: true }); });
    await act(async () => { await h.result.current.actions.selectDocument(b.id); });
    await act(async () => {
      if (completion === "resolve") old.resolve({ data: namedData("A"), summary: a });
      else old.reject(new MissingPassphraseError(a.id, "en"));
      await pending;
    });
    expect(h.result.current.loadedDocumentId).toBe(b.id);
    expect(h.result.current.form.getValues("header.name")).toBe("Keep editing B");
    expect(h.result.current.isDirty).toBe(true);
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.handleStorageDeferredError).not.toHaveBeenCalled();
  });

  it.each([new Error("Old A load error"), new MissingPassphraseError("a", "en")])("suppresses a superseded load error without changing B (%s)", async error => {
    const active = summary("active", "cloud"), a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: active, documents: [active, a, b], adoptForm: true });
    const old = deferred<{ data: CvData; summary: CvDocumentSummary }>();
    h.adapters.cloud.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ data: namedData("B"), summary: b });
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.selectDocument(a.id); });
    await act(async () => { await h.result.current.actions.selectDocument(b.id); });
    await act(async () => { old.reject(error); await pending; });
    expect(h.result.current.loadedDocumentId).toBe(b.id);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.handleStorageDeferredError).not.toHaveBeenCalled();
  });

  it("does not start an old target load after its local auto-save loses to B", async () => {
    const active = summary("active", "local"), a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: active, documents: [active, a, b], adoptForm: true });
    const saving = deferred<boolean>();
    h.saveCurrentDocument.mockReturnValueOnce(saving.promise).mockResolvedValueOnce(true);
    h.adapters.cloud.load.mockImplementation(async (document: CvDocumentSummary) => ({ data: namedData(document.id), summary: document }));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.selectDocument(a.id); });
    await act(async () => { await h.result.current.actions.selectDocument(b.id); });
    act(() => { h.result.current.form.setValue("header.name", "B unsaved after local save", { shouldDirty: true }); });
    await act(async () => { saving.resolve(true); await pending; });
    expect(h.adapters.cloud.load).toHaveBeenCalledTimes(1);
    expect(h.adapters.cloud.load).toHaveBeenCalledWith(b);
    expect(h.result.current.loadedDocumentId).toBe(b.id);
    expect(h.result.current.form.getValues("header.name")).toBe("B unsaved after local save");
    expect(h.result.current.isDirty).toBe(true);
  });

  it.each(["create", "duplicate"] as const)("does not let a pending %s replace a newer selected document", async operation => {
    const active = summary("active", "cloud"), a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: active, documents: [active, a, b], adoptForm: true });
    const saving = deferred<boolean>();
    const loading = deferred<{ data: CvData; summary: CvDocumentSummary }>();
    let pending!: Promise<void>;
    if (operation === "create") {
      h.saveCurrentDocument.mockReturnValueOnce(saving.promise);
      act(() => { pending = h.result.current.actions.createDocumentFromData(namedData("New local"), "New CV"); });
    } else {
      h.adapters.cloud.load.mockReturnValueOnce(loading.promise);
      act(() => { pending = h.result.current.actions.duplicateDocument(a.id); });
    }
    h.adapters.cloud.load.mockResolvedValueOnce({ data: namedData("B"), summary: b });
    await act(async () => { await h.result.current.actions.selectDocument(b.id); });
    act(() => { h.result.current.form.setValue("header.name", "B stays dirty", { shouldDirty: true }); });
    await act(async () => {
      if (operation === "create") saving.resolve(true);
      else loading.resolve({ data: namedData("A"), summary: a });
      await pending;
    });
    expect(h.result.current.loadedDocumentId).toBe(b.id);
    expect(h.result.current.form.getValues("header.name")).toBe("B stays dirty");
    expect(h.result.current.isDirty).toBe(true);
    expect(h.replaceLocalDocumentSummary).not.toHaveBeenCalled();
  });

  it.each(["create", "duplicate"] as const)("a completed %s invalidates an older selection", async operation => {
    const active = summary("active", "cloud"), a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: active, documents: [active, a, b], adoptForm: true });
    const old = deferred<{ data: CvData; summary: CvDocumentSummary }>();
    h.adapters.cloud.load.mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.selectDocument(a.id); });
    await act(async () => {
      if (operation === "create") await h.result.current.actions.createDocumentFromData(namedData("New local"), "New CV");
      else {
        h.adapters.cloud.load.mockResolvedValueOnce({ data: namedData("Duplicate B"), summary: b });
        await h.result.current.actions.duplicateDocument(b.id);
      }
    });
    const newId = h.result.current.loadedDocumentId;
    expect(newId).not.toBe(active.id);
    act(() => { h.result.current.form.setValue("header.name", "New local unsaved", { shouldDirty: true }); });
    await act(async () => { old.resolve({ data: namedData("Old A"), summary: a }); await pending; });
    expect(h.result.current.loadedDocumentId).toBe(newId);
    expect(h.result.current.form.getValues("header.name")).toBe("New local unsaved");
    expect(h.result.current.isDirty).toBe(true);
  });

  it.each([false, true])("deletes A from the list without resetting a later B selection (B loaded: %s)", async bLoaded => {
    const a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: a, documents: [a, b], adoptForm: true });
    const deleting = deferred<void>();
    const loading = deferred<{ data: CvData; summary: CvDocumentSummary }>();
    h.adapters.cloud.delete.mockReturnValueOnce(deleting.promise);
    h.adapters.cloud.load.mockReturnValueOnce(loading.promise);
    let pendingDelete!: Promise<void>, pendingSelect!: Promise<void>;
    act(() => { pendingDelete = h.result.current.actions.deleteDocument(a.id); });
    act(() => { pendingSelect = h.result.current.actions.selectDocument(b.id); });
    if (bLoaded) await act(async () => { loading.resolve({ data: namedData("B"), summary: b }); await pendingSelect; });
    act(() => { h.result.current.form.setValue("header.name", "Keep the current unsaved form", { shouldDirty: true }); });
    await act(async () => { deleting.resolve(); await pendingDelete; });
    expect(h.setOrderedDocuments).toHaveBeenCalled();
    const updateList = h.setOrderedDocuments.mock.calls[0][0] as (documents: CvDocumentSummary[]) => CvDocumentSummary[];
    expect(updateList([a, b])).toEqual([b]);
    expect(h.setActiveDocumentId).not.toHaveBeenCalled();
    expect(h.resetActiveDocument).not.toHaveBeenCalled();
    expect(h.result.current.form.getValues("header.name")).toBe("Keep the current unsaved form");
    expect(h.result.current.isDirty).toBe(true);
    if (!bLoaded) await act(async () => { loading.resolve({ data: namedData("B"), summary: b }); await pendingSelect; });
    expect(h.result.current.loadedDocumentId).toBe(b.id);
  });

  it("still resets a deleted active A when the latest selection reaffirms A", async () => {
    const a = summary("a", "cloud");
    const h = renderActions({ activeDocument: a, documents: [a], adoptForm: true });
    const deleting = deferred<void>();
    h.adapters.cloud.delete.mockReturnValueOnce(deleting.promise);
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.deleteDocument(a.id); });
    await act(async () => { await h.result.current.actions.selectDocument(a.id); });
    await act(async () => { deleting.resolve(); await pending; });
    expect(h.setActiveDocumentId).toHaveBeenCalledWith(null);
    expect(h.resetActiveDocument).toHaveBeenCalled();
    expect(h.result.current.form.getValues("header.name")).toBe("");
  });

  it("does not adopt a pending selection of A after A is deleted while B is edited", async () => {
    const a = summary("a", "cloud"), b = summary("b", "cloud");
    const h = renderActions({ activeDocument: a, documents: [a, b], adoptForm: true });
    const deleting = deferred<void>();
    const loading = deferred<{ data: CvData; summary: CvDocumentSummary }>();
    h.adapters.cloud.delete.mockReturnValueOnce(deleting.promise);
    h.adapters.cloud.load.mockResolvedValueOnce({ data: namedData("B"), summary: b }).mockReturnValueOnce(loading.promise);
    let pendingDelete!: Promise<void>, pendingSelect!: Promise<void>;
    act(() => { pendingDelete = h.result.current.actions.deleteDocument(a.id); });
    await act(async () => { await h.result.current.actions.selectDocument(b.id); });
    act(() => { h.result.current.form.setValue("header.name", "B survives deleted A", { shouldDirty: true }); });
    act(() => { pendingSelect = h.result.current.actions.selectDocument(a.id); });
    await act(async () => { deleting.resolve(); await pendingDelete; });
    await act(async () => { loading.resolve({ data: namedData("Deleted A snapshot"), summary: a }); await pendingSelect; });
    expect(h.setOrderedDocuments).toHaveBeenCalled();
    expect(h.setActiveDocumentId).not.toHaveBeenCalled();
    expect(h.result.current.loadedDocumentId).toBe(b.id);
    expect(h.result.current.form.getValues("header.name")).toBe("B survives deleted A");
    expect(h.result.current.isDirty).toBe(true);
  });

  it("still reports the latest selection's ordinary failure", async () => {
    const active = summary("active", "cloud"), target = summary("target", "cloud");
    const h = renderActions({ activeDocument: active, documents: [active, target], adoptForm: true });
    h.adapters.cloud.load.mockRejectedValueOnce(new Error("Current target failed"));
    await act(async () => { await h.result.current.actions.selectDocument(target.id); });
    expect(h.onError).toHaveBeenCalledWith("Current target failed");
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.result.current.loadedDocumentId).toBe(active.id);
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
