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

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runOwnerDomainProbe(sql: string, expectedSqlState?: string) {
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

function insertVersionAsOwner(
  input: ReturnType<typeof versionFixture> & { created_at?: string },
  expectedSqlState?: string,
): string {
  const id = crypto.randomUUID();
  runOwnerDomainProbe(
    String.raw`
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, status, adapter_kind, wire_api_kind,
        credential_alias, endpoint_alias, model_id, upstream_route,
        capability_contract_id, cache_policy_id, legal_manifest_id,
        config, config_sha256, created_at
      ) values (
        '${id}'::uuid,
        '${input.profile_id}'::uuid,
        ${input.version},
        ${sqlLiteral(input.status)},
        ${sqlLiteral(input.adapter_kind)},
        ${sqlLiteral(input.wire_api_kind)},
        ${sqlLiteral(input.credential_alias)},
        ${sqlLiteral(input.endpoint_alias)},
        ${sqlLiteral(input.model_id)},
        ${sqlLiteral(JSON.stringify(input.upstream_route))}::jsonb,
        ${sqlLiteral(input.capability_contract_id)},
        ${sqlLiteral(input.cache_policy_id)},
        ${sqlLiteral(input.legal_manifest_id)},
        ${sqlLiteral(JSON.stringify(input.config))}::jsonb,
        ${sqlLiteral(input.config_sha256)},
        ${input.created_at === undefined ? "default" : `${sqlLiteral(input.created_at)}::timestamptz`}
      );
    `,
    expectedSqlState,
  );
  return id;
}

function updateVersionAsOwner(
  versionId: string,
  assignment: string,
  expectedSqlState?: string,
) {
  return runOwnerDomainProbe(
    String.raw`
      update public.ai_provider_profile_versions
      set ${assignment}
      where id = '${versionId}'::uuid;
    `,
    expectedSqlState,
  );
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
    const id = crypto.randomUUID();
    runOwnerSql(String.raw`
      insert into public.ai_provider_profiles (
        id, profile_key, display_name, gateway_kind, model_vendor
      ) values (
        '${id}'::uuid,
        ${sqlLiteral(`test.${label}.${id}`)},
        ${sqlLiteral(`Test ${label}`)},
        'direct_mimo',
        'fixture'
      );
    `);
    const { data, error } = await service
      .from("ai_provider_profiles")
      .select("*")
      .eq("id", id)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  it("stores a stable identity and immutable execution version", async () => {
    const profile = await createProfile("immutable");
    const versionId = insertVersionAsOwner(versionFixture(profile.id));
    const { data: version, error } = await service
      .from("ai_provider_profile_versions")
      .select("*")
      .eq("id", versionId)
      .single();
    expect(error).toBeNull();
    expect(version).toMatchObject({
      profile_id: profile.id,
      version: 1,
      status: "draft",
      wire_api_kind: "responses_v1",
    });

    runOwnerDomainProbe(
      String.raw`
        update public.ai_provider_profiles
        set profile_key = ${sqlLiteral(`changed.${crypto.randomUUID()}`)}
        where id = '${profile.id}'::uuid;
      `,
      CHECK_VIOLATION,
    );

    updateVersionAsOwner(
      version!.id,
      `config = '{"changed":true}'::jsonb`,
      CHECK_VIOLATION,
    );

    runOwnerDomainProbe(
      String.raw`
        delete from public.ai_provider_profiles
        where id = '${profile.id}'::uuid;
      `,
      CHECK_VIOLATION,
    );
  });

  it("enforces unique versions, required aliases, and valid states", async () => {
    const profile = await createProfile("constraints");
    const fixture = versionFixture(profile.id);
    insertVersionAsOwner(fixture);

    insertVersionAsOwner(fixture, UNIQUE_VIOLATION);

    insertVersionAsOwner(
      { ...versionFixture(profile.id, 2), status: "ready" },
      CHECK_VIOLATION,
    );

    insertVersionAsOwner(
      { ...versionFixture(profile.id, 3), endpoint_alias: " " },
      CHECK_VIOLATION,
    );

    for (const [index, status] of [
      "validated",
      "canary",
      "active",
      "retired",
    ].entries()) {
      insertVersionAsOwner(
        { ...versionFixture(profile.id, 10 + index), status },
        CHECK_VIOLATION,
      );
    }
  });

  it("allows only monotonic lifecycle transitions", async () => {
    const profile = await createProfile("lifecycle");
    const versionId = insertVersionAsOwner(versionFixture(profile.id));

    updateVersionAsOwner(versionId, "status = 'validated'");
    const validated = await service
      .from("ai_provider_profile_versions")
      .select("status,validated_at")
      .eq("id", versionId)
      .single();
    expect(validated.error).toBeNull();
    expect(validated.data?.validated_at).toBeTruthy();

    updateVersionAsOwner(versionId, "status = 'active'");
    const active = await service
      .from("ai_provider_profile_versions")
      .select("status,activated_at")
      .eq("id", versionId)
      .single();
    expect(active.error).toBeNull();
    expect(active.data?.activated_at).toBeTruthy();

    updateVersionAsOwner(
      versionId,
      "validated_at = '2026-01-01T00:00:00Z'::timestamptz",
      CHECK_VIOLATION,
    );

    updateVersionAsOwner(versionId, "status = 'draft'", CHECK_VIOLATION);
  });

  it("clamps owner-authored trigger timestamps to monotonic row time", async () => {
    const profile = await createProfile("lifecycle-clock-clamp");
    const futureCreatedAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const versionId = insertVersionAsOwner({
      ...versionFixture(profile.id),
      created_at: futureCreatedAt,
    });
    const { error: insertError } = await service
      .from("ai_provider_profile_versions")
      .select("id,created_at")
      .eq("id", versionId)
      .single();
    expect(insertError).toBeNull();

    updateVersionAsOwner(versionId, "status = 'validated'");
    const validated = await service
      .from("ai_provider_profile_versions")
      .select("created_at,validated_at")
      .eq("id", versionId)
      .single();
    expect(validated.error).toBeNull();
    expect(Date.parse(validated.data!.validated_at!)).toBeGreaterThanOrEqual(
      Date.parse(validated.data!.created_at),
    );

    updateVersionAsOwner(versionId, "status = 'active'");
    const active = await service
      .from("ai_provider_profile_versions")
      .select("created_at,validated_at,activated_at")
      .eq("id", versionId)
      .single();
    expect(active.error).toBeNull();
    expect(Date.parse(active.data!.activated_at!)).toBeGreaterThanOrEqual(
      Date.parse(active.data!.validated_at!),
    );

    // This is an owner-only DB-012 trigger probe. DB-013 retirement authority,
    // evidence checks, and auditing are covered by routing-lifecycle-control.
    updateVersionAsOwner(versionId, "status = 'retired'");
    const retired = await service
      .from("ai_provider_profile_versions")
      .select("created_at,validated_at,activated_at,retired_at")
      .eq("id", versionId)
      .single();
    expect(retired.error).toBeNull();
    expect(Date.parse(retired.data!.retired_at!)).toBeGreaterThanOrEqual(
      Date.parse(retired.data!.activated_at!),
    );
  });

  it("denies service-role direct provider catalog mutation", async () => {
    const profile = await createProfile("service-acl");

    const profileUpdate = await service
      .from("ai_provider_profiles")
      .update({ display_name: "forbidden service update" })
      .eq("id", profile.id);
    expect(profileUpdate.error?.code).toBe(PERMISSION_DENIED);

    const versionInsert = await service
      .from("ai_provider_profile_versions")
      .insert(versionFixture(profile.id));
    expect(versionInsert.error?.code).toBe(PERMISSION_DENIED);

    const profileDelete = await service
      .from("ai_provider_profiles")
      .delete()
      .eq("id", profile.id);
    expect(profileDelete.error?.code).toBe(PERMISSION_DENIED);
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
