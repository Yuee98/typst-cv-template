// @vitest-environment jsdom

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCvAuthActions } from "@/components/cv-builder/hooks/use-cv-auth-actions";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { clearEncryptionPasswords } from "@/lib/cv/encryption-storage";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";

import messages from "../../../../messages/en.json";

vi.mock("@/lib/cv/encryption-storage", () => ({
  clearEncryptionPasswords: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/en");
});

function summary(id: string, storageKind: CvDocumentSummary["storageKind"]): CvDocumentSummary {
  return {
    id,
    title: `${id} title`,
    storageKind,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

const session = { user: { id: "user-1" } } as Session;

function renderAuthActions({
  activeDocument = summary("local-1", "local"),
  documents = [summary("local-1", "local")],
  email = "person@example.com",
  mode = "signIn" as "signIn" | "signUp",
  password = "test-password",
  sessionValue = null as Session | null,
  supabaseValue,
  termsAccepted = true,
}: {
  activeDocument?: CvDocumentSummary | null;
  documents?: CvDocumentSummary[];
  email?: string;
  mode?: "signIn" | "signUp";
  password?: string;
  sessionValue?: Session | null;
  supabaseValue?: SupabaseClient | null;
  termsAccepted?: boolean;
} = {}) {
  const auth = {
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signUp: vi.fn().mockResolvedValue({
      data: { session: null, user: { id: "pending-user" } },
      error: null,
    }),
    signInWithOAuth: vi.fn().mockResolvedValue({ data: {}, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  const supabase = supabaseValue === undefined
    ? ({ auth } as unknown as SupabaseClient)
    : supabaseValue;
  const authModal = {
    closeAfterAuth: vi.fn(),
    email,
    mode,
    password,
    setError: vi.fn(),
    setSuccessMessage: vi.fn(),
    termsAccepted,
  };
  const closeEncryptionModal = vi.fn();
  const loadDataIntoForm = vi.fn();
  const setOrderedDocuments = vi.fn();
  const termsGate = {
    clearPendingAcceptance: vi.fn(),
    markPendingAcceptance: vi.fn(),
    recordAccepted: vi.fn().mockResolvedValue(undefined),
  };

  const result = renderHook(
    () => {
      const form = useForm<CvData>({ defaultValues: cloneCvData(sampleCvDataEn) });
      return {
        actions: useCvAuthActions({
          activeDocument,
          authModal,
          closeEncryptionModal,
          documents,
          form,
          loadDataIntoForm,
          session: sessionValue,
          setOrderedDocuments,
          supabase,
          termsGate,
        }),
        form,
      };
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
    auth,
    authModal,
    closeEncryptionModal,
    loadDataIntoForm,
    result: result.result,
    setOrderedDocuments,
    supabase,
    termsGate,
  };
}

describe("useCvAuthActions sign-in and sign-up", () => {
  it("validates sign-in prerequisites and reports provider failures", async () => {
    const missingConfig = renderAuthActions({ supabaseValue: null });
    const missingFields = renderAuthActions({ email: "", password: "" });
    const providerFailure = renderAuthActions();
    providerFailure.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: new Error("bad credentials"),
    });

    await act(async () => missingConfig.result.current.actions.signIn());
    await act(async () => missingFields.result.current.actions.signIn());
    await act(async () => providerFailure.result.current.actions.signIn());

    expect(missingConfig.authModal.setError).toHaveBeenCalledWith(messages.CvAuthActions.supabaseNotConfigured);
    expect(missingFields.authModal.setError).toHaveBeenCalledWith(messages.CvAuthActions.signInMissingFields);
    expect(providerFailure.authModal.setError).toHaveBeenCalledWith("bad credentials");
    expect(providerFailure.authModal.closeAfterAuth).not.toHaveBeenCalled();
  });

  it("closes the modal only after a successful password sign-in", async () => {
    const h = renderAuthActions();

    await act(async () => h.result.current.actions.signIn());

    expect(h.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "test-password",
    });
    expect(h.termsGate.clearPendingAcceptance).toHaveBeenCalledTimes(1);
    expect(h.authModal.closeAfterAuth).toHaveBeenCalledTimes(1);
  });

  it("requires terms before sign-up and clears pending acceptance on provider failure", async () => {
    const unchecked = renderAuthActions({ mode: "signUp", termsAccepted: false });
    const failed = renderAuthActions({ mode: "signUp" });
    failed.auth.signUp.mockResolvedValueOnce({ data: { session: null }, error: new Error("email rejected") });

    await act(async () => unchecked.result.current.actions.signUp());
    await act(async () => failed.result.current.actions.signUp());

    expect(unchecked.authModal.setError).toHaveBeenCalledWith(messages.CvAuthActions.termsRequired);
    expect(unchecked.termsGate.markPendingAcceptance).not.toHaveBeenCalled();
    expect(failed.termsGate.markPendingAcceptance).not.toHaveBeenCalled();
    expect(failed.termsGate.clearPendingAcceptance).toHaveBeenCalledTimes(1);
    expect(failed.authModal.setError).toHaveBeenCalledWith("email rejected");
  });

  it("records terms before closing an immediately authenticated sign-up", async () => {
    const h = renderAuthActions({ mode: "signUp" });
    h.auth.signUp.mockResolvedValueOnce({ data: { session }, error: null });

    await act(async () => h.result.current.actions.signUp());

    expect(h.auth.signUp).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "test-password",
      options: { emailRedirectTo: `${window.location.origin}/en` },
    });
    expect(h.termsGate.recordAccepted).toHaveBeenCalledWith(h.supabase, "user-1");
    expect(h.authModal.closeAfterAuth).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open with a confirmation message when sign-up has no session", async () => {
    const h = renderAuthActions({ mode: "signUp" });

    await act(async () => h.result.current.actions.signUp());

    expect(h.authModal.setError).toHaveBeenCalledWith(null);
    expect(h.authModal.setSuccessMessage).toHaveBeenCalledWith(messages.CvAuthActions.accountCreated);
    expect(h.termsGate.markPendingAcceptance).toHaveBeenCalledWith({ userId: "pending-user" });
    expect(h.termsGate.recordAccepted).not.toHaveBeenCalled();
    expect(h.authModal.closeAfterAuth).not.toHaveBeenCalled();
  });
});

describe("useCvAuthActions OAuth and sign-out boundaries", () => {
  it("clears pending sign-up acceptance when GitHub OAuth fails", async () => {
    const h = renderAuthActions({ mode: "signUp" });
    h.auth.signInWithOAuth.mockResolvedValueOnce({ data: {}, error: new Error("oauth unavailable") });

    await act(async () => h.result.current.actions.signInWithGithub());

    const pending = h.termsGate.markPendingAcceptance.mock.calls[0]?.[0];
    expect(pending).toEqual({ oauthFlowId: expect.any(String) });
    expect(h.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/en?terms_acceptance_flow=${pending.oauthFlowId}`,
      },
    });
    expect(h.termsGate.clearPendingAcceptance).toHaveBeenCalledTimes(1);
    expect(h.authModal.setError).toHaveBeenCalledWith("oauth unavailable");
  });

  it("clears an abandoned sign-up acceptance before a normal GitHub sign-in", async () => {
    const h = renderAuthActions({ mode: "signIn" });

    await act(async () => h.result.current.actions.signInWithGithub());

    expect(h.termsGate.clearPendingAcceptance).toHaveBeenCalledTimes(1);
    expect(h.termsGate.markPendingAcceptance).not.toHaveBeenCalled();
    expect(h.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/en` },
    });
  });

  it("does not clear local secrets or documents when sign-out fails", async () => {
    const h = renderAuthActions({ sessionValue: session });
    h.auth.signOut.mockResolvedValueOnce({ error: new Error("sign-out failed") });

    await act(async () => h.result.current.actions.signOut());

    expect(h.authModal.setError).toHaveBeenCalledWith("sign-out failed");
    expect(clearEncryptionPasswords).not.toHaveBeenCalled();
    expect(h.setOrderedDocuments).not.toHaveBeenCalled();
  });

  it("clears both password stores and creates a safe local fallback after cloud sign-out", async () => {
    const cloud = summary("cloud-1", "cloud");
    const h = renderAuthActions({
      activeDocument: cloud,
      documents: [cloud],
      sessionValue: session,
    });
    const edited = cloneCvData(sampleCvDataEn);
    edited.header.name = "Signed-out fallback";
    act(() => h.result.current.form.reset(edited));

    await act(async () => h.result.current.actions.signOut());

    expect(clearEncryptionPasswords).toHaveBeenNthCalledWith(1, window.sessionStorage, "user-1");
    expect(clearEncryptionPasswords).toHaveBeenNthCalledWith(2, window.localStorage, "user-1");
    expect(h.closeEncryptionModal).toHaveBeenCalledTimes(1);
    expect(h.setOrderedDocuments).toHaveBeenCalledWith([
      expect.objectContaining({ storageKind: "local", title: "cloud-1 title" }),
    ]);
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(expect.any(String), edited);
  });
});
