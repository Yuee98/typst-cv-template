import { describe, expect, it } from "vitest";

import {
  listCloudCvDocuments,
  loadCloudCvDocument,
  loadEncryptedCloudCvDocument,
} from "@/lib/cv/cloud-storage";
import { sampleCvDataEn } from "@/lib/cv/sample-data";

import {
  cloudDocumentColumns,
  cloudRow,
  createSupabaseQuery,
  encryptedPayload,
  loadOperations,
  operation,
} from "./fixtures";

describe("cloud CV row mapping", () => {
  it("lists summaries in the query order and maps encrypted storage", async () => {
    const plain = cloudRow();
    const encrypted = cloudRow({
      id: "cv-2",
      storage_mode: "encrypted",
      data: null,
      encrypted_payload: encryptedPayload,
    });
    const h = createSupabaseQuery(
      { data: [plain, encrypted], error: null },
      [
        operation("select", [cloudDocumentColumns]),
        operation("order", ["updated_at", { ascending: false }], true),
      ],
    );

    await expect(listCloudCvDocuments(h.client)).resolves.toEqual([
      expect.objectContaining({ id: "cv-1", storageKind: "cloud" }),
      expect.objectContaining({ id: "cv-2", storageKind: "encrypted" }),
    ]);
    expect(h.from).toHaveBeenCalledWith("cv_documents");
    expect(h.query.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    h.assertComplete();
  });

  it("loads and normalizes a valid plain document", async () => {
    const h = createSupabaseQuery({ data: cloudRow(), error: null }, loadOperations("cv-1"));

    await expect(loadCloudCvDocument(h.client, "cv-1", "en")).resolves.toEqual(
      expect.objectContaining({ id: "cv-1", storageKind: "cloud", data: sampleCvDataEn }),
    );
    expect(h.query.eq).toHaveBeenCalledWith("id", "cv-1");
    h.assertComplete();
  });

  it("fails with localized controlled errors for wrong mode, invalid schema, and missing rows", async () => {
    const encrypted = createSupabaseQuery(
      {
        data: cloudRow({ storage_mode: "encrypted", data: null, encrypted_payload: encryptedPayload }),
        error: null,
      },
      loadOperations("cv-1"),
    );
    const invalid = createSupabaseQuery(
      { data: cloudRow({ data: { schemaVersion: 7 } }), error: null },
      loadOperations("cv-1"),
    );
    const missing = createSupabaseQuery({ data: null, error: null }, loadOperations("cv-1"));

    await expect(loadCloudCvDocument(encrypted.client, "cv-1", "zh")).rejects.toThrow(
      "加密简历需要先解锁才能编辑。",
    );
    await expect(loadCloudCvDocument(invalid.client, "cv-1", "en")).rejects.toThrow(
      "Cloud CV data does not match the current CV schema.",
    );
    await expect(loadCloudCvDocument(missing.client, "cv-1", "zh")).rejects.toThrow("未找到该云端简历。");
    encrypted.assertComplete();
    invalid.assertComplete();
    missing.assertComplete();
  });

  it("loads encrypted payloads and rejects plain rows on the encrypted path", async () => {
    const encrypted = createSupabaseQuery(
      {
        data: cloudRow({ storage_mode: "encrypted", data: null, encrypted_payload: encryptedPayload }),
        error: null,
      },
      loadOperations("cv-1"),
    );
    const plain = createSupabaseQuery({ data: cloudRow(), error: null }, loadOperations("cv-1"));

    await expect(loadEncryptedCloudCvDocument(encrypted.client, "cv-1", "en")).resolves.toEqual(
      expect.objectContaining({ storageKind: "encrypted", encryptedPayload }),
    );
    await expect(loadEncryptedCloudCvDocument(plain.client, "cv-1", "zh")).rejects.toThrow(
      "此云端简历未加密。",
    );
    encrypted.assertComplete();
    plain.assertComplete();
  });

  it("propagates Supabase errors without attempting row conversion", async () => {
    const failure = new Error("database unavailable");
    const h = createSupabaseQuery({ data: null, error: failure }, loadOperations("cv-1"));

    await expect(loadCloudCvDocument(h.client, "cv-1")).rejects.toBe(failure);
    h.assertComplete();
  });
});
