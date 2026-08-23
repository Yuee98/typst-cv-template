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

const PERMISSION_DENIED = "42501";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

const PROVIDER_TABLES = [
  "ai_provider_profiles",
  "ai_provider_profile_versions",
  "ai_price_versions",
  "ai_price_components",
  "ai_routing_policy_versions",
] as const;

function versionFixture(profileId: string, version = 1) {
  return {
    profile_id: profileId,
    version,
    status: "draft",
    adapter_kind: "fixture_adapter_v1",
    wire_api_kind: "responses_v1",
    credential_alias: "fixture_credential_v1",
    endpoint_alias: "fixture_endpoint_v1",
    model_id: "fixture-model",
    upstream_route: {},
    capability_contract_id: "fixture_capability_v1",
    cache_policy_id: "fixture_cache_v1",
    legal_manifest_id: "fixture_legal_v1",
    config: {},
    config_sha256: "a".repeat(64),
  };
}

describe.skipIf(!RUN_DB_TESTS)("provider profile foundation (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let authed: SupabaseClient;
  let user: TestUser;

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    user = await createTestUser(service, "provider-security");
    authed = await signInAsUser(user);
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  async function createProfile(label: string) {
    const { data, error } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.${label}.${crypto.randomUUID()}`,
        display_name: `Test ${label}`,
        gateway_kind: "direct_mimo",
        model_vendor: "fixture",
      })
      .select("*")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  it("stores a stable identity and immutable execution version", async () => {
    const profile = await createProfile("immutable");
    const { data: version, error } = await service
      .from("ai_provider_profile_versions")
      .insert(versionFixture(profile.id))
      .select("*")
      .single();
    expect(error).toBeNull();
    expect(version).toMatchObject({
      profile_id: profile.id,
      version: 1,
      status: "draft",
      wire_api_kind: "responses_v1",
    });

    const { error: identityError } = await service
      .from("ai_provider_profiles")
      .update({ profile_key: `changed.${crypto.randomUUID()}` })
      .eq("id", profile.id);
    expect(identityError?.code).toBe(CHECK_VIOLATION);

    const { error: configError } = await service
      .from("ai_provider_profile_versions")
      .update({ config: { changed: true } })
      .eq("id", version!.id);
    expect(configError?.code).toBe(CHECK_VIOLATION);

    const { error: deleteError } = await service
      .from("ai_provider_profiles")
      .delete()
      .eq("id", profile.id);
    expect(deleteError?.code).toBe(CHECK_VIOLATION);
  });

  it("enforces unique versions, required aliases, and valid states", async () => {
    const profile = await createProfile("constraints");
    const fixture = versionFixture(profile.id);
    expect(
      (await service.from("ai_provider_profile_versions").insert(fixture)).error,
    ).toBeNull();

    const duplicate = await service
      .from("ai_provider_profile_versions")
      .insert(fixture);
    expect(duplicate.error?.code).toBe(UNIQUE_VIOLATION);

    const invalidState = await service
      .from("ai_provider_profile_versions")
      .insert({ ...versionFixture(profile.id, 2), status: "ready" });
    expect(invalidState.error?.code).toBe(CHECK_VIOLATION);

    const blankAlias = await service
      .from("ai_provider_profile_versions")
      .insert({ ...versionFixture(profile.id, 3), endpoint_alias: " " });
    expect(blankAlias.error?.code).toBe(CHECK_VIOLATION);

    for (const [index, status] of [
      "validated",
      "canary",
      "active",
      "retired",
    ].entries()) {
      const nonDraftInsert = await service
        .from("ai_provider_profile_versions")
        .insert({ ...versionFixture(profile.id, 10 + index), status });
      expect(nonDraftInsert.error?.code).toBe(CHECK_VIOLATION);
    }
  });

  it("allows only monotonic lifecycle transitions", async () => {
    const profile = await createProfile("lifecycle");
    const { data: version } = await service
      .from("ai_provider_profile_versions")
      .insert(versionFixture(profile.id))
      .select("id")
      .single();

    const validated = await service
      .from("ai_provider_profile_versions")
      .update({ status: "validated" })
      .eq("id", version!.id)
      .select("status,validated_at")
      .single();
    expect(validated.error).toBeNull();
    expect(validated.data?.validated_at).toBeTruthy();

    const active = await service
      .from("ai_provider_profile_versions")
      .update({ status: "active" })
      .eq("id", version!.id)
      .select("status,activated_at")
      .single();
    expect(active.error).toBeNull();
    expect(active.data?.activated_at).toBeTruthy();

    const rewriteTimestamp = await service
      .from("ai_provider_profile_versions")
      .update({ validated_at: "2026-01-01T00:00:00Z" })
      .eq("id", version!.id);
    expect(rewriteTimestamp.error?.code).toBe(CHECK_VIOLATION);

    const backwards = await service
      .from("ai_provider_profile_versions")
      .update({ status: "draft" })
      .eq("id", version!.id);
    expect(backwards.error?.code).toBe(CHECK_VIOLATION);
  });

  describe.each([
    ["anon", () => anon],
    ["authenticated", () => authed],
  ] as const)("%s is denied provider configuration", (_label, getClient) => {
    it.each(PROVIDER_TABLES)("cannot read %s", async (table) => {
      const { data, error } = await getClient().from(table).select("*").limit(1);
      expect(data).toBeNull();
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it.each(PROVIDER_TABLES)("cannot write %s", async (table) => {
      const { error } = await getClient().from(table).insert({});
      expect(error?.code).toBe(PERMISSION_DENIED);
    });
  });
});
