// @vitest-environment jsdom

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCvBuilder } from "./use-cv-builder";
import { createEmptyCvData } from "@/lib/cv/cv-utils";
import { captureEncryptionPasswordOwner, clearUserEncryptionPasswords } from "@/lib/cv/encryption-storage";
import { createLocalCvDocument, loadCvDocument, saveActiveCvDocumentId } from "@/lib/cv/storage";
import type { CloudCvDocument } from "@/lib/cv/cloud-storage";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import messages from "../../../../messages/en.json";

const io = vi.hoisted(() => ({
  userId: "fixture-owner" as string | null,
  client: {} as SupabaseClient,
  list: vi.fn(),
  load: vi.fn(),
  activate: vi.fn(),
  resetTerms: vi.fn(),
  refreshTerms: vi.fn().mockResolvedValue(true),
  ensureTerms: vi.fn().mockResolvedValue(true),
  resetPreview: vi.fn(),
  setPreviewError: vi.fn(),
  renderPdf: vi.fn(),
  fetchStyle: vi.fn()
}));

// Only transport/auth and preview rendering are replaced. Builder, form,
// local-library restoration, queries, cloud adoption and exports remain real.
vi.mock("@/components/cv-builder/hooks/use-cloud-session", () => ({
  useCloudSession() {
    const [cloudStatus, setCloudStatus] = useState("ready");
    return { cloudStatus, setCloudStatus, session: io.userId ? { user: { id: io.userId } } as Session : null, sessionInitialized: true, supabase: io.client };
  }
}));
vi.mock("@/components/cv-builder/hooks/use-terms-gate", () => ({
  useTermsGate: () => ({ status: "accepted", reset: io.resetTerms, refresh: io.refreshTerms, ensure: io.ensureTerms })
}));
vi.mock("@/components/cv-builder/hooks/use-cv-preview", () => ({
  useCvPreview: () => ({ svg: null, status: "idle", percent: null, error: null, reset: io.resetPreview, resetForFormLoad: io.resetPreview, setError: io.setPreviewError })
}));
vi.mock("@/lib/cv/cloud-storage", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/cv/cloud-storage")>(),
  listCloudCvDocuments: io.list,
  loadCloudCvDocument: io.load,
  cloudDocumentOwner: () => io.userId,
  activateCloudDocument: io.activate
}));
vi.mock("@/lib/typst/render", () => ({ renderTypstPdf: io.renderPdf, fetchStyleSource: io.fetchStyle, addFontFromData: vi.fn() }));

const summary: CvDocumentSummary = {
  id: "cv_0123456789AB", title: "Restored remote document", storageKind: "cloud",
  createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z"
};
let queries: QueryClient;
let blobs: Blob[];
let finishLoad: (document: CloudCvDocument) => void;

beforeEach(() => {
  vi.clearAllMocks();
  io.userId = "fixture-owner";
  io.renderPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  io.fetchStyle.mockResolvedValue("#let template = true");
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem("typst-cv-builder:documents:index", JSON.stringify({ version: 1, documents: [summary] }));
  window.localStorage.setItem("typst-cv-builder:documents:active", summary.id);
  io.list.mockResolvedValue([summary]);
  const pending = new Promise<CloudCvDocument>(resolve => { finishLoad = resolve; });
  io.load.mockReturnValue(pending);
  queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  blobs = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:export-fixture"; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); queries.clear(); vi.restoreAllMocks(); });

function renderBuilder() {
  return renderHook(() => useCvBuilder(), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queries}><NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider></QueryClientProvider>
  });
}
function loadedDocument(): CloudCvDocument {
  const data = createEmptyCvData("en");
  data.header.name = "Actual remote body";
  return { ...summary, storageKind: "cloud", revision: "1", data };
}
function jsonBlob(blob: Blob): Promise<{ header: { name: string } }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(JSON.parse(reader.result as string));
    reader.readAsText(blob);
  });
}

describe("builder exports during restored cloud-body loading", () => {
  it.each(["downloadPdf", "exportDocument", "exportTypstPackage", "exportTypstSource"] as const)("blocks %s before the restored remote body is adopted", async action => {
    const hook = renderBuilder();
    await waitFor(() => expect(hook.result.current.activeDocument?.id).toBe(summary.id));
    await waitFor(() => expect(io.load).toHaveBeenCalled());
    expect(io.activate).not.toHaveBeenCalled();
    expect(hook.result.current.exportReady).toBe(false);
    await act(async () => { await hook.result.current[action](); });
    expect(blobs).toHaveLength(0);
    expect(io.renderPdf).not.toHaveBeenCalled();
    expect(io.fetchStyle).not.toHaveBeenCalled();
  });

  it.each([
    ["downloadPdf", "application/pdf"],
    ["exportDocument", "application/json"],
    ["exportTypstPackage", "application/zip"],
    ["exportTypstSource", "text/plain;charset=utf-8"],
  ] as const)("allows %s after the exact remote body is adopted, without waiting for SVG", async (action, mime) => {
    const hook = renderBuilder();
    await waitFor(() => expect(io.load).toHaveBeenCalled());
    await act(async () => { finishLoad(loadedDocument()); });
    await waitFor(() => expect(hook.result.current.form.getValues().header.name).toBe("Actual remote body"));
    expect(io.activate).toHaveBeenCalledWith(io.client, summary.id, "1");
    expect(hook.result.current.exportReady).toBe(true);
    expect(hook.result.current.svg).toBeNull();
    await act(async () => { await hook.result.current[action](); });
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe(mime);
    if (action === "exportDocument") expect((await jsonBlob(blobs[0])).header.name).toBe("Actual remote body");
    if (action === "downloadPdf") expect(io.renderPdf.mock.calls[0][0]).toContain("Actual remote body");
  });

  it("keeps all four exports available for an adopted anonymous local document without a preview", async () => {
    io.userId = null;
    window.localStorage.clear();
    const local = createLocalCvDocument(createEmptyCvData("en"), "Anonymous local");
    saveActiveCvDocumentId(local.id);
    const hook = renderBuilder();
    await waitFor(() => expect(hook.result.current.activeDocumentId).toBe(local.id));
    expect(hook.result.current.svg).toBeNull();
    expect(hook.result.current.exportReady).toBe(true);
    await act(async () => {
      await hook.result.current.downloadPdf();
      await hook.result.current.exportDocument();
      await hook.result.current.exportTypstPackage();
      await hook.result.current.exportTypstSource();
    });
    expect(blobs.map(blob => blob.type)).toEqual(["application/pdf", "application/json", "application/zip", "text/plain;charset=utf-8"]);
  });

  it("drops a compiled PDF when synchronous sign-out revokes the owner, even if the same account returns before render", async () => {
    let finishPdf!: (value: Uint8Array) => void;
    io.renderPdf.mockReturnValue(new Promise<Uint8Array>(resolve => { finishPdf = resolve; }));
    const hook = renderBuilder();
    await waitFor(() => expect(io.load).toHaveBeenCalled());
    await act(async () => { finishLoad(loadedDocument()); });
    await waitFor(() => expect(hook.result.current.form.getValues().header.name).toBe("Actual remote body"));
    let task!: Promise<void>;
    act(() => { task = hook.result.current.downloadPdf(); });
    await waitFor(() => expect(io.renderPdf).toHaveBeenCalled());
    // The shared Auth cleanup revokes synchronously, including A -> null -> A
    // when React batches both notifications without an intermediate render.
    clearUserEncryptionPasswords(io.userId!);
    expect(captureEncryptionPasswordOwner(io.userId!)()).toBe(true);
    await act(async () => { finishPdf(new Uint8Array([37, 80, 68, 70])); await task; });
    expect(blobs).toHaveLength(0);
  });

  it("drops a ZIP after a different form adoption, even when the source document is selected again", async () => {
    io.userId = null;
    window.localStorage.clear();
    const first = createLocalCvDocument(createEmptyCvData("en"), "First local");
    const second = createLocalCvDocument(createEmptyCvData("en"), "Second local");
    saveActiveCvDocumentId(first.id);
    let finishStyle!: (style: string) => void;
    io.fetchStyle.mockReturnValue(new Promise<string>(resolve => { finishStyle = resolve; }));
    const hook = renderBuilder();
    await waitFor(() => expect(hook.result.current.activeDocumentId).toBe(first.id));
    let task!: Promise<void>;
    act(() => { task = hook.result.current.exportTypstPackage(); });
    await waitFor(() => expect(io.fetchStyle).toHaveBeenCalled());
    await act(async () => { await hook.result.current.selectDocument(second.id); });
    expect(hook.result.current.activeDocumentId).toBe(second.id);
    await act(async () => { await hook.result.current.selectDocument(first.id); });
    expect(hook.result.current.activeDocumentId).toBe(first.id);
    await act(async () => { finishStyle("#let template = true"); await task; });
    expect(blobs).toHaveLength(0);
  });

  it("does not download a pending ZIP after its editor has unmounted", async () => {
    io.userId = null;
    window.localStorage.clear();
    const local = createLocalCvDocument(createEmptyCvData("en"), "Local source");
    saveActiveCvDocumentId(local.id);
    let finishStyle!: (style: string) => void;
    io.fetchStyle.mockReturnValue(new Promise<string>(resolve => { finishStyle = resolve; }));
    const hook = renderBuilder();
    await waitFor(() => expect(hook.result.current.activeDocumentId).toBe(local.id));
    let task!: Promise<void>;
    act(() => { task = hook.result.current.exportTypstPackage(); });
    await waitFor(() => expect(io.fetchStyle).toHaveBeenCalled());
    hook.unmount();
    finishStyle("#let template = true");
    await task;
    expect(blobs).toHaveLength(0);
  });

  it.each(["downloadPdf", "exportTypstPackage"] as const)("keeps %s valid when the same local form is normally persisted during generation", async action => {
    io.userId = null;
    window.localStorage.clear();
    const local = createLocalCvDocument(createEmptyCvData("en"), "Autosaved local");
    saveActiveCvDocumentId(local.id);
    let finishGeneration!: () => void;
    if (action === "downloadPdf") {
      io.renderPdf.mockReturnValue(new Promise<Uint8Array>(resolve => {
        finishGeneration = () => resolve(new Uint8Array([37, 80, 68, 70]));
      }));
    } else {
      io.fetchStyle.mockReturnValue(new Promise<string>(resolve => {
        finishGeneration = () => resolve("#let template = true");
      }));
    }
    const hook = renderBuilder();
    await waitFor(() => expect(hook.result.current.activeDocumentId).toBe(local.id));
    act(() => { hook.result.current.form.setValue("header.subtitle", "Local edit before export"); });
    let task!: Promise<void>;
    act(() => { task = hook.result.current[action](); });
    await waitFor(() => expect(action === "downloadPdf" ? io.renderPdf : io.fetchStyle).toHaveBeenCalled());
    // Run the actual persistence -> markDocumentPersisted producer used by
    // useCvPreview's 500ms local autosave, while generation is still pending.
    await act(async () => { expect(await hook.result.current.saveCurrentDocument({ silent: true })).toBe(true); });
    expect(loadCvDocument(local.id)?.data.header.subtitle).toBe("Local edit before export");
    expect(hook.result.current.activeDocumentId).toBe(local.id);
    await act(async () => { finishGeneration(); await task; });
    expect(blobs).toHaveLength(1);
  });
});
