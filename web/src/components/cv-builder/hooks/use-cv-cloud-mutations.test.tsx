// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCvCloudMutations } from "./use-cv-cloud-mutations";
import { useCvCloudDocumentActions } from "./use-cv-cloud-document-actions";
import { cvCloudDocumentListQueryKey, useCvCloudDocumentListQuery } from "./use-cv-cloud-document-list-query";
import { cvCloudDocumentQueryKey, useCvCloudActiveDocumentQuery } from "./use-cv-cloud-document-query";
import * as storage from "@/lib/cv/cloud-storage";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import type { useTranslations } from "next-intl";

vi.mock("@/lib/cv/cloud-storage", () => ({
  createCloudCvDocument: vi.fn(), createEncryptedCloudCvDocument: vi.fn(), deleteCloudCvDocument: vi.fn(),
  encryptExistingCloudCvDocument: vi.fn(), renameCloudCvDocument: vi.fn(), updateCloudCvDocumentData: vi.fn(),
  updateEncryptedCloudCvDocumentData: vi.fn(), listCloudCvDocuments: vi.fn(), loadCloudCvDocument: vi.fn(), loadEncryptedCloudCvDocument: vi.fn(),
  rebindExistingCloudWriteToLoadedDocument: vi.fn(token => token), assertExistingCloudWriteCurrent: vi.fn()
}));
vi.mock("@/lib/cv/encryption", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/cv/encryption")>(),
  encryptCvData: vi.fn(async () => envelope)
}));
vi.mock("@/lib/cv/encryption-storage", () => ({ storeEncryptionPassword: vi.fn(async () => undefined), storeTrustDevice: vi.fn() }));

const client = {} as SupabaseClient;
const writeToken = {} as storage.CloudCvWriteToken;
const envelope: EncryptedPayload = { version: 1, algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations: 600000, salt: "fixture", iv: "fixture", ciphertext: "fixture" };
function session(userId: string) { return { user: { id: userId } } as Session; }
function document(id: string, storageKind: "cloud" | "encrypted" = "cloud"): CvDocumentSummary & { revision: string } {
  return { id, title: id, storageKind, revision: "1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
const operationNames = ["createCloudDocument", "createEncryptedCloudDocument", "encryptExistingCloudDocument", "updateCloudDocumentData", "updateEncryptedCloudDocumentData", "renameCloudDocument", "deleteCloudDocument"] as const;
function startMutation(mutations: ReturnType<typeof useCvCloudMutations>, operation: typeof operationNames[number], id: string) {
  const context = { client, expectedUserId: "user-a" };
  switch (operation) {
    case "createCloudDocument": return mutations.createCloudDocument.mutateAsync({ ...context, title: "A", data: sampleCvDataEn });
    case "createEncryptedCloudDocument": return mutations.createEncryptedCloudDocument.mutateAsync({ ...context, title: "A", encryptedPayload: envelope, schemaVersion: 7 });
    case "encryptExistingCloudDocument": return mutations.encryptExistingCloudDocument.mutateAsync({ ...context, writeToken, id, encryptedPayload: envelope, schemaVersion: 7 });
    case "updateCloudDocumentData": return mutations.updateCloudDocumentData.mutateAsync({ ...context, writeToken, id, data: sampleCvDataEn });
    case "updateEncryptedCloudDocumentData": return mutations.updateEncryptedCloudDocumentData.mutateAsync({ ...context, writeToken, id, encryptedPayload: envelope, schemaVersion: 7 });
    case "renameCloudDocument": return mutations.renameCloudDocument.mutateAsync({ ...context, writeToken, id, title: "Renamed A" });
    case "deleteCloudDocument": return mutations.deleteCloudDocument.mutateAsync({ ...context, writeToken, id });
  }
}
function queryClient() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(value);
  return value;
}
beforeEach(() => { vi.clearAllMocks(); window.sessionStorage.clear(); });
afterEach(() => { cleanup(); for (const value of clients.splice(0)) value.clear(); });

describe("cloud mutation account isolation with real QueryClient", () => {
  it("does not replace a new A visit's refreshed cache with an old A visit's late write", async () => {
    const a = document("cv_00000000000A"), cache = queryClient();
    const old = { ...a, storageKind: "cloud" as const, data: sampleCvDataEn };
    const finished = deferred<storage.CloudCvDocument>();
    vi.mocked(storage.updateCloudCvDocumentData).mockReturnValueOnce(finished.promise);
    const hook = renderHook(({ owner }: { owner: string }) => useCvCloudMutations({ userId: owner, locale: "en" }), {
      initialProps: { owner: "user-a" }, wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    });
    let pending!: Promise<unknown>;
    act(() => { pending = startMutation(hook.result.current, "updateCloudDocumentData", a.id); });
    await waitFor(() => expect(storage.updateCloudCvDocumentData).toHaveBeenCalledOnce());
    hook.rerender({ owner: "user-b" });
    hook.rerender({ owner: "user-a" });
    const current = { ...a, title: "New A visit's latest revision", updatedAt: "2026-01-02T00:00:00.000Z", data: { ...sampleCvDataEn, header: { ...sampleCvDataEn.header, name: "Current A data" } } };
    cache.setQueryData(cvCloudDocumentListQueryKey("user-a"), [current]);
    cache.setQueryData(cvCloudDocumentQueryKey("user-a", a.id), current);
    await act(async () => { finished.resolve(old); await pending; });
    expect(cache.getQueryData(cvCloudDocumentListQueryKey("user-a"))).toEqual([current]);
    expect(cache.getQueryData(cvCloudDocumentQueryKey("user-a", a.id))).toEqual(current);
  });
  it.each(operationNames.flatMap(operation => ["user-a", "user-b"].map(completionOwner => ({ operation, completionOwner }))))("$operation forwards A's required identity and updates only the current initiating account (completion: $completionOwner)", async ({ operation, completionOwner }) => {
    const a = document("cv_00000000000A"), b = document("cv_00000000000B");
    const plainA = { ...a, storageKind: "cloud" as const, data: sampleCvDataEn };
    const encryptedA = { ...a, storageKind: "encrypted" as const, encryptedPayload: envelope };
    const finished = deferred<void>();
    vi.mocked(storage.createCloudCvDocument).mockReturnValue(finished.promise.then(() => plainA));
    vi.mocked(storage.createEncryptedCloudCvDocument).mockReturnValue(finished.promise.then(() => encryptedA));
    vi.mocked(storage.encryptExistingCloudCvDocument).mockReturnValue(finished.promise.then(() => encryptedA));
    vi.mocked(storage.updateCloudCvDocumentData).mockReturnValue(finished.promise.then(() => plainA));
    vi.mocked(storage.updateEncryptedCloudCvDocumentData).mockReturnValue(finished.promise.then(() => encryptedA));
    vi.mocked(storage.renameCloudCvDocument).mockReturnValue(finished.promise.then(() => ({ ...a, title: "Renamed A" })));
    vi.mocked(storage.deleteCloudCvDocument).mockReturnValue(finished.promise);
    const cache = queryClient(), plainB = { ...b, data: sampleCvDataEn };
    cache.setQueryData(cvCloudDocumentListQueryKey("user-a"), [a]);
    cache.setQueryData(cvCloudDocumentQueryKey("user-a", a.id), plainA);
    cache.setQueryData(cvCloudDocumentListQueryKey("user-b"), [b]);
    cache.setQueryData(cvCloudDocumentQueryKey("user-b", b.id), plainB);
    const hook = renderHook(({ owner }: { owner: string }) => useCvCloudMutations({ userId: owner, locale: "en" }), {
      initialProps: { owner: "user-a" }, wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    });
    let pending!: Promise<unknown>;
    act(() => { pending = startMutation(hook.result.current, operation, a.id); });
    const storageName = {
      createCloudDocument: "createCloudCvDocument", createEncryptedCloudDocument: "createEncryptedCloudCvDocument",
      encryptExistingCloudDocument: "encryptExistingCloudCvDocument", updateCloudDocumentData: "updateCloudCvDocumentData",
      updateEncryptedCloudDocumentData: "updateEncryptedCloudCvDocumentData", renameCloudDocument: "renameCloudCvDocument", deleteCloudDocument: "deleteCloudCvDocument"
    } as const;
    await waitFor(() => expect(storage[storageName[operation]]).toHaveBeenCalledOnce());
    switch (operation) {
      case "createCloudDocument": expect(storage.createCloudCvDocument).toHaveBeenCalledWith(client, expect.objectContaining({ expectedUserId: "user-a" }), "en"); break;
      case "createEncryptedCloudDocument": expect(storage.createEncryptedCloudCvDocument).toHaveBeenCalledWith(client, expect.objectContaining({ expectedUserId: "user-a" }), "en"); break;
      case "encryptExistingCloudDocument": expect(storage.encryptExistingCloudCvDocument).toHaveBeenCalledWith(client, a.id, expect.objectContaining({ expectedUserId: "user-a" }), "en"); break;
      case "updateCloudDocumentData": expect(storage.updateCloudCvDocumentData).toHaveBeenCalledWith(client, a.id, sampleCvDataEn, "user-a", writeToken, "en"); break;
      case "updateEncryptedCloudDocumentData": expect(storage.updateEncryptedCloudCvDocumentData).toHaveBeenCalledWith(client, a.id, expect.objectContaining({ expectedUserId: "user-a" }), "en"); break;
      case "renameCloudDocument": expect(storage.renameCloudCvDocument).toHaveBeenCalledWith(client, a.id, "Renamed A", "user-a", writeToken); break;
      case "deleteCloudDocument": expect(storage.deleteCloudCvDocument).toHaveBeenCalledWith(client, a.id, "user-a", writeToken); break;
    }
    hook.rerender({ owner: completionOwner });
    await act(async () => { finished.resolve(); await pending; });
    expect(cache.getQueryData(cvCloudDocumentListQueryKey("user-b"))).toEqual([b]);
    expect(cache.getQueryData(cvCloudDocumentQueryKey("user-b", b.id))).toEqual(plainB);
    expect(cache.getQueryData(cvCloudDocumentQueryKey("user-b", a.id))).toBeUndefined();
    if (completionOwner === "user-a") {
      const current = cache.getQueryData<CvDocumentSummary[]>(cvCloudDocumentListQueryKey("user-a"));
      if (operation === "deleteCloudDocument") {
        expect(current).toEqual([]);
        expect(cache.getQueryData(cvCloudDocumentQueryKey("user-a", a.id))).toBeUndefined();
      } else {
        expect(current).toEqual([expect.objectContaining({ id: a.id })]);
        if (operation === "renameCloudDocument") expect(current?.[0].title).toBe("Renamed A");
        if (["createEncryptedCloudDocument", "encryptExistingCloudDocument", "updateEncryptedCloudDocumentData"].includes(operation)) expect(current?.[0].storageKind).toBe("encrypted");
        if (operation === "encryptExistingCloudDocument") expect(cache.getQueryData(cvCloudDocumentQueryKey("user-a", a.id))).toBeUndefined();
        if (["createCloudDocument", "updateCloudDocumentData"].includes(operation)) expect(cache.getQueryData(cvCloudDocumentQueryKey("user-a", a.id))).toEqual(plainA);
      }
    }
  });
  it("keeps B's cache, automatic document load and conversion UI intact when A's encryption completes late", async () => {
    const a = document("cv_00000000000A"), b = document("cv_00000000000B");
    const encryptedA = { ...a, storageKind: "encrypted" as const, encryptedPayload: envelope };
    const conversion = deferred<storage.EncryptedCloudCvDocument>();
    const bLoad = deferred<storage.CloudCvDocument>();
    vi.mocked(storage.listCloudCvDocuments).mockImplementation(async (_client, userId) => userId === "user-a" ? [a] : [b]);
    vi.mocked(storage.loadCloudCvDocument).mockImplementation(async (_client, id) => id === a.id ? { ...a, storageKind: "cloud", data: sampleCvDataEn } : bLoad.promise);
    vi.mocked(storage.encryptExistingCloudCvDocument).mockReturnValue(conversion.promise);
    const cache = queryClient();
    const loadDataIntoForm = vi.fn(), upsertDocumentSummary = vi.fn(), closeEncryptionModal = vi.fn(), setCloudStatus = vi.fn(), onError = vi.fn();
    const hook = renderHook(({ owner }: { owner: string }) => {
      const currentSession = session(owner);
      const mutations = useCvCloudMutations({ userId: owner, locale: "en" });
      const list = useCvCloudDocumentListQuery({ enabled: true, session: currentSession, supabase: client });
      const active = useCvCloudActiveDocumentQuery({ activeDocumentId: null, documentsData: list.data ?? [], locale: "en", session: currentSession, supabase: client });
      const actions = useCvCloudDocumentActions({
        locale: "en", tCloudActions: ((key: string) => key) as ReturnType<typeof useTranslations<"CvCloudActions">>,
        activeDocumentId: owner === "user-a" ? a.id : null, closeEncryptionModal,
        createCloudDocument: mutations.createCloudDocument.mutateAsync, createEncryptedCloudDocument: mutations.createEncryptedCloudDocument.mutateAsync,
        captureExistingWrite: () => writeToken,
        encryptExistingCloudDocument: mutations.encryptExistingCloudDocument.mutateAsync,
        documents: list.data ?? [], duplicateDocument: vi.fn(), fetchCloudDocument: async () => ({ ...a, storageKind: "cloud", data: sampleCvDataEn }),
        loadDataIntoForm, onError, openEnableEncryptionModal: vi.fn(), saveCurrentDocument: async () => true,
        session: currentSession, setCloudStatus, setOrderedDocuments: vi.fn(), supabase: client,
        termsGate: { ensure: async () => true }, upsertDocumentSummary
      });
      return { actions, list, active };
    }, { initialProps: { owner: "user-a" }, wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider> });
    await waitFor(() => expect(hook.result.current.list.data).toEqual([a]));
    let pending!: Promise<unknown>;
    act(() => { pending = hook.result.current.actions.handleEncryptionSubmit({ mode: "enable", documentId: a.id, password: "fixture-password", trustDevice: false }); });
    await waitFor(() => expect(storage.encryptExistingCloudCvDocument).toHaveBeenCalledOnce());
    expect(storage.encryptExistingCloudCvDocument).toHaveBeenCalledWith(client, a.id, expect.objectContaining({ expectedUserId: "user-a" }), "en");
    hook.rerender({ owner: "user-b" });
    await waitFor(() => expect(hook.result.current.list.data).toEqual([b]));
    await waitFor(() => expect(storage.loadCloudCvDocument).toHaveBeenCalledWith(client, b.id, "en", "user-b"));
    await act(async () => { conversion.resolve(encryptedA); await pending; });
    expect(cache.getQueryData(cvCloudDocumentListQueryKey("user-b"))).toEqual([b]);
    expect(cache.getQueryData(cvCloudDocumentQueryKey("user-b", a.id))).toBeUndefined();
    expect(hook.result.current.active.fetchStatus).toBe("fetching");
    expect(loadDataIntoForm).not.toHaveBeenCalled();
    expect(upsertDocumentSummary).not.toHaveBeenCalled();
    expect(closeEncryptionModal).not.toHaveBeenCalled();
    expect(setCloudStatus).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    const loadedB = { ...b, storageKind: "cloud" as const, data: sampleCvDataEn };
    await act(async () => { bLoad.resolve(loadedB); });
    await waitFor(() => expect(hook.result.current.active.data).toEqual(loadedB));
    expect(cache.getQueryData(cvCloudDocumentListQueryKey("user-b"))).toEqual([b]);
  });
});
