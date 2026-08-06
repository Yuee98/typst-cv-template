// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForm, useWatch } from "react-hook-form";

import { useCvPreview } from "@/components/cv-builder/hooks/use-cv-preview";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { createCvBaseline } from "@/lib/cv/baseline";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { renderTypstSvg } from "@/lib/typst/render";

import messages from "../../../../messages/en.json";

vi.mock("@/lib/typst/render", () => ({
  renderTypstSvg: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(renderTypstSvg).mockResolvedValue("<svg>rendered</svg>");
});

function makeSummary(storageKind: CvDocumentSummary["storageKind"]): CvDocumentSummary {
  return {
    id: `preview-${storageKind}`,
    title: `${storageKind} CV`,
    storageKind,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderPreview(storageKind: CvDocumentSummary["storageKind"] = "local") {
  const summary = makeSummary(storageKind);
  const saveCurrentDocument = vi.fn().mockResolvedValue(true);
  const saveDraft = vi.fn();
  const clearDraft = vi.fn();
  const onDirtyChange = vi.fn();

  const result = renderHook(
    () => {
      const form = useForm<CvData>({ defaultValues: cloneCvData(sampleCvDataEn) });
      const watchedData = useWatch({ control: form.control });
      const initializedRef = useRef(true);
      const tImportExport = useTranslations("ImportExport");
      const preview = useCvPreview({
        tImportExport,
        activeDocument: summary,
        activeDocumentId: summary.id,
        clearDraft,
        form,
        getDirtyBaseline: () => createCvBaseline(summary.id, sampleCvDataEn),
        initializedRef,
        onDirtyChange,
        saveCurrentDocument,
        saveDraft,
        watchedData,
      });
      return { form, preview };
    },
    {
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    },
  );

  return { clearDraft, onDirtyChange, result: result.result, saveCurrentDocument, saveDraft, summary };
}

async function flushPreview() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

describe("useCvPreview autosave and draft ownership", () => {
  it("suppresses autosave for a form-load reset but still renders the preview", async () => {
    const h = renderPreview("local");
    act(() => {
      h.result.current.preview.resetForFormLoad();
    });
    await flushPreview();

    expect(h.saveCurrentDocument).not.toHaveBeenCalled();
    expect(renderTypstSvg).toHaveBeenCalledTimes(1);
    expect(h.result.current.preview.svg).toBe("<svg>rendered</svg>");
  });

  it("autosaves a local edit and renders after a successful save", async () => {
    const h = renderPreview("local");
    act(() => {
      h.result.current.form.setValue("header.subtitle", "local edit");
    });
    await flushPreview();

    expect(h.saveCurrentDocument).toHaveBeenCalledWith({ silent: true });
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(renderTypstSvg).toHaveBeenCalledTimes(1);
    expect(h.result.current.preview.status).toBe("ready");
  });

  it("keeps local data dirty and skips rendering when autosave fails", async () => {
    const h = renderPreview("local");
    h.saveCurrentDocument.mockResolvedValueOnce(false);
    act(() => {
      h.result.current.form.setValue("header.subtitle", "unsaved local edit");
    });
    await flushPreview();

    expect(h.saveCurrentDocument).toHaveBeenCalledWith({ silent: true });
    expect(h.onDirtyChange).toHaveBeenCalledWith(true);
    expect(renderTypstSvg).not.toHaveBeenCalled();
  });

  it("stores a dirty cloud draft, then clears it when the form returns to baseline", async () => {
    const h = renderPreview("cloud");
    act(() => {
      h.result.current.form.setValue("header.subtitle", "cloud draft");
    });
    await flushPreview();

    expect(h.saveDraft).toHaveBeenCalledWith(
      h.summary.id,
      expect.objectContaining({ header: expect.objectContaining({ subtitle: "cloud draft" }) }),
    );
    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.onDirtyChange).toHaveBeenCalledWith(true);

    act(() => {
      h.result.current.form.reset(cloneCvData(sampleCvDataEn));
    });
    await flushPreview();

    expect(h.clearDraft).toHaveBeenCalledWith(h.summary.id);
    expect(h.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("does not autosave or write plaintext drafts for encrypted documents", async () => {
    const h = renderPreview("encrypted");
    act(() => {
      h.result.current.form.setValue("header.subtitle", "encrypted edit");
    });
    await flushPreview();

    expect(h.saveCurrentDocument).not.toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.onDirtyChange).toHaveBeenCalledWith(true);
    expect(renderTypstSvg).toHaveBeenCalledTimes(1);
  });

  it("marks invalid form data as an error without saving or rendering", async () => {
    const h = renderPreview("local");
    act(() => {
      h.result.current.form.setValue("schemaVersion", 999 as never);
    });
    await flushPreview();

    expect(h.saveCurrentDocument).not.toHaveBeenCalled();
    expect(renderTypstSvg).not.toHaveBeenCalled();
    expect(h.result.current.preview.status).toBe("error");
  });
});

describe("useCvPreview render ownership", () => {
  it("does not let a stale render completion overwrite the newer render", async () => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    vi.mocked(renderTypstSvg)
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const h = renderPreview("encrypted");

    await flushPreview();
    expect(renderTypstSvg).toHaveBeenCalledTimes(1);

    act(() => {
      h.result.current.form.setValue("header.subtitle", "newer render");
    });
    await flushPreview();
    expect(renderTypstSvg).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve("<svg>newer</svg>");
      await second.promise;
    });
    expect(h.result.current.preview.svg).toBe("<svg>newer</svg>");

    await act(async () => {
      first.resolve("<svg>stale</svg>");
      await first.promise;
    });
    expect(h.result.current.preview.svg).toBe("<svg>newer</svg>");
  });
});
