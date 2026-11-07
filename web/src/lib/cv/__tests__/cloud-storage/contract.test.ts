import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activateCloudDocument, assertExistingCloudWriteCurrent, captureExistingCloudWrite, cloudDocumentOwner, createCloudCvDocument, createEncryptedCloudCvDocument, deleteCloudCvDocument, editingCloudRevision, encryptExistingCloudCvDocument, listCloudCvDocuments, loadCloudCvDocument, rebindExistingCloudWriteToLoadedDocument, renameCloudCvDocument, type CloudCvWriteToken, updateCloudCvDocumentData, updateEncryptedCloudCvDocumentData } from "../../cloud-storage";
import { sampleCvDataEn } from "../../sample-data";
import { createCvStorageAdapters } from "../../storage-adapters";
import { encryptCvData } from "../../encryption";
import { loadCvDraft, saveCvDraft } from "../../draft-storage";
vi.mock("@/lib/cv/encryption", async importOriginal => ({
  ...await importOriginal<typeof import("../../encryption")>(),
  encryptCvData: vi.fn(async () => encryptedPayload),
  decryptCvData: vi.fn(async () => sampleCvDataEn)
}));
vi.mock("@/lib/supabase/user-client", () => ({
  bindSupabaseUser: async (client: SupabaseClient) => client
}));
afterEach(() => vi.unstubAllGlobals());
const instance = "00000000-0000-4000-8000-000000000001";
const id = "cv_0123456789AB";
const base = {
  external_id: id,
  title: "CV",
  storage_mode: "PLAIN",
  revision: "1",
  document_schema_version: 7,
  time_created: "2026-01-01",
  time_updated: "2026-01-01",
  data: sampleCvDataEn,
  encrypted_payload: null as unknown
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function backend() {
  let instanceId = instance;
  let row = structuredClone(base);
  let loseResponse = false;
  let userId = "user-a";
  let nextResponse: { entered: () => void; wait: Promise<void> } | null = null;
  let nextSession: { entered: () => void; wait: Promise<void> } | null = null;
  const rpc = vi.fn(async (name: string, args?: {
    p_input: Record<string, unknown>;
  }) => {
    if (name === "app_context") return {
      data: {
        ready: true,
        contract_code: "cv_app_db_1",
        database_instance_id: instanceId
      },
      error: null
    };
    const input = args!.p_input;
    if (name !== "cv_document_create" && input.expected_revision !== row.revision) return { data: null, error: new Error("CONFLICT") };
    if (name === "cv_document_update") {
      if (input.expected_revision !== row.revision) return {
        data: null,
        error: new Error("CONFLICT")
      };
      row = {
        ...row,
        revision: String(Number(row.revision) + 1),
        data: input.data as typeof row.data
      };
    }
    if (name === "cv_document_convert") row = { ...row, revision: String(Number(row.revision) + 1), storage_mode: "ENCRYPTED", encrypted_payload: input.encrypted_payload };
    if (name === "cv_document_rename") row = { ...row, revision: String(Number(row.revision) + 1), title: input.title as string };
    if (loseResponse) {
      loseResponse = false;
      return {
        data: null,
        error: new Error("network response lost")
      };
    }
    const responseRow = structuredClone(row);
    const response = nextResponse;
    nextResponse = null;
    if (response) { response.entered(); await response.wait; }
    return {
      data: responseRow,
      error: null
    };
  });
  const from = vi.fn(() => ({
    select: () => ({
      order: async () => ({ data: [structuredClone(row)], error: null }),
      eq: () => ({
        maybeSingle: async () => ({
          data: row,
          error: null
        })
      })
    })
  }));
  return {
    client: {
      rpc,
      auth: {
        getSession: async () => {
          const owner = userId, response = nextSession;
          nextSession = null;
          if (response) { response.entered(); await response.wait; }
          return { data: { session: { user: { id: owner } } }, error: null };
        },
        getUser: async () => ({
          data: {
            user: {
              id: userId
            }
          },
          error: null
        })
      },
      from
    } as unknown as SupabaseClient,
    rpc,
    pauseNextResponse: () => {
      const entered = deferred<void>(), release = deferred<void>();
      nextResponse = { entered: () => entered.resolve(), wait: release.promise };
      return { committed: entered.promise, release: () => release.resolve() };
    },
    pauseNextSession: () => {
      const entered = deferred<void>(), release = deferred<void>();
      nextSession = { entered: () => entered.resolve(), wait: release.promise };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    changeUser: (value: string) => { userId = value; },
    changeInstance: () => {
      instanceId = "00000000-0000-4000-8000-000000000002";
    },
    loseResponse: () => {
      loseResponse = true;
    },
    changeRow: (value: Partial<typeof row>) => {
      row = {
        ...row,
        ...value
      };
    }
  };
}
function adaptersFor(b: ReturnType<typeof backend>, access = async () => b.client, passphrase = async () => "fixture-password") {
  return createCvStorageAdapters({
    locale: "en", captureExistingWrite: id => captureExistingCloudWrite(b.client, id, "user-a"),
    requireCloudAccess: access, getEncryptionPassphrase: passphrase,
    cloudStorage: {
      loadCloudDocument: (client, id, locale) => loadCloudCvDocument(client, id, locale, "user-a"),
      deleteCloudDocument: (client, id, token) => deleteCloudCvDocument(client, id, "user-a", token),
      renameCloudDocument: (client, id, title, token) => renameCloudCvDocument(client, id, title, "user-a", token),
      updateCloudDocumentData: (client, id, data, locale, token) => updateCloudCvDocumentData(client, id, data, "user-a", token, locale),
      updateEncryptedCloudDocumentData: (client, id, input, locale, writeToken) => updateEncryptedCloudCvDocumentData(client, id, { ...input, expectedUserId: "user-a", writeToken }, locale)
    }
  });
}
describe("existing-write source provenance through asynchronous preparation", () => {
  it.each(["plain save", "encrypted save", "rename", "delete"] as const)("%s freezes the original adoption before waiting for cloud access", async operation => {
    const b = backend(), entered = deferred<void>(), access = deferred<SupabaseClient>();
    const body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, body.revision);
    const adapters = adaptersFor(b, async () => { entered.resolve(); return access.promise; });
    const pending = (operation === "plain save" ? adapters.cloud.save(body, body.data) : operation === "encrypted save" ? adapters.encrypted.save({ ...body, storageKind: "encrypted" }, body.data) : operation === "rename" ? adapters.cloud.rename(body, "Old title") : adapters.cloud.delete(body))
      .then(() => "saved", error => error instanceof Error && error.message.startsWith("CONFLICT") ? "conflict" : "unexpected");
    await entered.promise;
    b.changeRow({ revision: "2" });
    const current = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, current.revision);
    access.resolve(b.client);
    expect(await pending).toBe("conflict");
    expect(editingCloudRevision(b.client, id)).toBe("2");
    expect(b.rpc.mock.calls.filter(([name]) => name !== "app_context")).toHaveLength(0);
  });
  it("keeps encrypted save bound to its old adoption while awaiting a passphrase", async () => {
    const b = backend(), entered = deferred<void>(), password = deferred<string>();
    const body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, body.revision);
    const adapters = adaptersFor(b, async () => b.client, async () => { entered.resolve(); return password.promise; });
    const pending = adapters.encrypted.save({ ...body, storageKind: "encrypted" }, body.data).then(() => "saved", () => "conflict");
    await entered.promise;
    b.changeRow({ revision: "2" });
    const current = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, current.revision);
    password.resolve("fixture-password");
    expect(await pending).toBe("conflict");
    expect(b.rpc.mock.calls.filter(([name]) => name !== "app_context")).toHaveLength(0);
  });
  it("keeps encrypted save bound to its old adoption while crypto is pending", async () => {
    const b = backend(), entered = deferred<void>(), ciphertext = deferred<typeof encryptedPayload>();
    vi.mocked(encryptCvData).mockImplementationOnce(async () => { entered.resolve(); return ciphertext.promise; });
    const body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, body.revision);
    const pending = adaptersFor(b).encrypted.save({ ...body, storageKind: "encrypted" }, body.data).then(() => "saved", () => "conflict");
    await entered.promise;
    b.changeRow({ revision: "2" });
    const current = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, current.revision);
    ciphertext.resolve(encryptedPayload);
    expect(await pending).toBe("conflict");
    expect(b.rpc.mock.calls.filter(([name]) => name !== "app_context")).toHaveLength(0);
  });
  it("permits unchanged inactive writes across a same-revision list refresh and advances the next CAS", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    const token = captureExistingCloudWrite(b.client, id, "user-a");
    await listCloudCvDocuments(b.client, "user-a");
    await renameCloudCvDocument(b.client, id, "First", "user-a", token);
    await renameCloudCvDocument(b.client, id, "Second", "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    expect(b.rpc.mock.calls.filter(([name]) => name === "cv_document_rename").map(([, args]) => args!.p_input.expected_revision)).toEqual(["1", "2"]);
  });
  it("binds an inactive conversion to its actual read revision despite later summary refreshes", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    const token = captureExistingCloudWrite(b.client, id, "user-a");
    const body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    await listCloudCvDocuments(b.client, "user-a");
    const bound = rebindExistingCloudWriteToLoadedDocument(token, body);
    assertExistingCloudWriteCurrent(bound);
    await encryptExistingCloudCvDocument(b.client, id, { encryptedPayload, schemaVersion: 7, expectedUserId: "user-a", writeToken: bound });
    expect(b.rpc.mock.calls.find(([name]) => name === "cv_document_convert")![1]!.p_input.expected_revision).toBe("1");
  });
  it("never upgrades the active draft revision when rebinding a newer source read for conversion", async () => {
    const b = backend();
    const first = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, first.revision);
    const token = captureExistingCloudWrite(b.client, id, "user-a");
    b.changeRow({ revision: "2" });
    const body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    const bound = rebindExistingCloudWriteToLoadedDocument(token, body);
    expect(bound).toBe(token);
    await expect(encryptExistingCloudCvDocument(b.client, id, { encryptedPayload, schemaVersion: 7, expectedUserId: "user-a", writeToken: bound })).rejects.toThrow("CONFLICT");
    expect(editingCloudRevision(b.client, id)).toBe("1");
  });
  it("a later observation cannot relabel an older loaded conversion body with a newer CAS", async () => {
    const b = backend(), body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    const token = captureExistingCloudWrite(b.client, id, "user-a");
    b.changeRow({ revision: "2" });
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    const bound = rebindExistingCloudWriteToLoadedDocument(token, body);
    await expect(encryptExistingCloudCvDocument(b.client, id, { encryptedPayload, schemaVersion: 7, expectedUserId: "user-a", writeToken: bound })).rejects.toThrow("CONFLICT");
    expect(b.rpc.mock.calls.find(([name]) => name === "cv_document_convert")![1]!.p_input.expected_revision).toBe("1");
  });
  it("same-adoption success supplies revision 2 before the latest S2 draft is persisted", async () => {
    const records = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) } });
    const b = backend(), body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, body.revision);
    const response = b.pauseNextResponse();
    const pending = adaptersFor(b).cloud.save(body, body.data);
    await response.committed;
    const s2 = { ...body.data, header: { ...body.data.header, name: "Unsaved S2" } };
    saveCvDraft("user-a", id, s2, editingCloudRevision(b.client, id)!);
    expect(loadCvDraft("user-a", id)?.baseRevision).toBe("1");
    response.release(); await pending;
    saveCvDraft("user-a", id, s2, editingCloudRevision(b.client, id)!);
    expect(loadCvDraft("user-a", id)).toMatchObject({ baseRevision: "2", data: s2 });
  });
  it.each([undefined, "", "01"])("refuses body adoption without a canonical explicit revision: %j", async revision => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    expect(() => activateCloudDocument(b.client, id, revision as unknown as string)).toThrow("body revision is required");
    expect(editingCloudRevision(b.client, id)).toBeNull();
  });
});
describe("cloud document concurrency boundary", () => {
  it("adopts a body using its own revision even when a later summary refresh has observed revision 2", async () => {
    const b = backend(), body = await loadCloudCvDocument(b.client, id, "en", "user-a");
    b.changeRow({ revision: "2" });
    await listCloudCvDocuments(b.client, "user-a");
    activateCloudDocument(b.client, id, body.revision);
    const revision = editingCloudRevision(b.client, id);
    const next = await updateCloudCvDocumentData(b.client, id, body.data, "user-a", captureExistingCloudWrite(b.client, id, "user-a")).then(() => "saved", () => "conflict");
    expect({ revision, next }).toEqual({ revision: "1", next: "conflict" });
  });
  it("does not let a late delete clear evidence superseded by a new form adoption", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    const response = b.pauseNextResponse();
    const old = deleteCloudCvDocument(b.client, id, "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    await response.committed;
    activateCloudDocument(b.client, id, "1");
    response.release(); await old;
    expect(editingCloudRevision(b.client, id)).toBe("1");
    expect(cloudDocumentOwner(b.client, id)).toBe("user-a");
  });
  it("does not let a late create response overwrite a newer observation of the created document", async () => {
    const b = backend(), response = b.pauseNextResponse();
    const old = createCloudCvDocument(b.client, { title: "CV", data: sampleCvDataEn, expectedUserId: "user-a" });
    await response.committed;
    b.changeRow({ revision: "2" });
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    response.release(); await old;
    expect(editingCloudRevision(b.client, id)).toBe("1");
    activateCloudDocument(b.client, id, "2");
    expect(editingCloudRevision(b.client, id)).toBe("2");
  });
  it("removes unchanged observed and editing evidence after a normal delete", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    await deleteCloudCvDocument(b.client, id, "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    expect(editingCloudRevision(b.client, id)).toBeNull();
    expect(cloudDocumentOwner(b.client, id)).toBeNull();
  });
  it("does not rebase a recovered revision-1 draft when an old committed revision-2 update responds after A-B-A", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    const response = b.pauseNextResponse();
    const old = updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    await response.committed;
    b.changeUser("user-b"); b.changeUser("user-a");
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    response.release(); await expect(old).rejects.toThrow("CONFLICT");
    const revision = editingCloudRevision(b.client, id);
    const next = await updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a")).then(() => "saved", () => "conflict");
    expect({ revision, next }).toEqual({ revision: "1", next: "conflict" });
    expect(editingCloudRevision(b.client, id)).toBe("1");
  });
  it("treats every form adoption as a new edit identity even without another read", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    const response = b.pauseNextResponse();
    const old = updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    await response.committed;
    activateCloudDocument(b.client, id, "1");
    response.release(); await expect(old).rejects.toThrow("CONFLICT");
    expect(editingCloudRevision(b.client, id)).toBe("1");
    activateCloudDocument(b.client, id, "1");
    expect(editingCloudRevision(b.client, id)).toBe("1");
  });
  it("binds the payload to its initiating edit identity before authentication awaits", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    const auth = b.pauseNextSession();
    const old = updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a")).then(() => "saved", () => "conflict");
    await auth.entered;
    b.changeRow({ revision: "2" });
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "2");
    auth.release();
    expect(await old).toBe("conflict");
    expect(editingCloudRevision(b.client, id)).toBe("2");
    expect(b.rpc.mock.calls.filter(([name]) => name === "cv_document_update")).toHaveLength(0);
  });
  it("advances an unchanged edit using its own response revision while retaining a newer background observation", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    const response = b.pauseNextResponse();
    const old = updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    await response.committed;
    b.changeRow({ revision: "3" });
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    response.release(); await old;
    expect(editingCloudRevision(b.client, id)).toBe("2");
    activateCloudDocument(b.client, id, "3");
    expect(editingCloudRevision(b.client, id)).toBe("3");
  });
  it("advances normal successful edits and leaves the baseline unchanged after conflict", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    activateCloudDocument(b.client, id, "1");
    await updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    expect(editingCloudRevision(b.client, id)).toBe("2");
    await updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"));
    expect(editingCloudRevision(b.client, id)).toBe("3");
    b.changeRow({ revision: "4" });
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"))).rejects.toThrow("CONFLICT");
    expect(editingCloudRevision(b.client, id)).toBe("3");
  });
  it("retains a create key across a reload and rejects edited content while its result is unknown", async () => {
    const records = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => records.set(key, value),
        removeItem: (key: string) => records.delete(key)
      }
    });
    const first = backend();
    first.loseResponse();
    const input = {
      title: "CV",
      data: sampleCvDataEn,
      expectedUserId: "user-a",
      sourceDocumentId: "local-source"
    };
    await expect(createCloudCvDocument(first.client, input)).rejects.toThrow("lost");
    const reloaded = backend();
    await expect(createCloudCvDocument(reloaded.client, {
      ...input,
      title: "Changed"
    })).rejects.toThrow("Resolve the pending");
    await createCloudCvDocument(reloaded.client, input);
    const before = first.rpc.mock.calls.find(([name]) => name === "cv_document_create")![1]!.p_input;
    const after = reloaded.rpc.mock.calls.find(([name]) => name === "cv_document_create")![1]!.p_input;
    expect(after.client_create_key).toBe(before.client_create_key);
    expect(records.size).toBe(0);
  });
  it("keeps the editor revision when a background read sees a newer row", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id);
    activateCloudDocument(b.client, id, "1");
    b.changeRow({
      revision: "2"
    });
    await loadCloudCvDocument(b.client, id);
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"))).rejects.toThrow("CONFLICT");
  });
  it("retains the base revision when adopting a recovered draft", async () => {
    const b = backend();
    b.changeRow({
      revision: "2"
    });
    await loadCloudCvDocument(b.client, id);
    activateCloudDocument(b.client, id, "1");
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"))).rejects.toThrow("CONFLICT");
  });
  it("rejects old plaintext even when the declared row version is current", async () => {
    const b = backend();
    b.changeRow({
      data: {
        ...sampleCvDataEn,
        schemaVersion: 6
      } as unknown as typeof sampleCvDataEn
    });
    await expect(loadCloudCvDocument(b.client, id)).rejects.toThrow();
  });
  it("never upgrades a lost update response into a blind overwrite", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id);
    b.loseResponse();
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"))).rejects.toThrow("lost");
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"))).rejects.toThrow("CONFLICT");
    await loadCloudCvDocument(b.client, id);
    activateCloudDocument(b.client, id, "2");
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"))).resolves.toMatchObject({
      id
    });
  });
  it("does not attach old content to a replacement database instance", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id);
    b.changeInstance();
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a", captureExistingCloudWrite(b.client, id, "user-a"))).rejects.toThrow("CLIENT_UPDATE_REQUIRED");
    expect(b.rpc.mock.calls.filter(([name]) => name === "cv_document_update")).toHaveLength(0);
  });
  it("reuses a create operation key until its outcome is confirmed", async () => {
    const b = backend();
    b.loseResponse();
    await expect(createCloudCvDocument(b.client, {
      title: "CV",
      expectedUserId: "user-a",
      data: sampleCvDataEn
    })).rejects.toThrow("lost");
    await createCloudCvDocument(b.client, {
      title: "CV",
      expectedUserId: "user-a",
      data: sampleCvDataEn
    });
    const writes = b.rpc.mock.calls.filter(([name]) => name === "cv_document_create");
    expect(writes[0]![1]!.p_input.client_create_key).toBe(writes[1]![1]!.p_input.client_create_key);
  });
});

const encryptedPayload = { version: 1 as const, algorithm: "AES-GCM" as const, kdf: "PBKDF2-SHA-256" as const, iterations: 600000, salt: "fixture", iv: "fixture", ciphertext: "fixture" };
function testToken(client: SupabaseClient, expectedUserId: string) {
  return expectedUserId ? captureExistingCloudWrite(client, id, "user-a") : undefined as unknown as CloudCvWriteToken;
}
const cloudWrites = [
  { name: "create", run: (client: SupabaseClient, expectedUserId: string) => createCloudCvDocument(client, { title: "CV", data: sampleCvDataEn, expectedUserId }) },
  { name: "create encrypted", run: (client: SupabaseClient, expectedUserId: string) => createEncryptedCloudCvDocument(client, { title: "CV", encryptedPayload, schemaVersion: 7, expectedUserId }) },
  { name: "convert", run: (client: SupabaseClient, expectedUserId: string) => encryptExistingCloudCvDocument(client, id, { encryptedPayload, schemaVersion: 7, expectedUserId, writeToken: testToken(client, expectedUserId) }) },
  { name: "update", run: (client: SupabaseClient, expectedUserId: string) => updateCloudCvDocumentData(client, id, sampleCvDataEn, expectedUserId, testToken(client, expectedUserId)) },
  { name: "update encrypted", run: (client: SupabaseClient, expectedUserId: string) => updateEncryptedCloudCvDocumentData(client, id, { encryptedPayload, schemaVersion: 7, expectedUserId, writeToken: testToken(client, expectedUserId) }) },
  { name: "rename", run: (client: SupabaseClient, expectedUserId: string) => renameCloudCvDocument(client, id, "Renamed", expectedUserId, testToken(client, expectedUserId)) },
  { name: "delete", run: (client: SupabaseClient, expectedUserId: string) => deleteCloudCvDocument(client, id, expectedUserId, testToken(client, expectedUserId)) }
];
describe("cloud write initiating account is mandatory", () => {
  it.each(cloudWrites)("$name rejects omitted and empty identities at runtime before mutation RPCs", async ({ run }) => {
    const b = backend();
    for (const missing of [undefined, ""]) await expect(run(b.client, missing as unknown as string)).rejects.toThrow("Expected account is required");
    expect(b.rpc).not.toHaveBeenCalled();
  });
  it.each(cloudWrites)("$name never silently adopts B when initiated for A", async ({ run }) => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    b.rpc.mockClear();
    b.changeUser("user-b");
    await expect(run(b.client, "user-a")).rejects.toThrow("ACCOUNT_CHANGED");
    expect(b.rpc).not.toHaveBeenCalled();
  });
  it("passes the initiating identity to the conversion RPC", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id, "en", "user-a");
    await encryptExistingCloudCvDocument(b.client, id, { encryptedPayload, schemaVersion: 7, expectedUserId: "user-a", writeToken: captureExistingCloudWrite(b.client, id, "user-a") });
    const write = b.rpc.mock.calls.find(([name]) => name === "cv_document_convert")![1]!.p_input;
    expect(write.expected_auth_user_id).toBe("user-a");
    expect(write.expected_revision).toBe("1");
  });
});
