import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activateCloudDocument, createCloudCvDocument, loadCloudCvDocument, updateCloudCvDocumentData } from "../../cloud-storage";
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
  encrypted_payload: null
};
function backend() {
  let instanceId = instance;
  let row = structuredClone(base);
  let loseResponse = false;
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
                id: "user-a"
              }
            }
          },
          error: null
        }),
        getUser: async () => ({
          data: {
            user: {
              id: "user-a"
            }
          },
          error: null
        })
      },
      from
    } as unknown as SupabaseClient,
    rpc,
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
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn)).rejects.toThrow("CONFLICT");
  });
  it("retains the base revision when adopting a recovered draft", async () => {
    const b = backend();
    b.changeRow({
      revision: "2"
    });
    await loadCloudCvDocument(b.client, id);
    activateCloudDocument(b.client, id, "1");
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn)).rejects.toThrow("CONFLICT");
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
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn)).rejects.toThrow("lost");
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn)).rejects.toThrow("CONFLICT");
    await loadCloudCvDocument(b.client, id);
    activateCloudDocument(b.client, id);
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn)).resolves.toMatchObject({
      id
    });
  });
  it("does not attach old content to a replacement database instance", async () => {
    const b = backend();
    await loadCloudCvDocument(b.client, id);
    b.changeInstance();
    await expect(updateCloudCvDocumentData(b.client, id, sampleCvDataEn)).rejects.toThrow("CLIENT_UPDATE_REQUIRED");
    expect(b.rpc.mock.calls.filter(([name]) => name === "cv_document_update")).toHaveLength(0);
  });
  it("reuses a create operation key until its outcome is confirmed", async () => {
    const b = backend();
    b.loseResponse();
    await expect(createCloudCvDocument(b.client, {
      title: "CV",
      data: sampleCvDataEn
    })).rejects.toThrow("lost");
    await createCloudCvDocument(b.client, {
      title: "CV",
      data: sampleCvDataEn
    });
    const writes = b.rpc.mock.calls.filter(([name]) => name === "cv_document_create");
    expect(writes[0]![1]!.p_input.client_create_key).toBe(writes[1]![1]!.p_input.client_create_key);
  });
});
