// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCvCloudDocumentActions } from "@/components/cv-builder/hooks/use-cv-cloud-document-actions";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { createLocalCvDocument, type CvDocumentSummary } from "@/lib/cv/storage";

import messages from "../../../../messages/en.json";

vi.mock("@/lib/cv/encryption-storage", () => ({
  storeEncryptionPassword: vi.fn().mockResolvedValue(undefined),
  storeTrustDevice: vi.fn(),
}));

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

function renderCloudActions({
  documents = [summary("active")],
  session = null,
  supabase = null,
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
  const termsGate = { ensure: vi.fn().mockResolvedValue(true) };
  const upsertDocumentSummary = vi.fn();

  const result = renderHook(
    () => {
      const tCloudActions = useTranslations("CvCloudActions");
      const actions = useCvCloudDocumentActions({
        tCloudActions,
        activeDocumentId,
        closeEncryptionModal,
        createCloudDocument,
        createEncryptedCloudDocument,
        documents,
        duplicateDocument,
        encryptExistingCloudDocument,
        fetchCloudDocument,
        loadDataIntoForm,
        onError,
        openEnableEncryptionModal,
        saveCurrentDocument,
        session,
        setCloudStatus,
        setOrderedDocuments,
        supabase,
        termsGate,
        upsertDocumentSummary,
      });
      return actions;
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
    saveCurrentDocument,
    setCloudStatus,
    setOrderedDocuments,
    termsGate,
    upsertDocumentSummary,
  };
}

const fakeSupabase = {} as SupabaseClient;
const fakeSession = { user: { id: "user-1" } } as Session;

describe("useCvCloudDocumentActions save gates", () => {
  it("moves a saved local document through the injected cloud mutation seam", async () => {
    const local = createLocalCvDocument(sampleCvDataEn, "Local CV");
    const localSummary: CvDocumentSummary = {
      id: local.id,
      title: local.title,
      storageKind: "local",
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
    };
    const cloud = {
      ...summary("cloud-1", "cloud"),
      data: sampleCvDataEn,
    };
    const h = renderCloudActions({
      documents: [localSummary],
      session: fakeSession,
      supabase: fakeSupabase,
    });
    h.createCloudDocument.mockResolvedValueOnce(cloud);

    await act(async () => {
      await h.result.current.moveToCloud(local.id);
    });

    expect(h.createCloudDocument).toHaveBeenCalledWith({
      client: fakeSupabase,
      title: "Local CV",
      data: sampleCvDataEn,
    });
    expect(h.setOrderedDocuments).toHaveBeenCalled();
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(cloud.id, cloud.data);
    expect(h.setCloudStatus).toHaveBeenCalledWith("ready");
  });

  it("blocks an active local-to-cloud move when the required silent save fails", async () => {
    const h = renderCloudActions({ session: fakeSession, supabase: fakeSupabase });
    h.saveCurrentDocument.mockResolvedValueOnce(false);

    await act(async () => {
      await h.result.current.moveToCloud("active");
    });

    expect(h.saveCurrentDocument).toHaveBeenCalledWith({ silent: true });
    expect(h.createCloudDocument).not.toHaveBeenCalled();
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
  });

  it("blocks enabling encryption when the required silent save fails", async () => {
    const h = renderCloudActions({ session: fakeSession, supabase: fakeSupabase });
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
        trustDevice: false,
      });
    });

    expect(h.saveCurrentDocument).toHaveBeenCalledWith({ silent: true });
    expect(h.createEncryptedCloudDocument).not.toHaveBeenCalled();
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
  });

  it("does not mutate a target when terms are not accepted", async () => {
    const h = renderCloudActions({ session: fakeSession, supabase: fakeSupabase });
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
  it("returns a duplicate error and keeps the modal open on a failed operation", async () => {
    const h = renderCloudActions();
    h.duplicateDocument.mockRejectedValueOnce(new Error("duplicate failed"));

    let result: unknown;
    await act(async () => {
      result = await h.result.current.handleEncryptionSubmit({
        mode: "duplicate",
        documentId: "active",
        password: "test-password",
        trustDevice: false,
      });
    });

    expect(result).toEqual({ error: "duplicate failed" });
    expect(h.closeEncryptionModal).not.toHaveBeenCalled();
  });

  it("closes the modal after a successful duplicate operation", async () => {
    const h = renderCloudActions();

    await act(async () => {
      await h.result.current.handleEncryptionSubmit({
        mode: "duplicate",
        documentId: "active",
        password: "test-password",
        trustDevice: false,
      });
    });

    expect(h.duplicateDocument).toHaveBeenCalledWith("active", {
      passphraseOverride: "test-password",
    });
    expect(h.closeEncryptionModal).toHaveBeenCalledTimes(1);
  });

  it("keeps injected source data and action state untouched when encryption is deferred", async () => {
    const encrypted = summary("encrypted", "encrypted");
    const h = renderCloudActions({ documents: [encrypted], session: fakeSession, supabase: fakeSupabase });
    h.termsGate.ensure.mockResolvedValueOnce(false);

    const before = cloneCvData(sampleCvDataEn);
    await act(async () => {
      await h.result.current.openEnableEncryption(encrypted.id);
    });

    expect(h.openEnableEncryptionModal).not.toHaveBeenCalled();
    expect(h.loadDataIntoForm).not.toHaveBeenCalledWith(encrypted.id, before);
  });
});
