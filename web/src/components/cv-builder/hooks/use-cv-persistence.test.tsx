// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useForm, useWatch } from "react-hook-form";

import { useCvPersistence } from "@/components/cv-builder/hooks/use-cv-persistence";
import { useCvPreview } from "@/components/cv-builder/hooks/use-cv-preview";
import { baselineOnPersisted, createCvBaseline } from "@/lib/cv/baseline";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";

import messages from "../../../../messages/en.json";

vi.mock("@/lib/typst/render", () => ({
  renderTypstSvg: vi.fn().mockResolvedValue("<svg>preview</svg>"),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeSummary(storageKind: CvDocumentSummary["storageKind"] = "local"): CvDocumentSummary {
  return {
    id: `doc-${storageKind}`,
    title: `${storageKind} CV`,
    storageKind,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderPersistence(storageKind: CvDocumentSummary["storageKind"] = "local", withPreview = false) {
  const summary = makeSummary(storageKind);
  const adapter = {
    delete: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue({ data: sampleCvDataEn, summary }),
    rename: vi.fn().mockResolvedValue(summary),
    save: vi.fn().mockResolvedValue({ ...summary, updatedAt: "2026-01-01T00:01:00.000Z" }),
  };
  const storageAdapters = {
    local: adapter,
    cloud: adapter,
    encrypted: adapter,
  } as unknown as CvStorageAdapters;
  const editingRevisions = new Map([[summary.id, "1"]]);
  const drafts = new Map<string, { data: CvData; baseRevision: string }>();
  const clearDraft = vi.fn((id: string) => { drafts.delete(id); });
  const saveDraft = vi.fn((id: string, data: CvData) => {
    drafts.set(id, { data: cloneCvData(data), baseRevision: editingRevisions.get(id)! });
  });
  const handleStorageDeferredError = vi.fn().mockReturnValue(false);
  const loadDataIntoForm = vi.fn();
  const onPersisted = vi.fn();
  const onError = vi.fn();
  const upsertDocumentSummary = vi.fn();

  const result = renderHook(
    ({ userId, active }: { userId: string | null; active: CvDocumentSummary }) => {
      const form = useForm<CvData>({ defaultValues: cloneCvData(sampleCvDataEn) });
      const watchedData = useWatch({ control: form.control });
      const baseline = useRef(createCvBaseline(active.id, sampleCvDataEn));
      const activeRef = useRef(active);
      useLayoutEffect(() => {
        activeRef.current = active;
        if (baseline.current.documentId !== active.id) baseline.current = createCvBaseline(active.id, sampleCvDataEn);
      }, [active]);
      const initializedRef = useRef(withPreview);
      const [dirty, setDirty] = useState(false);
      const tPersistence = useTranslations("CvPersistence");
      const tImportExport = useTranslations("ImportExport");
      const persistence = useCvPersistence({
        userId,
        tPersistence,
        activeDocument: active,
        activeDocumentId: active.id,
        clearDraft,
        form,
        handleStorageDeferredError,
        loadDataIntoForm,
        onPersisted: (id, data) => {
          onPersisted(id, data);
          const current = cvSchema.safeParse(form.getValues());
          const result = baselineOnPersisted({
            baseline: baseline.current,
            activeDocumentId: activeRef.current.id,
            savedDocumentId: id,
            savedData: data,
            currentData: current.success ? current.data : null,
          });
          if (result) {
            baseline.current = result.baseline;
            setDirty(result.dirty);
            if (activeRef.current.storageKind === "cloud" && current.success) {
              if (result.dirty) saveDraft(id, current.data);
              else clearDraft(id);
            }
          }
        },
        onError,
        storageAdapters,
        upsertDocumentSummary,
      });
      useCvPreview({
        tImportExport,
        activeDocument: active,
        activeDocumentId: active.id,
        clearDraft,
        form,
        getDirtyBaseline: () => baseline.current,
        initializedRef,
        onDirtyChange: setDirty,
        saveCurrentDocument: persistence.saveCurrentDocument,
        saveDraft,
        watchedData,
      });
      return { form, persistence, dirty };
    },
    {
      initialProps: { userId: null as string | null, active: summary },
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    },
  );

  return {
    adapter,
    clearDraft,
    drafts,
    editingRevisions,
    handleStorageDeferredError,
    loadDataIntoForm,
    onPersisted,
    onError,
    result: result.result,
    saveDraft,
    rerenderAccount(userId: string | null, active = summary) { result.rerender({ userId, active }); },
    summary,
    upsertDocumentSummary,
  };
}

describe("useCvPersistence save lifecycle", () => {
  it("advances the persisted callbacks only after an explicit save succeeds", async () => {
    const h = renderPersistence("local");
    const edited = cloneCvData(sampleCvDataEn);
    edited.header.name = "Edited name";
    act(() => {
      h.result.current.form.reset(edited);
    });

    let saved = false;
    await act(async () => {
      saved = await h.result.current.persistence.saveCurrentDocument();
    });

    expect(saved).toBe(true);
    expect(h.adapter.save).toHaveBeenCalledWith(h.summary, edited);
    expect(h.upsertDocumentSummary).toHaveBeenCalledWith(
      expect.objectContaining({ id: h.summary.id }),
    );
    expect(h.onPersisted).toHaveBeenCalledWith(h.summary.id, edited);
    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.result.current.persistence.saving).toBe(false);
  });

  it("leaves persisted callbacks untouched after a failed save", async () => {
    const h = renderPersistence("local");
    h.adapter.save.mockRejectedValueOnce(new Error("save failed"));

    let saved = true;
    await act(async () => {
      saved = await h.result.current.persistence.saveCurrentDocument();
    });

    expect(saved).toBe(false);
    expect(h.onPersisted).not.toHaveBeenCalled();
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith("save failed");
    expect(h.result.current.persistence.saving).toBe(false);
  });

  it("clears a cloud draft only after the cloud save succeeds", async () => {
    const h = renderPersistence("cloud");
    const edited = cloneCvData(sampleCvDataEn);
    edited.header.subtitle = "cloud persisted";
    act(() => {
      h.result.current.form.reset(edited);
    });
    h.saveDraft(h.summary.id, edited);

    await act(async () => {
      await h.result.current.persistence.saveCurrentDocument();
    });

    expect(h.adapter.save).toHaveBeenCalledWith(h.summary, edited);
    expect(h.clearDraft).toHaveBeenCalledWith(h.summary.id);
    expect(h.drafts.has(h.summary.id)).toBe(false);
    expect(h.onPersisted).toHaveBeenCalledWith(h.summary.id, edited);
  });

  it("keeps a cloud draft after a failed cloud save", async () => {
    const h = renderPersistence("cloud");
    h.adapter.save.mockRejectedValueOnce(new Error("cloud unavailable"));
    h.saveDraft(h.summary.id, sampleCvDataEn);

    await act(async () => {
      await h.result.current.persistence.saveCurrentDocument();
    });

    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.onPersisted).not.toHaveBeenCalled();
    expect(h.drafts.get(h.summary.id)).toEqual({ data: sampleCvDataEn, baseRevision: "1" });
  });

  it("retains a newer debounced cloud draft after the earlier saved snapshot completes", async () => {
    vi.useFakeTimers();
    const h = renderPersistence("cloud", true);
    const s1 = cloneCvData(sampleCvDataEn);
    s1.header.name = "S1 sent to cloud";
    act(() => { h.result.current.form.reset(s1); });
    let finish!: (summary: CvDocumentSummary) => void;
    h.adapter.save.mockReturnValueOnce(new Promise<CvDocumentSummary>(resolve => { finish = resolve; }));
    let pending!: Promise<boolean>;
    act(() => { pending = h.result.current.persistence.saveCurrentDocument(); });
    expect(h.result.current.persistence.saving).toBe(true);
    expect(h.adapter.save).toHaveBeenCalledWith(h.summary, s1);

    act(() => { h.result.current.form.setValue("header.name", "S2 typed during save", { shouldDirty: true }); });
    const s2 = cloneCvData(h.result.current.form.getValues());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(h.saveDraft).toHaveBeenCalledWith(h.summary.id, s2);
    expect(h.drafts.get(h.summary.id)).toEqual({ data: s2, baseRevision: "1" });

    await act(async () => {
      // A successful adapter advances its editing evidence before resolving.
      h.editingRevisions.set(h.summary.id, "2");
      finish(h.summary);
      expect(await pending).toBe(true);
    });
    expect(h.onPersisted).toHaveBeenCalledWith(h.summary.id, s1);
    expect(h.result.current.form.getValues()).toEqual(s2);
    expect(h.result.current.dirty).toBe(true);
    expect(h.saveDraft).toHaveBeenCalledTimes(2);
    expect(h.clearDraft).not.toHaveBeenCalled();
    const draftWritesAfterSave = h.saveDraft.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(h.saveDraft).toHaveBeenCalledTimes(draftWritesAfterSave);
    expect(h.drafts.get(h.summary.id)).toEqual({ data: s2, baseRevision: "2" });
  });

  it.each(["inactive", "invalid"] as const)("preserves an existing cloud draft when the successful save's current form is %s", async state => {
    const h = renderPersistence("cloud");
    h.rerenderAccount("user-a");
    let finish!: (summary: CvDocumentSummary) => void;
    h.adapter.save.mockReturnValueOnce(new Promise<CvDocumentSummary>(resolve => { finish = resolve; }));
    let pending!: Promise<boolean>;
    act(() => { pending = h.result.current.persistence.saveCurrentDocument(); });
    const s2 = cloneCvData(sampleCvDataEn);
    s2.header.name = "Recoverable S2";
    h.saveDraft(h.summary.id, s2);
    if (state === "inactive") h.rerenderAccount("user-a", { ...h.summary, id: "other-cloud" });
    else act(() => { h.result.current.form.setValue("schemaVersion", 999 as never); });

    await act(async () => {
      h.editingRevisions.set(h.summary.id, "2");
      finish(h.summary);
      expect(await pending).toBe(true);
    });
    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.saveDraft).toHaveBeenCalledTimes(1);
    expect(h.drafts.get(h.summary.id)).toEqual({ data: s2, baseRevision: "1" });
  });

  it("defers a recognized passphrase error without emitting a generic save error", async () => {
    const h = renderPersistence("encrypted");
    h.adapter.save.mockRejectedValueOnce(new Error("missing passphrase"));
    h.handleStorageDeferredError.mockReturnValueOnce(true);

    await act(async () => {
      await h.result.current.persistence.saveCurrentDocument();
    });

    expect(h.handleStorageDeferredError).toHaveBeenCalledWith(expect.any(Error), "unlock");
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onPersisted).not.toHaveBeenCalled();
  });

  it("rejects invalid form data before touching the storage adapter", async () => {
    const h = renderPersistence("local");
    act(() => {
      h.result.current.form.setValue("schemaVersion", 999 as never);
    });

    await act(async () => {
      await h.result.current.persistence.saveCurrentDocument();
    });

    expect(h.adapter.save).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalled();
  });
});

describe("useCvPersistence account-owned completion and saving state", () => {
  it.each(["finished-under-b", "still-pending"] as const)("does not revive A's obsolete saving state on return to A (%s)", async phase => {
    const h = renderPersistence("cloud");
    h.rerenderAccount("user-a");
    let finishOld!: (value: CvDocumentSummary) => void, finishNew!: (value: CvDocumentSummary) => void;
    h.adapter.save.mockReturnValueOnce(new Promise<CvDocumentSummary>(resolve => { finishOld = resolve; }));
    h.adapter.save.mockReturnValueOnce(new Promise<CvDocumentSummary>(resolve => { finishNew = resolve; }));
    let old!: Promise<boolean>, current!: Promise<boolean>;
    act(() => { old = h.result.current.persistence.saveCurrentDocument(); });
    h.rerenderAccount("user-b", { ...h.summary, id: "b-cloud" });
    if (phase === "finished-under-b") await act(async () => { finishOld(h.summary); expect(await old).toBe(false); });
    h.rerenderAccount("user-a");
    expect(h.result.current.persistence.saving).toBe(false);
    act(() => { current = h.result.current.persistence.saveCurrentDocument(); });
    expect(h.adapter.save).toHaveBeenCalledTimes(2);
    if (phase === "still-pending") await act(async () => { finishOld(h.summary); expect(await old).toBe(false); });
    expect(h.result.current.persistence.saving).toBe(true);
    expect(h.onPersisted).not.toHaveBeenCalled();
    await act(async () => { finishNew(h.summary); expect(await current).toBe(true); });
    expect(h.result.current.persistence.saving).toBe(false);
    expect(h.onPersisted).toHaveBeenCalledOnce();
  });
  it.each(["success", "failure"] as const)("A's late save %s cannot change B's callbacks or pending saving indicator", async outcome => {
    const h = renderPersistence("cloud");
    h.rerenderAccount("user-a");
    let finishA!: (value: CvDocumentSummary) => void, failA!: (error: Error) => void, finishB!: (value: CvDocumentSummary) => void;
    h.adapter.save.mockReturnValueOnce(new Promise<CvDocumentSummary>((resolve, reject) => { finishA = resolve; failA = reject; }));
    h.adapter.save.mockReturnValueOnce(new Promise<CvDocumentSummary>(resolve => { finishB = resolve; }));
    let a!: Promise<boolean>, b!: Promise<boolean>;
    act(() => { a = h.result.current.persistence.saveCurrentDocument(); });
    const summaryB = { ...h.summary, id: "b-cloud" };
    h.rerenderAccount("user-b", summaryB);
    expect(h.result.current.persistence.saving).toBe(false);
    act(() => { b = h.result.current.persistence.saveCurrentDocument(); });
    expect(h.adapter.save).toHaveBeenCalledTimes(2);
    expect(h.result.current.persistence.saving).toBe(true);
    await act(async () => { if (outcome === "success") finishA(h.summary); else failA(new Error("A-only save failure")); expect(await a).toBe(false); });
    expect(h.result.current.persistence.saving).toBe(true);
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
    expect(h.onPersisted).not.toHaveBeenCalled();
    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.handleStorageDeferredError).not.toHaveBeenCalled();
    await act(async () => { finishB(summaryB); expect(await b).toBe(true); });
    expect(h.onPersisted).toHaveBeenCalledWith(summaryB.id, sampleCvDataEn);
    expect(h.clearDraft).toHaveBeenCalledWith(summaryB.id);
    expect(h.result.current.persistence.saving).toBe(false);
  });
  it("does not adopt A's late discard read under B", async () => {
    const h = renderPersistence("cloud");
    h.rerenderAccount("user-a");
    let finish!: (value: { data: CvData; summary: CvDocumentSummary }) => void;
    h.adapter.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.persistence.discardChanges(); });
    h.rerenderAccount("user-b", { ...h.summary, id: "b-cloud" });
    await act(async () => { finish({ data: sampleCvDataEn, summary: h.summary }); await pending; });
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
});

describe("useCvPersistence cloud and encrypted discard", () => {
  it.each(["cloud", "encrypted"] as const)("reloads %s data and clears only cloud drafts", async (storageKind) => {
    const h = renderPersistence(storageKind);
    const loaded = cloneCvData(sampleCvDataEn);
    loaded.header.subtitle = "persisted value";
    h.adapter.load.mockResolvedValueOnce({ data: loaded, summary: h.summary, cloudRevision: "1" });

    await act(async () => {
      await h.result.current.persistence.discardChanges();
    });

    expect(h.adapter.load).toHaveBeenCalledWith(h.summary);
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(h.summary.id, loaded, { cloudRevision: "1" });
    expect(h.clearDraft).toHaveBeenCalledTimes(storageKind === "cloud" ? 1 : 0);
  });

  it("keeps target state untouched when discard is deferred to the unlock modal", async () => {
    const h = renderPersistence("encrypted");
    h.adapter.load.mockRejectedValueOnce(new Error("missing passphrase"));
    h.handleStorageDeferredError.mockReturnValueOnce(true);

    await act(async () => {
      await h.result.current.persistence.discardChanges();
    });

    expect(h.handleStorageDeferredError).toHaveBeenCalledWith(expect.any(Error), "unlock");
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
});
