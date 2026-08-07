import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  createCloudCvDocument,
  createEncryptedCloudCvDocument,
  deleteCloudCvDocument,
  encryptExistingCloudCvDocument,
  listCloudCvDocuments,
  loadCloudCvDocument,
  loadEncryptedCloudCvDocument,
  renameCloudCvDocument,
  updateCloudCvDocumentData,
  updateEncryptedCloudCvDocumentData,
} from "@/lib/cv/cloud-storage";
import { cloneCvData } from "@/lib/cv/cv-utils";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import { sampleCvDataEn } from "@/lib/cv/sample-data";

type QueryResponse = { data: unknown; error: unknown };

function createSupabaseQuery(response: QueryResponse) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<QueryResponse>["then"];
  } = {};

  query.select = vi.fn(() => query);
  query.order = vi.fn(async () => response);
  query.eq = vi.fn(() => query);
  query.single = vi.fn(async () => response);
  query.insert = vi.fn(() => query);
  query.update = vi.fn(() => query);
  query.delete = vi.fn(() => query);
  query.then = (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected);

  const from = vi.fn(() => query);
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    query,
  };
}

const encryptedPayload: EncryptedPayload = {
  version: 1,
  algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256",
  iterations: 100_000,
  salt: "salt",
  iv: "iv",
  ciphertext: "ciphertext",
};

function cloudRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv-1",
    title: "Cloud CV",
    storage_mode: "plain",
    data: cloneCvData(sampleCvDataEn),
    encrypted_payload: null,
    schema_version: sampleCvDataEn.schemaVersion,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("cloud CV row mapping", () => {
  it("lists summaries in the query order and maps encrypted storage", async () => {
    const plain = cloudRow();
    const encrypted = cloudRow({
      id: "cv-2",
      storage_mode: "encrypted",
      data: null,
      encrypted_payload: encryptedPayload,
    });
    const h = createSupabaseQuery({ data: [plain, encrypted], error: null });

    await expect(listCloudCvDocuments(h.client)).resolves.toEqual([
      expect.objectContaining({ id: "cv-1", storageKind: "cloud" }),
      expect.objectContaining({ id: "cv-2", storageKind: "encrypted" }),
    ]);
    expect(h.from).toHaveBeenCalledWith("cv_documents");
    expect(h.query.order).toHaveBeenCalledWith("updated_at", { ascending: false });
  });

  it("loads and normalizes a valid plain document", async () => {
    const h = createSupabaseQuery({ data: cloudRow(), error: null });

    await expect(loadCloudCvDocument(h.client, "cv-1", "en")).resolves.toEqual(
      expect.objectContaining({ id: "cv-1", storageKind: "cloud", data: sampleCvDataEn }),
    );
    expect(h.query.eq).toHaveBeenCalledWith("id", "cv-1");
  });

  it("fails with localized controlled errors for wrong mode, invalid schema, and missing rows", async () => {
    const encrypted = createSupabaseQuery({
      data: cloudRow({ storage_mode: "encrypted", data: null, encrypted_payload: encryptedPayload }),
      error: null,
    });
    const invalid = createSupabaseQuery({ data: cloudRow({ data: { schemaVersion: 7 } }), error: null });
    const missing = createSupabaseQuery({ data: null, error: null });

    await expect(loadCloudCvDocument(encrypted.client, "cv-1", "zh")).rejects.toThrow(
      "加密简历需要先解锁才能编辑。",
    );
    await expect(loadCloudCvDocument(invalid.client, "cv-1", "en")).rejects.toThrow(
      "Cloud CV data does not match the current CV schema.",
    );
    await expect(loadCloudCvDocument(missing.client, "cv-1", "zh")).rejects.toThrow("未找到该云端简历。");
  });

  it("loads encrypted payloads and rejects plain rows on the encrypted path", async () => {
    const encrypted = createSupabaseQuery({
      data: cloudRow({ storage_mode: "encrypted", data: null, encrypted_payload: encryptedPayload }),
      error: null,
    });
    const plain = createSupabaseQuery({ data: cloudRow(), error: null });

    await expect(loadEncryptedCloudCvDocument(encrypted.client, "cv-1", "en")).resolves.toEqual(
      expect.objectContaining({ storageKind: "encrypted", encryptedPayload }),
    );
    await expect(loadEncryptedCloudCvDocument(plain.client, "cv-1", "zh")).rejects.toThrow(
      "此云端简历未加密。",
    );
  });

  it("propagates Supabase errors without attempting row conversion", async () => {
    const failure = new Error("database unavailable");
    const h = createSupabaseQuery({ data: null, error: failure });

    await expect(loadCloudCvDocument(h.client, "cv-1")).rejects.toBe(failure);
  });
});

describe("cloud CV write query shaping", () => {
  it("creates a plain document with the current schema version", async () => {
    const data = cloneCvData(sampleCvDataEn);
    const h = createSupabaseQuery({ data: cloudRow({ title: "New CV", data }), error: null });

    await expect(createCloudCvDocument(h.client, { title: "New CV", data }, "en")).resolves.toEqual(
      expect.objectContaining({ title: "New CV", storageKind: "cloud" }),
    );
    expect(h.query.insert).toHaveBeenCalledWith({
      data,
      schema_version: data.schemaVersion,
      storage_mode: "plain",
      title: "New CV",
    });
  });

  it("creates and updates encrypted documents without sending plaintext", async () => {
    const encryptedRow = cloudRow({
      storage_mode: "encrypted",
      data: null,
      encrypted_payload: encryptedPayload,
    });
    const create = createSupabaseQuery({ data: encryptedRow, error: null });
    const update = createSupabaseQuery({ data: encryptedRow, error: null });

    await createEncryptedCloudCvDocument(create.client, {
      title: "Encrypted CV",
      encryptedPayload,
      schemaVersion: 7,
    });
    await updateEncryptedCloudCvDocumentData(update.client, "cv-1", {
      encryptedPayload,
      schemaVersion: 7,
    });

    expect(create.query.insert).toHaveBeenCalledWith({
      encrypted_payload: encryptedPayload,
      schema_version: 7,
      storage_mode: "encrypted",
      title: "Encrypted CV",
    });
    expect(update.query.update).toHaveBeenCalledWith({
      encrypted_payload: encryptedPayload,
      schema_version: 7,
    });
    expect(update.query.eq).toHaveBeenNthCalledWith(1, "id", "cv-1");
    expect(update.query.eq).toHaveBeenNthCalledWith(2, "storage_mode", "encrypted");
  });

  it("updates only plain rows and carries the schema version", async () => {
    const data = cloneCvData(sampleCvDataEn);
    data.header.name = "Updated";
    const h = createSupabaseQuery({ data: cloudRow({ data }), error: null });

    await updateCloudCvDocumentData(h.client, "cv-1", data);

    expect(h.query.update).toHaveBeenCalledWith({ data, schema_version: data.schemaVersion });
    expect(h.query.eq).toHaveBeenNthCalledWith(1, "id", "cv-1");
    expect(h.query.eq).toHaveBeenNthCalledWith(2, "storage_mode", "plain");
  });

  it("converts an existing plain row atomically by nulling plaintext", async () => {
    const h = createSupabaseQuery({
      data: cloudRow({ storage_mode: "encrypted", data: null, encrypted_payload: encryptedPayload }),
      error: null,
    });

    await encryptExistingCloudCvDocument(h.client, "cv-1", { encryptedPayload, schemaVersion: 7 });

    expect(h.query.update).toHaveBeenCalledWith({
      data: null,
      encrypted_payload: encryptedPayload,
      schema_version: 7,
      storage_mode: "encrypted",
    });
    expect(h.query.eq).toHaveBeenNthCalledWith(2, "storage_mode", "plain");
  });

  it("renames and deletes by id while propagating write failures", async () => {
    const rename = createSupabaseQuery({ data: cloudRow({ title: "Renamed" }), error: null });
    const deletion = createSupabaseQuery({ data: null, error: null });
    const failure = new Error("delete denied");
    const denied = createSupabaseQuery({ data: null, error: failure });

    await expect(renameCloudCvDocument(rename.client, "cv-1", "Renamed")).resolves.toEqual(
      expect.objectContaining({ id: "cv-1", title: "Renamed" }),
    );
    await expect(deleteCloudCvDocument(deletion.client, "cv-1")).resolves.toBeUndefined();
    await expect(deleteCloudCvDocument(denied.client, "cv-1")).rejects.toBe(failure);

    expect(rename.query.update).toHaveBeenCalledWith({ title: "Renamed" });
    expect(deletion.query.delete).toHaveBeenCalledTimes(1);
    expect(deletion.query.eq).toHaveBeenCalledWith("id", "cv-1");
  });
});
