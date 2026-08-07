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

type QueryMethod = "delete" | "eq" | "insert" | "order" | "select" | "single" | "update";

type QueryOperation = {
  args: unknown[];
  method: QueryMethod;
  terminal?: true;
};

const cloudDocumentColumns =
  "id,title,storage_mode,data,encrypted_payload,schema_version,created_at,updated_at";

function operation(method: QueryMethod, args: unknown[] = [], terminal = false): QueryOperation {
  return { method, args, ...(terminal ? { terminal: true as const } : {}) };
}

function loadOperations(id: string): QueryOperation[] {
  return [
    operation("select", [cloudDocumentColumns]),
    operation("eq", ["id", id]),
    operation("single", [], true),
  ];
}

function createSupabaseQuery(response: QueryResponse, expectedOperations: QueryOperation[]) {
  let operationIndex = 0;
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<QueryResponse>["then"];
  } = {};

  function consume(method: QueryMethod, args: unknown[]) {
    const expected = expectedOperations[operationIndex];
    if (!expected || expected.method !== method) {
      throw new Error(
        `Unexpected Supabase query operation ${method}; expected ${expected?.method ?? "end of query"}.`,
      );
    }
    expect(args).toEqual(expected.args);
    operationIndex += 1;
    return expected;
  }

  for (const method of ["delete", "eq", "insert", "select", "update"] as const) {
    query[method] = vi.fn((...args: unknown[]) => {
      consume(method, args);
      return query;
    });
  }
  for (const method of ["order", "single"] as const) {
    query[method] = vi.fn(async (...args: unknown[]) => {
      const expected = consume(method, args);
      if (!expected.terminal) {
        throw new Error(`Supabase query operation ${method} was not expected to be terminal.`);
      }
      return response;
    });
  }
  query.then = (onFulfilled, onRejected) => {
    if (operationIndex !== expectedOperations.length) {
      const next = expectedOperations[operationIndex];
      return Promise.reject(
        new Error(`Supabase query was awaited before required ${next?.method ?? "terminal"} operation.`),
      ).then(onFulfilled, onRejected);
    }
    return Promise.resolve(response).then(onFulfilled, onRejected);
  };

  const from = vi.fn((table: string) => {
    if (table !== "cv_documents") {
      throw new Error(`Unexpected Supabase table ${table}.`);
    }
    return query;
  });
  return {
    assertComplete() {
      expect(from).toHaveBeenCalledTimes(1);
      expect(operationIndex).toBe(expectedOperations.length);
    },
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

describe("cloud CV write query shaping", () => {
  it("creates a plain document with the current schema version", async () => {
    const data = cloneCvData(sampleCvDataEn);
    const insert = {
      data,
      schema_version: data.schemaVersion,
      storage_mode: "plain",
      title: "New CV",
    };
    const h = createSupabaseQuery(
      { data: cloudRow({ title: "New CV", data }), error: null },
      [
        operation("insert", [insert]),
        operation("select", [cloudDocumentColumns]),
        operation("single", [], true),
      ],
    );

    await expect(createCloudCvDocument(h.client, { title: "New CV", data }, "en")).resolves.toEqual(
      expect.objectContaining({ title: "New CV", storageKind: "cloud" }),
    );
    expect(h.query.insert).toHaveBeenCalledWith(insert);
    h.assertComplete();
  });

  it("creates and updates encrypted documents without sending plaintext", async () => {
    const encryptedRow = cloudRow({
      storage_mode: "encrypted",
      data: null,
      encrypted_payload: encryptedPayload,
    });
    const createPayload = {
      encrypted_payload: encryptedPayload,
      schema_version: 7,
      storage_mode: "encrypted",
      title: "Encrypted CV",
    };
    const updatePayload = {
      encrypted_payload: encryptedPayload,
      schema_version: 7,
    };
    const create = createSupabaseQuery(
      { data: encryptedRow, error: null },
      [
        operation("insert", [createPayload]),
        operation("select", [cloudDocumentColumns]),
        operation("single", [], true),
      ],
    );
    const update = createSupabaseQuery(
      { data: encryptedRow, error: null },
      [
        operation("update", [updatePayload]),
        operation("eq", ["id", "cv-1"]),
        operation("eq", ["storage_mode", "encrypted"]),
        operation("select", [cloudDocumentColumns]),
        operation("single", [], true),
      ],
    );

    await createEncryptedCloudCvDocument(create.client, {
      title: "Encrypted CV",
      encryptedPayload,
      schemaVersion: 7,
    });
    await updateEncryptedCloudCvDocumentData(update.client, "cv-1", {
      encryptedPayload,
      schemaVersion: 7,
    });

    expect(create.query.insert).toHaveBeenCalledWith(createPayload);
    expect(update.query.update).toHaveBeenCalledWith(updatePayload);
    expect(update.query.eq).toHaveBeenNthCalledWith(1, "id", "cv-1");
    expect(update.query.eq).toHaveBeenNthCalledWith(2, "storage_mode", "encrypted");
    create.assertComplete();
    update.assertComplete();
  });

  it("updates only plain rows and carries the schema version", async () => {
    const data = cloneCvData(sampleCvDataEn);
    data.header.name = "Updated";
    const update = { data, schema_version: data.schemaVersion };
    const h = createSupabaseQuery(
      { data: cloudRow({ data }), error: null },
      [
        operation("update", [update]),
        operation("eq", ["id", "cv-1"]),
        operation("eq", ["storage_mode", "plain"]),
        operation("select", [cloudDocumentColumns]),
        operation("single", [], true),
      ],
    );

    await updateCloudCvDocumentData(h.client, "cv-1", data);

    expect(h.query.update).toHaveBeenCalledWith(update);
    expect(h.query.eq).toHaveBeenNthCalledWith(1, "id", "cv-1");
    expect(h.query.eq).toHaveBeenNthCalledWith(2, "storage_mode", "plain");
    h.assertComplete();
  });

  it("converts an existing plain row atomically by nulling plaintext", async () => {
    const update = {
      data: null,
      encrypted_payload: encryptedPayload,
      schema_version: 7,
      storage_mode: "encrypted",
    };
    const h = createSupabaseQuery(
      {
        data: cloudRow({ storage_mode: "encrypted", data: null, encrypted_payload: encryptedPayload }),
        error: null,
      },
      [
        operation("update", [update]),
        operation("eq", ["id", "cv-1"]),
        operation("eq", ["storage_mode", "plain"]),
        operation("select", [cloudDocumentColumns]),
        operation("single", [], true),
      ],
    );

    await encryptExistingCloudCvDocument(h.client, "cv-1", { encryptedPayload, schemaVersion: 7 });

    expect(h.query.update).toHaveBeenCalledWith(update);
    expect(h.query.eq).toHaveBeenNthCalledWith(2, "storage_mode", "plain");
    h.assertComplete();
  });

  it("renames and deletes by id while propagating write failures", async () => {
    const rename = createSupabaseQuery(
      { data: cloudRow({ title: "Renamed" }), error: null },
      [
        operation("update", [{ title: "Renamed" }]),
        operation("eq", ["id", "cv-1"]),
        operation("select", [cloudDocumentColumns]),
        operation("single", [], true),
      ],
    );
    const deleteOperations = [operation("delete"), operation("eq", ["id", "cv-1"])];
    const deletion = createSupabaseQuery({ data: null, error: null }, deleteOperations);
    const failure = new Error("delete denied");
    const denied = createSupabaseQuery({ data: null, error: failure }, deleteOperations);

    await expect(renameCloudCvDocument(rename.client, "cv-1", "Renamed")).resolves.toEqual(
      expect.objectContaining({ id: "cv-1", title: "Renamed" }),
    );
    await expect(deleteCloudCvDocument(deletion.client, "cv-1")).resolves.toBeUndefined();
    await expect(deleteCloudCvDocument(denied.client, "cv-1")).rejects.toBe(failure);

    expect(rename.query.update).toHaveBeenCalledWith({ title: "Renamed" });
    expect(deletion.query.delete).toHaveBeenCalledTimes(1);
    expect(deletion.query.eq).toHaveBeenCalledWith("id", "cv-1");
    rename.assertComplete();
    deletion.assertComplete();
    denied.assertComplete();
  });
});
