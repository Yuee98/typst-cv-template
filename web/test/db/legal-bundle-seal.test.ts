import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const PERMISSION_DENIED = "42501";

interface ManifestFixture {
  legal_manifest_id: string;
  manifest_sha256: string;
}

function canonicalManifestSetHash(manifests: ManifestFixture[]): string {
  const canonical = [...manifests]
    .sort((left, right) => Buffer.from(left.legal_manifest_id).compare(Buffer.from(right.legal_manifest_id)))
    .map(
      ({ legal_manifest_id: id, manifest_sha256: hash }) =>
        `${Buffer.byteLength(id, "utf8")}:${id}:${hash}`,
    )
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

describe.skipIf(!RUN_DB_TESTS)("immutable legal bundle seal (real DB)", () => {
  let service: SupabaseClient;
  let user: TestUser;

  beforeAll(async () => {
    service = createServiceClient();
    user = await createTestUser(service, "legal-seal");
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  function bundleVersion(label: string): string {
    return `test-${label}-${crypto.randomUUID()}`;
  }

  function manifestId(label: string): string {
    return `test-${label}-${crypto.randomUUID()}`;
  }

  async function registerManifests(manifests: ManifestFixture[]) {
    const result = await service.from("ai_legal_manifest_versions").insert(manifests);
    expect(result.error).toBeNull();
  }

  async function insertHeader(version: string, manifestSetHash: string) {
    return service.from("ai_legal_bundle_versions").insert({
      legal_bundle_version: version,
      bundle_contract_sha256: "a".repeat(64),
      manifest_set_sha256: manifestSetHash,
    });
  }

  it("rejects NULL/malformed hashes, pre-sealed rows, and empty sealing", async () => {
    const nullHash = await service.from("ai_legal_bundle_versions").insert({
      legal_bundle_version: bundleVersion("null-hash"),
      bundle_contract_sha256: "a".repeat(64),
      manifest_set_sha256: null,
    });
    expect(nullHash.error?.code).toBe(NOT_NULL_VIOLATION);

    const malformed = await insertHeader(bundleVersion("malformed"), "A".repeat(64));
    expect(malformed.error?.code).toBe(CHECK_VIOLATION);

    const presealed = await service.from("ai_legal_bundle_versions").insert({
      legal_bundle_version: bundleVersion("presealed"),
      bundle_contract_sha256: "a".repeat(64),
      manifest_set_sha256: "b".repeat(64),
      sealed_at: new Date().toISOString(),
    });
    expect(presealed.error?.code).toBe(CHECK_VIOLATION);

    const emptyVersion = bundleVersion("empty");
    expect((await insertHeader(emptyVersion, "b".repeat(64))).error).toBeNull();
    const emptySeal = await service
      .from("ai_legal_bundle_versions")
      .update({ sealed_at: new Date().toISOString() })
      .eq("legal_bundle_version", emptyVersion);
    expect(emptySeal.error?.code).toBe(CHECK_VIOLATION);
  });

  it("compares the complete canonical sorted manifest-set hash", async () => {
    const manifests: ManifestFixture[] = [
      { legal_manifest_id: manifestId("mimo"), manifest_sha256: "2".repeat(64) },
      { legal_manifest_id: manifestId("deepseek"), manifest_sha256: "1".repeat(64) },
    ];
    await registerManifests(manifests);

    const mismatchVersion = bundleVersion("mismatch");
    expect((await insertHeader(mismatchVersion, "f".repeat(64))).error).toBeNull();
    expect(
      (
        await service.from("ai_legal_bundle_manifests").insert(
          manifests.map((manifest) => ({
            legal_bundle_version: mismatchVersion,
            ...manifest,
          })),
        )
      ).error,
    ).toBeNull();
    const mismatchSeal = await service
      .from("ai_legal_bundle_versions")
      .update({ sealed_at: new Date().toISOString() })
      .eq("legal_bundle_version", mismatchVersion);
    expect(mismatchSeal.error?.code).toBe(CHECK_VIOLATION);

    const sealedVersion = bundleVersion("sealed");
    const expectedHash = canonicalManifestSetHash(manifests);
    expect((await insertHeader(sealedVersion, expectedHash)).error).toBeNull();
    expect(
      (
        await service.from("ai_legal_bundle_manifests").insert(
          manifests.map((manifest) => ({
            legal_bundle_version: sealedVersion,
            ...manifest,
          })),
        )
      ).error,
    ).toBeNull();

    const seal = await service
      .from("ai_legal_bundle_versions")
      .update({ sealed_at: new Date().toISOString() })
      .eq("legal_bundle_version", sealedVersion)
      .select("sealed_at")
      .single();
    expect(seal.error).toBeNull();
    expect(seal.data?.sealed_at).toBeTruthy();

    const append = await service.from("ai_legal_bundle_manifests").insert({
      legal_bundle_version: sealedVersion,
      legal_manifest_id: "extra-v1",
      manifest_sha256: "3".repeat(64),
    });
    expect(append.error?.code).toBe(CHECK_VIOLATION);

    const mutateChild = await service
      .from("ai_legal_bundle_manifests")
      .update({ manifest_sha256: "4".repeat(64) })
      .eq("legal_bundle_version", sealedVersion)
      .eq("legal_manifest_id", manifests[0].legal_manifest_id);
    expect(mutateChild.error?.code).toBe(CHECK_VIOLATION);

    const deleteChild = await service
      .from("ai_legal_bundle_manifests")
      .delete()
      .eq("legal_bundle_version", sealedVersion)
      .eq("legal_manifest_id", manifests[0].legal_manifest_id);
    expect(deleteChild.error?.code).toBe(CHECK_VIOLATION);

    const mutateHeader = await service
      .from("ai_legal_bundle_versions")
      .update({ bundle_contract_sha256: "5".repeat(64) })
      .eq("legal_bundle_version", sealedVersion);
    expect(mutateHeader.error?.code).toBe(CHECK_VIOLATION);

    const deleteHeader = await service
      .from("ai_legal_bundle_versions")
      .delete()
      .eq("legal_bundle_version", sealedVersion);
    expect(deleteHeader.error?.code).toBe(CHECK_VIOLATION);
  });

  it("allows draft manifest correction but rejects a seal before creation", async () => {
    const version = bundleVersion("draft-correction");
    const manifest: ManifestFixture = {
      legal_manifest_id: manifestId("draft-original"),
      manifest_sha256: "6".repeat(64),
    };
    const correctedManifest: ManifestFixture = {
      legal_manifest_id: manifestId("draft-corrected"),
      manifest_sha256: "7".repeat(64),
    };
    await registerManifests([manifest, correctedManifest]);
    expect((await insertHeader(version, canonicalManifestSetHash([manifest]))).error).toBeNull();
    expect(
      (
        await service.from("ai_legal_bundle_manifests").insert({
          legal_bundle_version: version,
          ...manifest,
        })
      ).error,
    ).toBeNull();

    const removeDraftChild = await service
      .from("ai_legal_bundle_manifests")
      .delete()
      .eq("legal_bundle_version", version)
      .eq("legal_manifest_id", manifest.legal_manifest_id);
    expect(removeDraftChild.error).toBeNull();
    const correction = await service.from("ai_legal_bundle_manifests").insert({
      legal_bundle_version: version,
      ...correctedManifest,
    });
    expect(correction.error).toBeNull();

    const futureVersion = bundleVersion("future");
    const futureManifest: ManifestFixture = {
      legal_manifest_id: manifestId("future"),
      manifest_sha256: "8".repeat(64),
    };
    await registerManifests([futureManifest]);
    const createdAt = "2030-01-02T00:00:00Z";
    const futureHeader = await service.from("ai_legal_bundle_versions").insert({
      legal_bundle_version: futureVersion,
      bundle_contract_sha256: "a".repeat(64),
      manifest_set_sha256: canonicalManifestSetHash([futureManifest]),
      created_at: createdAt,
    });
    expect(futureHeader.error).toBeNull();
    expect(
      (
        await service.from("ai_legal_bundle_manifests").insert({
          legal_bundle_version: futureVersion,
          ...futureManifest,
        })
      ).error,
    ).toBeNull();
    const earlySeal = await service
      .from("ai_legal_bundle_versions")
      .update({ sealed_at: "2030-01-01T00:00:00Z" })
      .eq("legal_bundle_version", futureVersion);
    expect(earlySeal.error?.code).toBe(CHECK_VIOLATION);
  });

  it("denies legal bundle identifiers and hashes to anon/authenticated roles", async () => {
    const anon = createAnonClient();
    const authenticated = await signInAsUser(user);

    for (const client of [anon, authenticated]) {
      for (const table of [
        "ai_legal_manifest_versions",
        "ai_legal_bundle_versions",
        "ai_legal_bundle_manifests",
      ] as const) {
        const { data, error } = await client.from(table).select("*").limit(1);
        expect(data, table).toBeNull();
        expect(error?.code, table).toBe(PERMISSION_DENIED);
      }
    }
  });
});
