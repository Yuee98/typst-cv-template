/**
 * Real-DB contract test for the production cloud-storage adapter. The unit
 * suite verifies exact fluent query construction; this suite proves those
 * queries remain valid against the local Supabase/PostgREST stack and RLS.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCloudCvDocument,
  deleteCloudCvDocument,
  encryptExistingCloudCvDocument,
  listCloudCvDocuments,
  loadCloudCvDocument,
  loadEncryptedCloudCvDocument,
  renameCloudCvDocument,
  updateCloudCvDocumentData,
} from "@/lib/cv/cloud-storage";
import { cloneCvData } from "@/lib/cv/cv-utils";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { acceptCurrentTerms } from "@/lib/legal/terms-acceptance";

import {
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";

const encryptedPayload: EncryptedPayload = {
  version: 1,
  algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256",
  iterations: 100_000,
  salt: "real-db-salt",
  iv: "real-db-iv",
  ciphertext: "real-db-ciphertext",
};

describe.skipIf(!RUN_DB_TESTS)("cloud storage production adapter (real DB)", () => {
  let service: SupabaseClient;
  let user: TestUser;
  let client: SupabaseClient;

  beforeAll(async () => {
    service = createServiceClient();
    user = await createTestUser(service, "cloud-storage");
    client = await signInAsUser(user);
    await acceptCurrentTerms(client);
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  it("runs create, load, update, rename, encrypt, and delete through production queries", async () => {
    const originalData = cloneCvData(sampleCvDataEn);
    originalData.header.name = "Real DB Candidate";

    const created = await createCloudCvDocument(client, {
      title: "Production adapter lifecycle",
      data: originalData,
    });
    expect(created).toMatchObject({
      title: "Production adapter lifecycle",
      storageKind: "cloud",
      data: { header: { name: "Real DB Candidate" } },
    });

    const loaded = await loadCloudCvDocument(client, created.id, "en");
    expect(loaded.data).toEqual(originalData);

    const updatedData = cloneCvData(originalData);
    updatedData.header.name = "Updated Real DB Candidate";
    await updateCloudCvDocumentData(client, created.id, updatedData, "en");
    await expect(loadCloudCvDocument(client, created.id, "en")).resolves.toMatchObject({
      data: { header: { name: "Updated Real DB Candidate" } },
    });

    await expect(renameCloudCvDocument(client, created.id, "Renamed lifecycle")).resolves.toMatchObject({
      id: created.id,
      title: "Renamed lifecycle",
    });

    await expect(
      encryptExistingCloudCvDocument(
        client,
        created.id,
        { encryptedPayload, schemaVersion: updatedData.schemaVersion },
        "en",
      ),
    ).resolves.toMatchObject({
      id: created.id,
      storageKind: "encrypted",
      encryptedPayload,
    });

    const { data: encryptedRow, error: rowError } = await client
      .from("cv_documents")
      .select("data,encrypted_payload,storage_mode")
      .eq("id", created.id)
      .single();
    expect(rowError).toBeNull();
    expect(encryptedRow).toMatchObject({
      data: null,
      encrypted_payload: encryptedPayload,
      storage_mode: "encrypted",
    });
    await expect(loadEncryptedCloudCvDocument(client, created.id, "en")).resolves.toMatchObject({
      encryptedPayload,
      storageKind: "encrypted",
    });

    await deleteCloudCvDocument(client, created.id);
    await expect(listCloudCvDocuments(client)).resolves.toEqual([]);
    await expect(loadCloudCvDocument(client, created.id, "en")).rejects.toThrow(
      "Cloud CV was not found.",
    );
  });
});
