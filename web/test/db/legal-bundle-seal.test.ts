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
import { runOwnerSql } from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const PERMISSION_DENIED = "42501";

interface ManifestFixture {
  legal_manifest_id: string;
  manifest_sha256: string;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

  function ownerDomainProbe(sql: string, expectedSqlState?: string) {
    const result = runOwnerSql(
      String.raw`\set VERBOSITY verbose
${sql}`,
      { expectFailure: expectedSqlState !== undefined },
    );
    if (expectedSqlState !== undefined) {
      expect(result.stderr + result.stdout).toContain(expectedSqlState);
    }
    return result;
  }

  function registerManifests(manifests: ManifestFixture[]) {
    const values = manifests
      .map(
        (manifest) =>
          `(${sqlLiteral(manifest.legal_manifest_id)}, ${sqlLiteral(manifest.manifest_sha256)})`,
      )
      .join(",\n        ");
    const result = runOwnerSql(String.raw`
      insert into public.ai_legal_manifest_versions (
        legal_manifest_id, manifest_sha256
      ) values
        ${values};
    `);
    expect(result.status).toBe(0);
  }

  function attachManifest(version: string, manifest: ManifestFixture): void {
    const result = runOwnerSql(String.raw`
      insert into public.ai_legal_bundle_manifests (
        legal_bundle_version, legal_manifest_id, manifest_sha256
      ) values (
        ${sqlLiteral(version)},
        ${sqlLiteral(manifest.legal_manifest_id)},
        ${sqlLiteral(manifest.manifest_sha256)}
      );
    `);
    expect(result.status).toBe(0);
  }

  function insertHeader(
    version: string,
    manifestSetHash: string,
    expectedSqlState?: string,
  ): string | null {
    const result = ownerDomainProbe(
      String.raw`
        insert into public.ai_legal_bundle_versions (
          legal_bundle_version, bundle_contract_sha256, manifest_set_sha256
        ) values (
          ${sqlLiteral(version)},
          '${"a".repeat(64)}',
          ${sqlLiteral(manifestSetHash)}
        )
        returning created_at as fixture_created_at
        \gset
        \echo DB_LEGAL_CREATED_AT=:fixture_created_at
      `,
      expectedSqlState,
    );
    if (expectedSqlState !== undefined) {
      return null;
    }
    const match = /^DB_LEGAL_CREATED_AT=(.+)$/mu.exec(result.stdout);
    expect(match).not.toBeNull();
    return match![1].trim();
  }

  it("rejects NULL/malformed hashes, pre-sealed rows, and empty sealing", async () => {
    ownerDomainProbe(
      String.raw`
        insert into public.ai_legal_bundle_versions (
          legal_bundle_version, bundle_contract_sha256, manifest_set_sha256
        ) values (
          ${sqlLiteral(bundleVersion("null-hash"))},
          '${"a".repeat(64)}',
          null
        );
      `,
      NOT_NULL_VIOLATION,
    );

    insertHeader(
      bundleVersion("malformed"),
      "A".repeat(64),
      CHECK_VIOLATION,
    );

    ownerDomainProbe(
      String.raw`
        insert into public.ai_legal_bundle_versions (
          legal_bundle_version, bundle_contract_sha256,
          manifest_set_sha256, sealed_at
        ) values (
          ${sqlLiteral(bundleVersion("presealed"))},
          '${"a".repeat(64)}',
          '${"b".repeat(64)}',
          clock_timestamp()
        );
      `,
      CHECK_VIOLATION,
    );

    const emptyVersion = bundleVersion("empty");
    const emptyCreatedAt = insertHeader(emptyVersion, "b".repeat(64));
    expect(emptyCreatedAt).not.toBeNull();
    const emptySeal = ownerDomainProbe(
      String.raw`
        update public.ai_legal_bundle_versions
        set sealed_at = ${sqlLiteral(emptyCreatedAt!)}::timestamptz
        where legal_bundle_version = ${sqlLiteral(emptyVersion)};
      `,
      CHECK_VIOLATION,
    );
    expect(emptySeal.stderr).toContain(
      "ai legal bundle cannot seal an empty manifest set",
    );
  });

  it("compares the complete canonical sorted manifest-set hash", async () => {
    const manifests: ManifestFixture[] = [
      { legal_manifest_id: manifestId("mimo"), manifest_sha256: "2".repeat(64) },
      { legal_manifest_id: manifestId("deepseek"), manifest_sha256: "1".repeat(64) },
    ];
    await registerManifests(manifests);

    const mismatchVersion = bundleVersion("mismatch");
    const mismatchCreatedAt = insertHeader(mismatchVersion, "f".repeat(64));
    expect(mismatchCreatedAt).not.toBeNull();
    manifests.forEach((manifest) => attachManifest(mismatchVersion, manifest));
    ownerDomainProbe(
      String.raw`
        update public.ai_legal_bundle_versions
        set sealed_at = ${sqlLiteral(mismatchCreatedAt!)}::timestamptz
        where legal_bundle_version = ${sqlLiteral(mismatchVersion)};
      `,
      CHECK_VIOLATION,
    );

    const sealedVersion = bundleVersion("sealed");
    const expectedHash = canonicalManifestSetHash(manifests);
    const sealedCreatedAt = insertHeader(sealedVersion, expectedHash);
    expect(sealedCreatedAt).not.toBeNull();
    manifests.forEach((manifest) => attachManifest(sealedVersion, manifest));

    ownerDomainProbe(String.raw`
      update public.ai_legal_bundle_versions
      set sealed_at = ${sqlLiteral(sealedCreatedAt!)}::timestamptz
      where legal_bundle_version = ${sqlLiteral(sealedVersion)};
    `);
    const seal = await service
      .from("ai_legal_bundle_versions")
      .select("sealed_at")
      .eq("legal_bundle_version", sealedVersion)
      .single();
    expect(seal.error).toBeNull();
    expect(seal.data?.sealed_at).toBeTruthy();

    const extraManifest = {
      legal_manifest_id: manifestId("extra"),
      manifest_sha256: "3".repeat(64),
    };
    registerManifests([extraManifest]);

    const append = await service.from("ai_legal_bundle_manifests").insert({
      legal_bundle_version: sealedVersion,
      ...extraManifest,
    });
    expect(append.error?.code).toBe(PERMISSION_DENIED);

    const mutateChild = await service
      .from("ai_legal_bundle_manifests")
      .update({ manifest_sha256: "4".repeat(64) })
      .eq("legal_bundle_version", sealedVersion)
      .eq("legal_manifest_id", manifests[0].legal_manifest_id);
    expect(mutateChild.error?.code).toBe(PERMISSION_DENIED);

    const deleteChild = await service
      .from("ai_legal_bundle_manifests")
      .delete()
      .eq("legal_bundle_version", sealedVersion)
      .eq("legal_manifest_id", manifests[0].legal_manifest_id);
    expect(deleteChild.error?.code).toBe(PERMISSION_DENIED);

    ownerDomainProbe(
      String.raw`
        insert into public.ai_legal_bundle_manifests (
          legal_bundle_version, legal_manifest_id, manifest_sha256
        ) values (
          ${sqlLiteral(sealedVersion)},
          ${sqlLiteral(extraManifest.legal_manifest_id)},
          ${sqlLiteral(extraManifest.manifest_sha256)}
        );
      `,
      CHECK_VIOLATION,
    );
    ownerDomainProbe(
      String.raw`
        update public.ai_legal_bundle_manifests
        set manifest_sha256 = '${"4".repeat(64)}'
        where legal_bundle_version = ${sqlLiteral(sealedVersion)}
          and legal_manifest_id = ${sqlLiteral(manifests[0].legal_manifest_id)};
      `,
      CHECK_VIOLATION,
    );
    ownerDomainProbe(
      String.raw`
        delete from public.ai_legal_bundle_manifests
        where legal_bundle_version = ${sqlLiteral(sealedVersion)}
          and legal_manifest_id = ${sqlLiteral(manifests[0].legal_manifest_id)};
      `,
      CHECK_VIOLATION,
    );

    ownerDomainProbe(
      String.raw`
        update public.ai_legal_bundle_versions
        set bundle_contract_sha256 = '${"5".repeat(64)}'
        where legal_bundle_version = ${sqlLiteral(sealedVersion)};
      `,
      CHECK_VIOLATION,
    );

    ownerDomainProbe(
      String.raw`
        delete from public.ai_legal_bundle_versions
        where legal_bundle_version = ${sqlLiteral(sealedVersion)};
      `,
      CHECK_VIOLATION,
    );
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
    expect(insertHeader(version, canonicalManifestSetHash([manifest]))).not.toBeNull();
    attachManifest(version, manifest);

    const removeDraftChild = runOwnerSql(`delete from public.ai_legal_bundle_manifests where legal_bundle_version='${version}' and legal_manifest_id='${manifest.legal_manifest_id}';`);
    expect(removeDraftChild.status).toBe(0);
    attachManifest(version, correctedManifest);

    const futureVersion = bundleVersion("future");
    const futureManifest: ManifestFixture = {
      legal_manifest_id: manifestId("future"),
      manifest_sha256: "8".repeat(64),
    };
    await registerManifests([futureManifest]);
    const createdAt = "2030-01-02T00:00:00Z";
    const futureHeader = runOwnerSql(String.raw`\pset format unaligned
\pset tuples_only on
insert into public.ai_legal_bundle_versions(legal_bundle_version,bundle_contract_sha256,manifest_set_sha256,created_at) values ('${futureVersion}','${"a".repeat(64)}','${canonicalManifestSetHash([futureManifest])}','${createdAt}') returning created_at;`);
    expect(futureHeader.status).toBe(0);
    attachManifest(futureVersion, futureManifest);
    ownerDomainProbe(
      String.raw`
        update public.ai_legal_bundle_versions
        set sealed_at = '2030-01-01T00:00:00Z'::timestamptz
        where legal_bundle_version = ${sqlLiteral(futureVersion)};
      `,
      CHECK_VIOLATION,
    );
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
