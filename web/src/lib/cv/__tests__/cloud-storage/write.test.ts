import { describe, expect, it } from "vitest";

import {
  createCloudCvDocument,
  createEncryptedCloudCvDocument,
  deleteCloudCvDocument,
  encryptExistingCloudCvDocument,
  renameCloudCvDocument,
  updateCloudCvDocumentData,
  updateEncryptedCloudCvDocumentData,
} from "@/lib/cv/cloud-storage";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";

import {
  cloudDocumentColumns,
  cloudRow,
  createSupabaseQuery,
  encryptedPayload,
  operation,
} from "./fixtures";

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
