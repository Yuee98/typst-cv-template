// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCvExport } from "@/components/cv-builder/hooks/use-cv-export";
import {
  downloadCvJson,
  downloadCvPdf,
  downloadTypstPackage,
  downloadTypstSource,
} from "@/lib/cv/export-utils";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";

vi.mock("@/lib/cv/export-utils", () => ({
  downloadCvJson: vi.fn(),
  downloadCvPdf: vi.fn(),
  downloadTypstPackage: vi.fn(),
  downloadTypstSource: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function renderExport({ canExport = true }: { canExport?: boolean } = {}) {
  const data = cloneCvData(sampleCvDataEn);
  const getCurrentData = vi.fn(() => data);
  const getDownloadTitle = vi.fn(() => "Candidate");
  const onImportExportError = vi.fn();
  const onPreviewError = vi.fn();
  const hook = renderHook(() =>
    useCvExport({
      canExport: vi.fn(() => canExport),
      getCurrentData,
      getDownloadTitle,
      locale: "en",
      onImportExportError,
      onPreviewError,
    }),
  );

  return {
    data,
    getCurrentData,
    getDownloadTitle,
    hook,
    onImportExportError,
    onPreviewError,
  };
}

describe("useCvExport", () => {
  it("does not read or download data when the export gate rejects", async () => {
    const h = renderExport({ canExport: false });

    await act(async () => {
      await h.hook.result.current.downloadPdf();
      await h.hook.result.current.exportDocument();
      await h.hook.result.current.exportTypstPackage();
      await h.hook.result.current.exportTypstSource();
    });

    expect(h.getCurrentData).not.toHaveBeenCalled();
    expect(downloadCvPdf).not.toHaveBeenCalled();
    expect(downloadCvJson).not.toHaveBeenCalled();
    expect(downloadTypstPackage).not.toHaveBeenCalled();
    expect(downloadTypstSource).not.toHaveBeenCalled();
  });

  it("exposes PDF progress until the renderer settles", async () => {
    let resolvePdf!: () => void;
    vi.mocked(downloadCvPdf).mockReturnValueOnce(new Promise<void>((resolve) => {
      resolvePdf = resolve;
    }));
    const h = renderExport();

    let exportPromise!: Promise<void>;
    act(() => {
      exportPromise = h.hook.result.current.downloadPdf();
    });
    await waitFor(() => expect(h.hook.result.current.exportingFormat).toBe("pdf"));
    expect(h.onPreviewError).toHaveBeenCalledWith(null);

    await act(async () => {
      resolvePdf();
      await exportPromise;
    });

    expect(downloadCvPdf).toHaveBeenCalledWith(h.data, "Candidate", "en");
    expect(h.hook.result.current.exportingFormat).toBeNull();
  });

  it("routes PDF errors to preview feedback and always clears progress", async () => {
    vi.mocked(downloadCvPdf).mockRejectedValueOnce(new Error("PDF failed"));
    const h = renderExport();

    await act(async () => h.hook.result.current.downloadPdf());

    expect(h.onPreviewError).toHaveBeenCalledWith("PDF failed");
    expect(h.onImportExportError).not.toHaveBeenCalled();
    expect(h.hook.result.current.exportingFormat).toBeNull();
  });

  it("routes JSON and Typst source errors to import/export feedback", async () => {
    vi.mocked(downloadCvJson).mockImplementationOnce(() => {
      throw new Error("JSON failed");
    });
    vi.mocked(downloadTypstSource).mockImplementationOnce(() => {
      throw new Error("Typst failed");
    });
    const h = renderExport();

    await act(async () => h.hook.result.current.exportDocument());
    await act(async () => h.hook.result.current.exportTypstSource());

    expect(h.onImportExportError).toHaveBeenNthCalledWith(1, "JSON failed");
    expect(h.onImportExportError).toHaveBeenNthCalledWith(2, "Typst failed");
    expect(h.hook.result.current.exportingFormat).toBeNull();
  });

  it("passes the current data, title, and locale to the Typst package exporter", async () => {
    vi.mocked(downloadTypstPackage).mockResolvedValueOnce(undefined);
    const h = renderExport();

    await act(async () => h.hook.result.current.exportTypstPackage());

    expect(downloadTypstPackage).toHaveBeenCalledWith(h.data, "Candidate", "en");
    expect(h.onImportExportError).not.toHaveBeenCalled();
    expect(h.hook.result.current.exportingFormat).toBeNull();
  });
});
