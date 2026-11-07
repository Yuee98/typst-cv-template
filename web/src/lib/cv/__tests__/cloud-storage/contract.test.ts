import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activateCloudDocument, createCloudCvDocument, createEncryptedCloudCvDocument, deleteCloudCvDocument, encryptExistingCloudCvDocument, loadCloudCvDocument, renameCloudCvDocument, updateCloudCvDocumentData, updateEncryptedCloudCvDocumentData } from "../../cloud-storage";
import { sampleCvDataEn } from "../../sample-data";
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
function backend() {
  let instanceId = instance;
  let row = structuredClone(base);
  let loseResponse = false;
  let userId = "user-a";
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
    if (name === "cv_document_convert") row = { ...row, storage_mode: "ENCRYPTED", encrypted_payload: input.encrypted_payload };
    if (loseResponse) {
      loseResponse = false;
      return {
        data: null,
        error: new Error("network response lost")
      };
    }
    return {
      data: row,
      error: null
    };
  });
  const from = vi.fn(() => ({
    select: () => ({
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
        getSession: async () => ({
          data: {
            session: {
              user: {
                id: userId
              }
            }
          },
          error: null
        }),
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
describe("cloud document concurrency boundary", () => {
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
    activateCloudDocument(b.client, id);
    b.changeRow({
      revision: "2"
    });
    await loadCloudCvDocument(b.client, id);
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a")).rejects.toThrow("CONFLICT");
  });
  it("retains the base revision when adopting a recovered draft", async () => {
    const b = backend();
    b.changeRow({
      revision: "2"
    });
    await loadCloudCvDocument(b.client, id);
    activateCloudDocument(b.client, id, "1");
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a")).rejects.toThrow("CONFLICT");
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
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a")).rejects.toThrow("lost");
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a")).rejects.toThrow("CONFLICT");
    await loadCloudCvDocument(b.client, id);
    activateCloudDocument(b.client, id);
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a")).resolves.toMatchObject({
      id
    });
  });
  it("does not attach old content to a replacement database instance", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id);
    b.changeInstance();
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn, "user-a")).rejects.toThrow("CLIENT_UPDATE_REQUIRED");
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
const cloudWrites = [
  { name: "create", run: (client: SupabaseClient, expectedUserId: string) => createCloudCvDocument(client, { title: "CV", data: sampleCvDataEn, expectedUserId }) },
  { name: "create encrypted", run: (client: SupabaseClient, expectedUserId: string) => createEncryptedCloudCvDocument(client, { title: "CV", encryptedPayload, schemaVersion: 7, expectedUserId }) },
  { name: "convert", run: (client: SupabaseClient, expectedUserId: string) => encryptExistingCloudCvDocument(client, id, { encryptedPayload, schemaVersion: 7, expectedUserId }) },
  { name: "update", run: (client: SupabaseClient, expectedUserId: string) => updateCloudCvDocumentData(client, id, sampleCvDataEn, expectedUserId) },
  { name: "update encrypted", run: (client: SupabaseClient, expectedUserId: string) => updateEncryptedCloudCvDocumentData(client, id, { encryptedPayload, schemaVersion: 7, expectedUserId }) },
  { name: "rename", run: (client: SupabaseClient, expectedUserId: string) => renameCloudCvDocument(client, id, "Renamed", expectedUserId) },
  { name: "delete", run: (client: SupabaseClient, expectedUserId: string) => deleteCloudCvDocument(client, id, expectedUserId) }
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
    await encryptExistingCloudCvDocument(b.client, id, { encryptedPayload, schemaVersion: 7, expectedUserId: "user-a" });
    const write = b.rpc.mock.calls.find(([name]) => name === "cv_document_convert")![1]!.p_input;
    expect(write.expected_auth_user_id).toBe("user-a");
    expect(write.expected_revision).toBe("1");
  });
});
