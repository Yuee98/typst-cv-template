// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useForm } from "react-hook-form";

import { useCvPersistence } from "@/components/cv-builder/hooks/use-cv-persistence";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";

import messages from "../../../../messages/en.json";

afterEach(() => {
  cleanup();
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

function renderPersistence(storageKind: CvDocumentSummary["storageKind"] = "local") {
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
  const clearDraft = vi.fn();
  const handleStorageDeferredError = vi.fn().mockReturnValue(false);
  const loadDataIntoForm = vi.fn();
  const onPersisted = vi.fn();
  const onError = vi.fn();
  const upsertDocumentSummary = vi.fn();

  const result = renderHook(
    () => {
      const form = useForm<CvData>({ defaultValues: cloneCvData(sampleCvDataEn) });
      const tPersistence = useTranslations("CvPersistence");
      const persistence = useCvPersistence({
        tPersistence,
        activeDocument: summary,
        activeDocumentId: summary.id,
        clearDraft,
        form,
        handleStorageDeferredError,
        loadDataIntoForm,
        onPersisted,
        onError,
        storageAdapters,
        upsertDocumentSummary,
      });
      return { form, persistence };
    },
    {
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
    handleStorageDeferredError,
    loadDataIntoForm,
    onPersisted,
    onError,
    result: result.result,
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

    await act(async () => {
      await h.result.current.persistence.saveCurrentDocument();
    });

    expect(h.adapter.save).toHaveBeenCalledWith(h.summary, edited);
    expect(h.clearDraft).toHaveBeenCalledWith(h.summary.id);
    expect(h.onPersisted).toHaveBeenCalledWith(h.summary.id, edited);
  });

  it("keeps a cloud draft after a failed cloud save", async () => {
    const h = renderPersistence("cloud");
    h.adapter.save.mockRejectedValueOnce(new Error("cloud unavailable"));

    await act(async () => {
      await h.result.current.persistence.saveCurrentDocument();
    });

    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.onPersisted).not.toHaveBeenCalled();
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

describe("useCvPersistence cloud and encrypted discard", () => {
  it.each(["cloud", "encrypted"] as const)("reloads %s data and clears only cloud drafts", async (storageKind) => {
    const h = renderPersistence(storageKind);
    const loaded = cloneCvData(sampleCvDataEn);
    loaded.header.subtitle = "persisted value";
    h.adapter.load.mockResolvedValueOnce({ data: loaded, summary: h.summary });

    await act(async () => {
      await h.result.current.persistence.discardChanges();
    });

    expect(h.adapter.load).toHaveBeenCalledWith(h.summary);
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(h.summary.id, loaded);
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
