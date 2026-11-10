// @vitest-environment jsdom

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCvAuthActions } from "@/components/cv-builder/hooks/use-cv-auth-actions";
import { cloneCvData, createEmptyCvData, summarizeLocalDocument } from "@/lib/cv/cv-utils";
import { clearEncryptionPasswords } from "@/lib/cv/encryption-storage";
import { cloudCacheScope } from "@/lib/supabase/app-context";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import { createLocalCvDocument, loadCvDocument, type CvDocumentSummary } from "@/lib/cv/storage";
import messages from "../../../../messages/en.json";
vi.mock("@/lib/cv/encryption-storage", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/cv/encryption-storage")>();
  return { ...actual, clearEncryptionPasswords: vi.fn(actual.clearEncryptionPasswords) };
});
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
    updatedAt: "2026-08-02T00:00:00.000Z"
  };
}
const session = {
  user: {
    id: "user-1"
  }
} as Session;
function renderAuthActions({
  activeDocument = summary("local-1", "local"),
  documents = [summary("local-1", "local")],
  email = "person@example.com",
  mode = "signIn" as "signIn" | "signUp",
  password = "test-password",
  sessionValue = null as Session | null,
  supabaseValue,
  termsAccepted = true
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
    signInWithPassword: vi.fn().mockResolvedValue({
      data: {
        session: null
      },
      error: null
    }),
    signUp: vi.fn().mockResolvedValue({
      data: {
        session: null,
        user: {
          id: "pending-user"
        }
      },
      error: null
    }),
    signInWithOAuth: vi.fn().mockResolvedValue({
      data: {},
      error: null
    }),
    signOut: vi.fn().mockResolvedValue({
      error: null
    })
  };
  const supabase = supabaseValue === undefined ? {
    auth
  } as unknown as SupabaseClient : supabaseValue;
  const authModal = {
    closeAfterAuth: vi.fn(),
    email,
    mode,
    password,
    setError: vi.fn(),
    setSuccessMessage: vi.fn(),
    termsAccepted
  };
  const closeEncryptionModal = vi.fn();
  const loadDataIntoForm = vi.fn();
  const setOrderedDocuments = vi.fn();
  const result = renderHook(({ selectedDocument }) => {
    const form = useForm<CvData>({
      defaultValues: cloneCvData(sampleCvDataEn)
    });
    loadDataIntoForm.mockImplementation((_id: string, data: CvData) => form.reset(data));
    return {
      actions: useCvAuthActions({
        activeDocument: selectedDocument,
        authModal,
        closeEncryptionModal,
        documents,
        form,
        loadDataIntoForm,
        session: sessionValue,
        setOrderedDocuments,
        supabase
      }),
      form
    };
  }, {
    initialProps: { selectedDocument: activeDocument },
    wrapper: ({
      children
    }) => <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
  });
  return {
    auth,
    authModal,
    closeEncryptionModal,
    loadDataIntoForm,
    result: result.result,
    selectDocument: (selectedDocument: CvDocumentSummary) => result.rerender({ selectedDocument }),
    setOrderedDocuments,
    supabase
  };
}
describe("useCvAuthActions sign-in and sign-up", () => {
  it("validates sign-in prerequisites and reports provider failures", async () => {
    const missingConfig = renderAuthActions({
      supabaseValue: null
    });
    const missingFields = renderAuthActions({
      email: "",
      password: ""
    });
    const providerFailure = renderAuthActions();
    providerFailure.auth.signInWithPassword.mockResolvedValueOnce({
      data: {
        session: null
      },
      error: new Error("bad credentials")
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
      password: "test-password"
    });
    expect(h.authModal.closeAfterAuth).toHaveBeenCalledTimes(1);
  });
  it("requires terms before sign-up and handles provider failure", async () => {
    const unchecked = renderAuthActions({
      mode: "signUp",
      termsAccepted: false
    });
    const failed = renderAuthActions({
      mode: "signUp"
    });
    failed.auth.signUp.mockResolvedValueOnce({
      data: {
        session: null
      },
      error: new Error("email rejected")
    });
    await act(async () => unchecked.result.current.actions.signUp());
    await act(async () => failed.result.current.actions.signUp());
    expect(unchecked.authModal.setError).toHaveBeenCalledWith(messages.CvAuthActions.termsRequired);
    expect(failed.authModal.setError).toHaveBeenCalledWith("email rejected");
  });
  it("closes immediate signup and leaves DB terms to the authenticated gate", async () => {
    const h = renderAuthActions({
      mode: "signUp"
    });
    h.auth.signUp.mockResolvedValueOnce({
      data: {
        session
      },
      error: null
    });
    await act(async () => h.result.current.actions.signUp());
    expect(h.auth.signUp).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "test-password",
      options: {
        emailRedirectTo: `${window.location.origin}/en`
      }
    });
    expect(h.authModal.closeAfterAuth).toHaveBeenCalledTimes(1);
  });
  it("keeps the modal open with a confirmation message when sign-up has no session", async () => {
    const h = renderAuthActions({
      mode: "signUp"
    });
    await act(async () => h.result.current.actions.signUp());
    expect(h.authModal.setError).toHaveBeenCalledWith(null);
    expect(h.authModal.setSuccessMessage).toHaveBeenCalledWith(messages.CvAuthActions.accountCreated);
    expect(h.authModal.closeAfterAuth).not.toHaveBeenCalled();
  });
});
describe("useCvAuthActions OAuth and sign-out boundaries", () => {
  it("uses a clean OAuth callback for both signup and sign-in", async () => {
    for (const mode of ["signUp", "signIn"] as const) {
      const h = renderAuthActions({
        mode
      });
      await act(async () => h.result.current.actions.signInWithGithub());
      expect(h.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: "github",
        options: {
          redirectTo: `${window.location.origin}/en`
        }
      });
    }
  });
  it("does not clear local secrets or documents when sign-out fails", async () => {
    const h = renderAuthActions({
      sessionValue: session
    });
    h.auth.signOut.mockResolvedValueOnce({
      error: new Error("sign-out failed")
    });
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
      sessionValue: session
    });
    const edited = cloneCvData(sampleCvDataEn);
    edited.header.name = "Signed-out fallback";
    act(() => h.result.current.form.reset(edited));
    await act(async () => h.result.current.actions.signOut());
    expect(clearEncryptionPasswords).toHaveBeenNthCalledWith(1, window.sessionStorage, "user-1");
    expect(clearEncryptionPasswords).toHaveBeenNthCalledWith(2, window.localStorage, "user-1");
    expect(h.closeEncryptionModal).toHaveBeenCalledTimes(1);
    expect(h.setOrderedDocuments).toHaveBeenCalledWith([expect.objectContaining({
      storageKind: "local",
      title: "cloud-1 title"
    })]);
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(expect.any(String), edited);
  });
  it.each([false, true])("does not persist decrypted content or its title on encrypted sign-out (existing local: %s)", async existingLocal => {
    const localData = createEmptyCvData("en");
    localData.header.name = "Existing local name";
    const local = existingLocal ? createLocalCvDocument(localData, "Existing local CV") : null;
    const encrypted = { ...summary("cv_ENCRYPTED001", "encrypted"), title: "PRIVATE_ENCRYPTED_TITLE" };
    const plainCloud = summary("cv_PLAINCLOUD01", "cloud");
    const h = renderAuthActions({
      activeDocument: encrypted,
      documents: [encrypted, plainCloud, ...(local ? [summarizeLocalDocument(local)] : [])],
      sessionValue: session
    });
    const decrypted = cloneCvData(sampleCvDataEn);
    decrypted.header.name = "PRIVATE_DECRYPTED_NAME";
    decrypted.header.subtitle = "PRIVATE_UNSAVED_EDIT";
    act(() => h.result.current.form.reset(decrypted));
    const passwordKey = `typst-cv-builder:encryption:${cloudCacheScope()}:user-1:${encrypted.id}`;
    window.sessionStorage.setItem(passwordKey, "wrapped-test-password");
    window.localStorage.setItem(passwordKey, "wrapped-test-password");

    await act(async () => h.result.current.actions.signOut());

    expect(window.sessionStorage.getItem(passwordKey)).toBeNull();
    expect(window.localStorage.getItem(passwordKey)).toBeNull();
    expect(h.closeEncryptionModal).toHaveBeenCalledTimes(1);
    const storedValues = [window.localStorage, window.sessionStorage].flatMap(storage => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!))).join("\n");
    for (const privateValue of [decrypted.header.name, decrypted.header.subtitle, encrypted.title]) {
      expect(storedValues).not.toContain(privateValue);
    }
    const nextDocuments = h.setOrderedDocuments.mock.calls[0][0] as CvDocumentSummary[];
    expect(nextDocuments).toHaveLength(1);
    expect(nextDocuments[0].storageKind).toBe("local");
    expect(nextDocuments[0].title).toBe(local?.title ?? messages.CvDocumentActions.emptyTitle);
    const selectedId = nextDocuments[0].id;
    if (local) expect(selectedId).toBe(local.id);
    const selectedDocument = loadCvDocument(selectedId);
    expect(selectedDocument?.data).toEqual(local?.data ?? createEmptyCvData("en"));
    expect(h.loadDataIntoForm).toHaveBeenCalledWith(selectedId, selectedDocument?.data);
    expect(h.result.current.form.getValues()).toEqual(selectedDocument?.data);
  });
  it("keeps an active local document and its unsaved edits on sign-out", async () => {
    const local = createLocalCvDocument(createEmptyCvData("en"), "My local CV");
    const h = renderAuthActions({
      activeDocument: summarizeLocalDocument(local),
      documents: [summary("cloud-1", "cloud"), summarizeLocalDocument(local)],
      sessionValue: session
    });
    const unsaved = cloneCvData(local.data);
    unsaved.header.name = "Unsaved local name";
    act(() => h.result.current.form.reset(unsaved));
    await act(async () => h.result.current.actions.signOut());
    expect(h.setOrderedDocuments).toHaveBeenCalledWith([summarizeLocalDocument(local)]);
    expect(h.loadDataIntoForm).not.toHaveBeenCalled();
    expect(h.result.current.form.getValues()).toEqual(unsaved);
    expect(loadCvDocument(local.id)?.data).toEqual(local.data);
  });
  it.each([false, true])("binds a pending plain-cloud sign-out fallback to its starting form (auth fails: %s)", async authFails => {
    const cloud = summary("cloud-1", "cloud");
    const encrypted = { ...summary("cv_ENCRYPTED001", "encrypted"), title: "LATE_ENCRYPTED_TITLE" };
    const h = renderAuthActions({
      activeDocument: cloud,
      documents: [cloud, encrypted],
      sessionValue: session
    });
    const original = cloneCvData(sampleCvDataEn);
    original.header.name = "Unsaved plain-cloud name";
    act(() => h.result.current.form.reset(original));
    let resolveSignOut!: (result: { error: Error | null }) => void;
    h.auth.signOut.mockReturnValueOnce(new Promise(resolve => { resolveSignOut = resolve; }));
    const passwordKey = `typst-cv-builder:encryption:${cloudCacheScope()}:user-1:${encrypted.id}`;
    window.sessionStorage.setItem(passwordKey, "wrapped-test-password");
    window.localStorage.setItem(passwordKey, "wrapped-test-password");
    const storageBefore = JSON.stringify([window.localStorage, window.sessionStorage]);
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.actions.signOut(); });
    expect(JSON.stringify([window.localStorage, window.sessionStorage])).toBe(storageBefore);
    const decrypted = cloneCvData(sampleCvDataEn);
    decrypted.header.name = "LATE_DECRYPTED_NAME";
    decrypted.header.subtitle = "LATE_DECRYPTED_UNSAVED_EDIT";
    act(() => {
      h.selectDocument(encrypted);
      h.result.current.form.reset(decrypted);
    });
    await act(async () => {
      resolveSignOut({ error: authFails ? new Error("sign-out failed") : null });
      await pending;
    });
    if (authFails) {
      expect(h.authModal.setError).toHaveBeenCalledWith("sign-out failed");
      expect(JSON.stringify([window.localStorage, window.sessionStorage])).toBe(storageBefore);
      expect(h.setOrderedDocuments).not.toHaveBeenCalled();
      expect(h.loadDataIntoForm).not.toHaveBeenCalled();
      expect(h.result.current.form.getValues()).toEqual(decrypted);
      expect(clearEncryptionPasswords).not.toHaveBeenCalled();
      return;
    }
    const storedValues = [window.localStorage, window.sessionStorage].flatMap(storage => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!))).join("\n");
    for (const value of [decrypted.header.name, decrypted.header.subtitle, encrypted.title]) expect(storedValues).not.toContain(value);
    const selected = (h.setOrderedDocuments.mock.calls[0][0] as CvDocumentSummary[])[0];
    expect(loadCvDocument(selected.id)?.data).toEqual(original);
    expect(selected.title).toBe(cloud.title);
    expect(h.result.current.form.getValues()).toEqual(original);
    expect(window.sessionStorage.getItem(passwordKey)).toBeNull();
    expect(window.localStorage.getItem(passwordKey)).toBeNull();
  });
});
