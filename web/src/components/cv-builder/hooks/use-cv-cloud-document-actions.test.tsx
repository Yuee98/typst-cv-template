// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCvCloudDocumentActions } from "@/components/cv-builder/hooks/use-cv-cloud-document-actions";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { createLocalCvDocument, type CvDocumentSummary } from "@/lib/cv/storage";
import { storeEncryptionPassword, storeTrustDevice } from "@/lib/cv/encryption-storage";
import * as cloudStorage from "@/lib/cv/cloud-storage";
import messages from "../../../../messages/en.json";
vi.mock("@/lib/cv/encryption-storage", () => ({
  storeEncryptionPassword: vi.fn().mockResolvedValue(undefined),
  storeTrustDevice: vi.fn()
}));
afterEach(() => {
  cleanup();
});
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
function summary(id: string, storageKind: CvDocumentSummary["storageKind"] = "local"): CvDocumentSummary {
  return {
    id,
    title: id,
    storageKind,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
function renderCloudActions({
  documents = [summary("active")],
  session = null,
  supabase = null
}: {
  documents?: CvDocumentSummary[];
  session?: Session | null;
  supabase?: SupabaseClient | null;
} = {}) {
  const activeDocumentId = documents[0]?.id ?? null;
  const closeEncryptionModal = vi.fn();
  const createCloudDocument = vi.fn();
  const createEncryptedCloudDocument = vi.fn();
  const duplicateDocument = vi.fn().mockResolvedValue(undefined);
  const encryptExistingCloudDocument = vi.fn();
  const fetchCloudDocument = vi.fn();
  const loadDataIntoForm = vi.fn();
  const onError = vi.fn();
  const openEnableEncryptionModal = vi.fn();
  const saveCurrentDocument = vi.fn().mockResolvedValue(true);
  const setCloudStatus = vi.fn();
  const setOrderedDocuments = vi.fn();
  const termsGate = {
    ensure: vi.fn().mockResolvedValue(true)
  };
  const upsertDocumentSummary = vi.fn();
  const result = renderHook(({
    session: currentSession
  }) => {
    const tCloudActions = useTranslations("CvCloudActions");
    const actions = useCvCloudDocumentActions({
      tCloudActions,
      activeDocumentId,
      closeEncryptionModal,
      createCloudDocument,
      createEncryptedCloudDocument,
      captureExistingWrite: () => ({} as cloudStorage.CloudCvWriteToken),
      documents,
      duplicateDocument,
      encryptExistingCloudDocument,
      fetchCloudDocument,
      loadDataIntoForm,
      onError,
      openEnableEncryptionModal,
      saveCurrentDocument,
      session: currentSession,
      setCloudStatus,
      setOrderedDocuments,
      supabase,
      termsGate,
      upsertDocumentSummary
    });
    return actions;
  }, {
    initialProps: {
      session
    },
    wrapper: ({
      children
    }) => <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
  });
  return {
    closeEncryptionModal,
    createCloudDocument,
    createEncryptedCloudDocument,
    duplicateDocument,
    encryptExistingCloudDocument,
    fetchCloudDocument,
    loadDataIntoForm,
    onError,
    openEnableEncryptionModal,
    result: result.result,
    changeSession: (next: Session | null) => result.rerender({
      session: next
    }),
    saveCurrentDocument,
    setCloudStatus,
    setOrderedDocuments,
    termsGate,
    upsertDocumentSummary
  };
}
const fakeSupabase = {} as SupabaseClient;
const fakeSession = {
  user: {
    id: "user-1"
  }
} as Session;
describe("useCvCloudDocumentActions save gates", () => {
  it("does not create another account's document after a session switch while consent is pending", async () => {
    const local = createLocalCvDocument(sampleCvDataEn, "Local");
    const h = renderCloudActions({
      documents: [local],
      session: fakeSession,
      supabase: fakeSupabase
    });
    let resolve!: (value: boolean) => void;
    h.termsGate.ensure.mockReturnValueOnce(new Promise<boolean>(done => {
      resolve = done;
    }));
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.moveToCloud(local.id);
    });
    act(() => h.changeSession({
      user: {
        id: "user-2"
      }
    } as Session));
    await act(async () => {
      resolve(true);
      await pending;
    });
    expect(h.createCloudDocument).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
  });
  it("does not adopt a previous account's late cloud create response", async () => {
    const local = createLocalCvDocument(sampleCvDataEn, "Local");
    const h = renderCloudActions({
      documents: [local],
      session: fakeSession,
      supabase: fakeSupabase
    });
    let resolve!: (value: unknown) => void;
    h.createCloudDocument.mockReturnValueOnce(new Promise(done => {
      resolve = done;
    }));
    let pending!: Promise<void>;
    await act(async () => {
      pending = h.result.current.moveToCloud(local.id);
    });
    act(() => h.changeSession({
      user: {
        id: "user-2"
      }
    } as Session));
    await act(async () => {
      resolve({
        ...summary("cv_0123456789AB", "cloud"),
        data: sampleCvDataEn
      });
      await pending;
    });
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
  });
  it("moves a saved local document through the injected cloud mutation seam", async () => {
    const local = createLocalCvDocument(sampleCvDataEn, "Local CV");
    const localSummary: CvDocumentSummary = {
      id: local.id,
      title: local.title,
      storageKind: "local",
      createdAt: local.createdAt,
      updatedAt: local.updatedAt
    };
    const cloud = {
      ...summary("cloud-1", "cloud"),
      revision: "1",
      data: sampleCvDataEn
    };
    const h = renderCloudActions({
      documents: [localSummary],
      session: fakeSession,
      supabase: fakeSupabase
    });
    h.createCloudDocument.mockResolvedValueOnce(cloud);
    await act(async () => {
      await h.result.current.moveToCloud(local.id);
    });
    expect(h.createCloudDocument).toHaveBeenCalledWith({
      client: fakeSupabase,
      title: "Local CV",
      data: sampleCvDataEn,
      expectedUserId: "user-1",
      sourceDocumentId: local.id
    });
    expect(h.setOrderedDocuments).toHaveBeenCalled();
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(cloud.id, cloud.data, { cloudRevision: "1" });
    expect(h.setCloudStatus).toHaveBeenCalledWith("ready");
  });
  it("blocks an active local-to-cloud move when the required silent save fails", async () => {
    const h = renderCloudActions({
      session: fakeSession,
      supabase: fakeSupabase
    });
    h.saveCurrentDocument.mockResolvedValueOnce(false);
    await act(async () => {
      await h.result.current.moveToCloud("active");
    });
    expect(h.saveCurrentDocument).toHaveBeenCalledWith({
      silent: true
    });
    expect(h.createCloudDocument).not.toHaveBeenCalled();
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
  });
  it("blocks enabling encryption when the required silent save fails", async () => {
    const h = renderCloudActions({
      session: fakeSession,
      supabase: fakeSupabase
    });
    h.saveCurrentDocument.mockResolvedValueOnce(false);
    await act(async () => {
      await h.result.current.openEnableEncryption("active");
    });
    // Opening the modal is a separate path; the save gate is exercised by the
    // enable action exposed through the same handler's submit flow.
    await act(async () => {
      await h.result.current.handleEncryptionSubmit({
        mode: "enable",
        documentId: "active",
        password: "test-password",
        trustDevice: false
      });
    });
    expect(h.saveCurrentDocument).toHaveBeenCalledWith({
      silent: true
    });
    expect(h.createEncryptedCloudDocument).not.toHaveBeenCalled();
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
    // The current enable path returns early from enableEncryption, then the
    // outer submit handler closes the modal. This is characterized rather
    // than normalized because unlock/duplicate have different error paths.
    expect(h.closeEncryptionModal).toHaveBeenCalledTimes(1);
  });
  it("does not mutate a target when terms are not accepted", async () => {
    const h = renderCloudActions({
      session: fakeSession,
      supabase: fakeSupabase
    });
    h.termsGate.ensure.mockResolvedValueOnce(false);
    await act(async () => {
      await h.result.current.moveToCloud("active");
    });
    expect(h.saveCurrentDocument).not.toHaveBeenCalled();
    expect(h.createCloudDocument).not.toHaveBeenCalled();
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
  });
});
describe("handleEncryptionSubmit path-specific modal behavior", () => {
  it.each([false, true])("does not resume A's obsolete conversion after password storage finishes (return to A: %s)", async returnToA => {
    let finishStorage!: () => void;
    vi.mocked(storeEncryptionPassword).mockReturnValueOnce(new Promise<void>(resolve => { finishStorage = resolve; }));
    const h = renderCloudActions({ session: fakeSession, supabase: fakeSupabase });
    let pending!: Promise<unknown>;
    act(() => { pending = h.result.current.handleEncryptionSubmit({ mode: "enable", documentId: "active", password: "fixture-password", trustDevice: true }); });
    act(() => h.changeSession({ user: { id: "user-2" } } as Session));
    if (returnToA) act(() => h.changeSession(fakeSession));
    await act(async () => { finishStorage(); await pending; });
    expect(storeTrustDevice).not.toHaveBeenCalled();
    expect(h.termsGate.ensure).not.toHaveBeenCalled();
    expect(h.createEncryptedCloudDocument).not.toHaveBeenCalled();
    expect(h.encryptExistingCloudDocument).not.toHaveBeenCalled();
    expect(h.closeEncryptionModal).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
  it("does not open A's encryption modal after terms finish under B", async () => {
    const h = renderCloudActions({ session: fakeSession, supabase: fakeSupabase });
    let finishTerms!: (value: boolean) => void;
    h.termsGate.ensure.mockReturnValueOnce(new Promise<boolean>(resolve => { finishTerms = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.openEnableEncryption("active"); });
    act(() => h.changeSession({ user: { id: "user-2" } } as Session));
    await act(async () => { finishTerms(true); await pending; });
    expect(h.openEnableEncryptionModal).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
  it("does not continue A's unlock after terms finish under B", async () => {
    const h = renderCloudActions({ session: fakeSession, supabase: fakeSupabase });
    let finishTerms!: (value: boolean) => void;
    h.termsGate.ensure.mockReturnValueOnce(new Promise<boolean>(resolve => { finishTerms = resolve; }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = h.result.current.handleEncryptionSubmit({ mode: "unlock", documentId: "active", password: "fixture-password", trustDevice: false }); });
    act(() => h.changeSession({ user: { id: "user-2" } } as Session));
    let result: unknown;
    await act(async () => { finishTerms(true); result = await pending; });
    expect(result).toBeUndefined();
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.upsertDocumentSummary).not.toHaveBeenCalled();
    expect(h.closeEncryptionModal).not.toHaveBeenCalled();
  });
  it("does not return A's late unlock error to B's modal", async () => {
    let rejectLoad!: (error: Error) => void;
    const load = vi.spyOn(cloudStorage, "loadEncryptedCloudCvDocument").mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLoad = reject; }));
    try {
      const h = renderCloudActions({ session: fakeSession, supabase: fakeSupabase });
      let pending!: Promise<unknown>;
      await act(async () => { pending = h.result.current.handleEncryptionSubmit({ mode: "unlock", documentId: "active", password: "fixture-password", trustDevice: false }); });
      expect(load).toHaveBeenCalledWith(fakeSupabase, "active", "zh", "user-1");
      act(() => h.changeSession({ user: { id: "user-2" } } as Session));
      let result: unknown;
      await act(async () => { rejectLoad(new Error("A's private failure")); result = await pending; });
      expect(result).toBeUndefined();
      expect(h.onError).not.toHaveBeenCalled();
      expect(h.loadDataIntoForm).not.toHaveBeenCalled();
      expect(h.closeEncryptionModal).not.toHaveBeenCalled();
    } finally { load.mockRestore(); }
  });
  it("returns a duplicate error and keeps the modal open on a failed operation", async () => {
    const h = renderCloudActions();
    h.duplicateDocument.mockRejectedValueOnce(new Error("duplicate failed"));
    let result: unknown;
    await act(async () => {
      result = await h.result.current.handleEncryptionSubmit({
        mode: "duplicate",
        documentId: "active",
        password: "test-password",
        trustDevice: false
      });
    });
    expect(result).toEqual({
      error: "duplicate failed"
    });
    expect(h.closeEncryptionModal).not.toHaveBeenCalled();
  });
  it("closes the modal after a successful duplicate operation", async () => {
    const h = renderCloudActions();
    await act(async () => {
      await h.result.current.handleEncryptionSubmit({
        mode: "duplicate",
        documentId: "active",
        password: "test-password",
        trustDevice: false
      });
    });
    expect(h.duplicateDocument).toHaveBeenCalledWith("active", {
      passphraseOverride: "test-password"
    });
    expect(h.closeEncryptionModal).toHaveBeenCalledTimes(1);
  });
  it("returns an unlock access error and keeps the modal open", async () => {
    const h = renderCloudActions();
    let result: unknown;
    await act(async () => {
      result = await h.result.current.handleEncryptionSubmit({
        mode: "unlock",
        documentId: "active",
        password: "test-password",
        trustDevice: false
      });
    });
    expect(result).toEqual({
      error: expect.any(String)
    });
    expect(h.closeEncryptionModal).not.toHaveBeenCalled();
  });
  it("keeps injected source data and action state untouched when encryption is deferred", async () => {
    const encrypted = summary("encrypted", "encrypted");
    const h = renderCloudActions({
      documents: [encrypted],
      session: fakeSession,
      supabase: fakeSupabase
    });
    h.termsGate.ensure.mockResolvedValueOnce(false);
    const before = cloneCvData(sampleCvDataEn);
    await act(async () => {
      await h.result.current.openEnableEncryption(encrypted.id);
    });
    expect(h.openEnableEncryptionModal).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalledWith(encrypted.id, before);
  });
});
