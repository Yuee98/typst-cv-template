import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  LEGAL_FINGERPRINT_V1_EXPECTED_SHA256,
  LEGAL_FINGERPRINT_V1_PROFILE_MAPPING,
  MIMO_LEGAL_MANIFEST_ID,
} from "@/server/polish/legal-fingerprint-v1-descriptors";
import { DEEPSEEK_V2_SEED_V1 } from "@/server/polish/deepseek-v2-seed-v1";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";

const EXPECTED_MANIFESTS = Object.freeze([
  Object.freeze({
    legal_manifest_id: DEEPSEEK_LEGAL_MANIFEST_ID,
    manifest_sha256:
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[DEEPSEEK_LEGAL_MANIFEST_ID],
  }),
  Object.freeze({
    legal_manifest_id: MIMO_LEGAL_MANIFEST_ID,
    manifest_sha256:
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[MIMO_LEGAL_MANIFEST_ID],
  }),
]);

function canonicalManifestSetHash(
  manifests: readonly {
    legal_manifest_id: string;
    manifest_sha256: string;
  }[],
): string {
  const canonicalBytes = [...manifests]
    .sort((left, right) =>
      Buffer.from(left.legal_manifest_id, "utf8").compare(
        Buffer.from(right.legal_manifest_id, "utf8"),
      ),
    )
    .map(
      ({ legal_manifest_id: id, manifest_sha256: hash }) =>
        `${Buffer.byteLength(id, "utf8")}:${id}:${hash}`,
    )
    .join("\n");

  return createHash("sha256").update(canonicalBytes, "utf8").digest("hex");
}

const EXPECTED_MANIFEST_SET_SHA256 = canonicalManifestSetHash(
  EXPECTED_MANIFESTS,
);

describe.skipIf(!RUN_DB_TESTS)("CFG-000 initial legal bundle seed (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  it("publishes exactly the reviewed sealed header, catalog, and child set", async () => {
    const [headers, catalog, children] = await Promise.all([
      service
        .from("ai_legal_bundle_versions")
        .select(
          "legal_bundle_version,bundle_contract_sha256,manifest_set_sha256,created_at,sealed_at",
        )
        .eq("legal_bundle_version", INITIAL_LEGAL_BUNDLE_VERSION),
      service
        .from("ai_legal_manifest_versions")
        .select("legal_manifest_id,manifest_sha256")
        .in(
          "legal_manifest_id",
          EXPECTED_MANIFESTS.map((manifest) => manifest.legal_manifest_id),
        )
        .order("legal_manifest_id"),
      service
        .from("ai_legal_bundle_manifests")
        .select("legal_bundle_version,legal_manifest_id,manifest_sha256")
        .eq("legal_bundle_version", INITIAL_LEGAL_BUNDLE_VERSION)
        .order("legal_manifest_id"),
    ]);

    expect(headers.error).toBeNull();
    expect(catalog.error).toBeNull();
    expect(children.error).toBeNull();
    expect(headers.data).toHaveLength(1);
    expect(catalog.data).toEqual(EXPECTED_MANIFESTS);
    expect(children.data).toEqual(
      EXPECTED_MANIFESTS.map((manifest) => ({
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        ...manifest,
      })),
    );

    const header = headers.data?.[0];
    expect(header).toMatchObject({
      legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
      bundle_contract_sha256:
        LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
      manifest_set_sha256: EXPECTED_MANIFEST_SET_SHA256,
    });
    expect(header?.sealed_at).toBeTruthy();
    expect(Date.parse(header!.sealed_at!)).toBeGreaterThanOrEqual(
      Date.parse(header!.created_at),
    );
  });

  it("admits only the later reviewed DeepSeek draft while routing stays inactive", async () => {
    const { data: profiles, error: profileError } = await service
      .from("ai_provider_profiles")
      .select("id,profile_key,display_name,gateway_kind,model_vendor,retired_at")
      .in(
        "profile_key",
        LEGAL_FINGERPRINT_V1_PROFILE_MAPPING.map((profile) => profile.profileKey),
      );
    expect(profileError).toBeNull();
    expect(profiles).toEqual([
      {
        id: DEEPSEEK_V2_SEED_V1.profile.id,
        profile_key: DEEPSEEK_V2_SEED_V1.profile.profileKey,
        display_name: DEEPSEEK_V2_SEED_V1.profile.displayName,
        gateway_kind: DEEPSEEK_V2_SEED_V1.profile.gatewayKind,
        model_vendor: DEEPSEEK_V2_SEED_V1.profile.modelVendor,
        retired_at: null,
      },
    ]);

    const { data: featureConfig, error } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id")
      .eq("id", true)
      .single();
    expect(error).toBeNull();
    expect(featureConfig?.active_routing_policy_version_id).toBeNull();
  });

  it("keeps the CFG migration owner-only and narrowly scoped", () => {
    const migration = readFileSync(
      new URL(
        "../../../supabase/migrations/20260823232500_seed_ai_legal_bundle.sql",
        import.meta.url,
      ),
      "utf8",
    ).toLowerCase();

    expect(migration.match(/^begin;$/gm)).toHaveLength(1);
    expect(migration.match(/^commit;$/gm)).toHaveLength(1);
    expect(migration).not.toMatch(/\bon\s+conflict\b/);
    expect(migration).not.toMatch(/\bcreate\s+(?:or\s+replace\s+)?function\b/);
    expect(migration).not.toMatch(/\bgrant\b/);
    expect(migration).not.toMatch(
      /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:ai_(?:provider_profiles|provider_profile_versions|price_versions|price_components|routing_policy_versions|service_runtime_contract_versions|service_runtime_target_versions|service_runtime_contract_targets|feature_config|request_ledger|provider_attempt_ledger|usage_daily|global_usage_daily|profile_usage_daily|rate_minutes|price_component_seal_intents|routing_policy_transition_intents)|user_terms_acceptances)\b/,
    );
  });
});
