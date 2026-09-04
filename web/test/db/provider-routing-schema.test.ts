import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  MIMO_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_MANIFEST_SHA256,
  sealPriceAsDatabaseOwner,
  runOwnerSql,
  transitionPolicyAsDatabaseOwner,
  type SyntheticRuntimeContract,
} from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const PERMISSION_DENIED = "42501";

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlJson(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function ownerDomainProbe(
  sql: string,
  expectedSqlState?: string,
) {
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

interface RoutingTargetFixture {
  id: string;
  priceVersionId: string;
  runtime: SyntheticRuntimeContract;
}

describe.skipIf(!RUN_DB_TESTS)("provider routing schema (real DB)", () => {
  let service: SupabaseClient;
  let legalBundleVersion: string;
  let ownerPointerPolicyId: string | null = null;

  beforeAll(async () => {
    service = createServiceClient();
    const { data, error } = await service.rpc("current_ai_terms_version");
    expect(error).toBeNull();
    legalBundleVersion = data as string;
  });

  afterAll(() => {
    if (ownerPointerPolicyId === null) {
      return;
    }
    const cleanup = runOwnerSql(String.raw`
      update public.ai_feature_config
      set active_routing_policy_version_id = null,
          routing_updated_by = 'provider-routing-test-cleanup',
          routing_change_reason = ${sqlLiteral(
            `restore routing pointer ${crypto.randomUUID()}`,
          )}
      where id = true
        and active_routing_policy_version_id = '${ownerPointerPolicyId}'::uuid
      returning active_routing_policy_version_id, config_generation;
    `);
    expect(cleanup.status).toBe(0);
    expect(cleanup.stdout).toMatch(/UPDATE 1/);
  });

  async function createProfileVersion(
    label: string,
    status: "draft" | "validated" | "canary" | "active",
  ): Promise<RoutingTargetFixture> {
    const profileKey = `test.routing.${label}.${crypto.randomUUID()}`;
    const profileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const priceId = crypto.randomUUID();
    const authored = runOwnerSql(String.raw`
      begin;
      insert into public.ai_provider_profiles (
        id, profile_key, display_name, gateway_kind, model_vendor
      ) values (
        '${profileId}'::uuid,
        ${sqlLiteral(profileKey)},
        ${sqlLiteral(`Routing ${label}`)},
        'direct_mimo',
        'fixture'
      );
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, status, adapter_kind, wire_api_kind,
        credential_alias, endpoint_alias, model_id, upstream_route,
        capability_contract_id, cache_policy_id, legal_manifest_id,
        display_disclosure_key, config, config_sha256
      ) values (
        '${versionId}'::uuid,
        '${profileId}'::uuid,
        1,
        'draft',
        'mimo_responses_v1',
        'responses_v1',
        'fixture_credential_v1',
        'fixture_endpoint_v1',
        'fixture-model',
        '{}'::jsonb,
        'fixture_capability_v1',
        'fixture_cache_v1',
        ${sqlLiteral(MIMO_LEGAL_MANIFEST_ID)},
        'mimo.official',
        '{}'::jsonb,
        '${"d".repeat(64)}'
      );
      insert into public.ai_price_versions (
        id, profile_version_id, pricing_lane, version, currency,
        calculator_kind, valid_from, source_url, source_checked_at,
        source_snapshot_sha256, parameters
      ) values (
        '${priceId}'::uuid,
        '${versionId}'::uuid,
        'default',
        1,
        'CNY',
        'linear_token_v1',
        pg_catalog.clock_timestamp() - interval '1 hour',
        'https://example.com/provider-routing-price',
        pg_catalog.clock_timestamp(),
        '${"a".repeat(64)}',
        '{}'::jsonb
      );
      insert into public.ai_price_components (
        price_version_id, component, nanos_per_million
      ) values
        ('${priceId}'::uuid, 'input_standard', 1),
        ('${priceId}'::uuid, 'input_cache_read', 1),
        ('${priceId}'::uuid, 'output', 1);
      commit;
    `);
    expect(authored.status).toBe(0);
    sealPriceAsDatabaseOwner(priceId);

    const runtime = authorSyntheticRuntimeContract({
      profileKey,
      legalManifestId: MIMO_LEGAL_MANIFEST_ID,
      manifestSha256: MIMO_LEGAL_MANIFEST_SHA256,
    });

    if (status !== "draft") {
      for (const nextStatus of ["validated", "canary", "active"] as const) {
        const transition = runOwnerSql(String.raw`
          update public.ai_provider_profile_versions
          set status = ${sqlLiteral(nextStatus)}
          where id = '${versionId}'::uuid;
        `);
        expect(transition.status).toBe(0);
        if (nextStatus === status) {
          break;
        }
      }
    }

    return { id: versionId, priceVersionId: priceId, runtime };
  }

  function strictRules(target: RoutingTargetFixture) {
    return {
      schemaVersion: "routing_rules_v1",
      defaultRoute: {
        profileVersionId: target.id,
        priceVersionId: target.priceVersionId,
      },
      windows: [],
    };
  }

  async function createPolicy(
    target: RoutingTargetFixture,
    label: string,
    status: "draft" | "validated" | "canary" | "active",
    legalVersion = legalBundleVersion,
  ) {
    const policyId = crypto.randomUUID();
    const authored = runOwnerSql(String.raw`
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, status, timezone, rules,
        default_profile_version_id, legal_bundle_version,
        runtime_contract_id, config_sha256
      ) values (
        '${policyId}'::uuid,
        ${sqlLiteral(`test.routing.${label}.${crypto.randomUUID()}`)},
        1,
        'draft',
        'Asia/Shanghai',
        ${sqlJson(strictRules(target))},
        '${target.id}'::uuid,
        ${sqlLiteral(legalVersion)},
        ${sqlLiteral(target.runtime.runtimeContractId)},
        '${"e".repeat(64)}'
      );
    `);
    expect(authored.status).toBe(0);
    const { data, error } = await service.from("ai_routing_policy_versions").select("*").eq("id", policyId).single();
    expect(error).toBeNull();
    if (status === "draft") {
      return data!;
    }

    let current = data!;
    for (const nextStatus of ["validated", "canary", "active"] as const) {
      transitionPolicyAsDatabaseOwner(current.id, nextStatus);
      const transition = await service
        .from("ai_routing_policy_versions")
        .select("*")
        .eq("id", current.id)
        .single();
      expect(transition.error).toBeNull();
      current = transition.data!;
      if (nextStatus === status) {
        break;
      }
    }
    return current;
  }

  it("keeps draft/off as the default and validates timezone/rules", async () => {
    const { data: config, error } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id,config_generation")
      .eq("id", true)
      .single();
    expect(error).toBeNull();
    expect(config?.active_routing_policy_version_id).toBeNull();
    expect(Number(config?.config_generation)).toBeGreaterThanOrEqual(0);

    const profile = await createProfileVersion("timezone", "draft");
    const insertPolicyDomainProbe = (
      timezone: string,
      rules: unknown,
      status = "draft",
    ) => ownerDomainProbe(
      String.raw`
        insert into public.ai_routing_policy_versions (
          id, policy_key, version, status, timezone, rules,
          default_profile_version_id, legal_bundle_version,
          runtime_contract_id, config_sha256
        ) values (
          '${crypto.randomUUID()}'::uuid,
          ${sqlLiteral(`test.routing.domain.${crypto.randomUUID()}`)},
          1,
          ${sqlLiteral(status)},
          ${sqlLiteral(timezone)},
          ${sqlJson(rules)},
          '${profile.id}'::uuid,
          ${sqlLiteral(legalBundleVersion)},
          ${sqlLiteral(profile.runtime.runtimeContractId)},
          '${"e".repeat(64)}'
        );
      `,
      CHECK_VIOLATION,
    );

    insertPolicyDomainProbe("UTC", strictRules(profile));
    insertPolicyDomainProbe("Asia/Shanghai", []);

    for (const status of [
      "validated",
      "canary",
      "active",
      "retired",
    ]) {
      insertPolicyDomainProbe(
        "Asia/Shanghai",
        strictRules(profile),
        status,
      );
    }
  });

  it("denies direct service-role catalog and pointer control-plane mutation", async () => {
    const profile = await createProfileVersion("service-acl", "draft");
    const policy = await createPolicy(profile, "service-acl", "draft");

    const insert = await service.from("ai_routing_policy_versions").insert({
      policy_key: `test.routing.service-acl.${crypto.randomUUID()}`,
      version: 1,
      timezone: "Asia/Shanghai",
      rules: strictRules(profile),
      default_profile_version_id: profile.id,
      legal_bundle_version: legalBundleVersion,
      runtime_contract_id: profile.runtime.runtimeContractId,
      config_sha256: "e".repeat(64),
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);

    const update = await service
      .from("ai_routing_policy_versions")
      .update({ status: "validated" })
      .eq("id", policy.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);

    const pointer = await service
      .from("ai_feature_config")
      .update({ active_routing_policy_version_id: policy.id })
      .eq("id", true);
    expect(pointer.error?.code).toBe(PERMISSION_DENIED);
  });

  it("fails closed before activation for draft profiles, draft policies, or stale legal", async () => {
    const draftProfile = await createProfileVersion("draft-profile", "draft");
    const draftProfilePolicy = await createPolicy(
      draftProfile,
      "draft-profile",
      "draft",
    );
    const invalidTransition = transitionPolicyAsDatabaseOwner(
      draftProfilePolicy.id,
      "validated",
      { expectFailure: true },
    );
    expect(invalidTransition.stderr).toMatch(/profile is unavailable/i);

    const validatedProfile = await createProfileVersion(
      "draft-policy",
      "validated",
    );
    const draftPolicy = await createPolicy(
      validatedProfile,
      "draft-policy",
      "draft",
    );
    ownerDomainProbe(
      String.raw`
        update public.ai_feature_config
        set active_routing_policy_version_id = '${draftPolicy.id}'::uuid,
            routing_updated_by = 'provider-routing-test',
            routing_change_reason = ${sqlLiteral(
              `prove draft policy rejection ${crypto.randomUUID()}`,
            )}
        where id = true;
      `,
      CHECK_VIOLATION,
    );

    const staleLegalPolicy = await createPolicy(
      validatedProfile,
      "stale-legal",
      "draft",
      "2026-08-04",
    );
    const staleTransition = transitionPolicyAsDatabaseOwner(
      staleLegalPolicy.id,
      "validated",
      { expectFailure: true },
    );
    expect(staleTransition.stderr).toMatch(/current legal bundle/i);
  });

  it("owner-only DB007 pointer trigger increments generation and requires audit fields", async () => {
    const profile = await createProfileVersion("activate", "canary");
    const policy = await createPolicy(profile, "activate", "canary");
    const { data: before } = await service
      .from("ai_feature_config")
      .select("config_generation")
      .eq("id", true)
      .single();

    ownerDomainProbe(
      String.raw`
        update public.ai_feature_config
        set active_routing_policy_version_id = '${policy.id}'::uuid
        where id = true;
      `,
      CHECK_VIOLATION,
    );

    const activation = runOwnerSql(String.raw`
      update public.ai_feature_config
      set active_routing_policy_version_id = '${policy.id}'::uuid,
          routing_updated_by = 'provider-routing-test',
          routing_change_reason = ${sqlLiteral(
            `activate canary fixture ${crypto.randomUUID()}`,
          )}
      where id = true
      returning active_routing_policy_version_id, config_generation,
        routing_updated_at;
    `);
    expect(activation.status).toBe(0);
    expect(activation.stdout).toMatch(/UPDATE 1/);
    ownerPointerPolicyId = policy.id;

    const { data: activated, error: activationReadError } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id,config_generation,routing_updated_at")
      .eq("id", true)
      .single();
    expect(activationReadError).toBeNull();
    expect(activated?.active_routing_policy_version_id).toBe(policy.id);
    expect(Number(activated?.config_generation)).toBe(
      Number(before?.config_generation) + 1,
    );
    expect(activated?.routing_updated_at).toBeTruthy();

    ownerDomainProbe(
      String.raw`
        update public.ai_feature_config
        set config_generation = ${Number(activated?.config_generation) + 10}
        where id = true;
      `,
      CHECK_VIOLATION,
    );

    ownerDomainProbe(
      String.raw`
        update public.ai_feature_config
        set routing_updated_by = 'different-actor',
            routing_change_reason = 'rewrite audit without changing pointer',
            routing_updated_at = '2026-01-01T00:00:00Z'::timestamptz
        where id = true;
      `,
      CHECK_VIOLATION,
    );

    const deactivate = runOwnerSql(String.raw`
      update public.ai_feature_config
      set active_routing_policy_version_id = null,
          routing_updated_by = 'provider-routing-test',
          routing_change_reason = ${sqlLiteral(
            `restore inactive fixture ${crypto.randomUUID()}`,
          )}
      where id = true
        and active_routing_policy_version_id = '${policy.id}'::uuid
      returning active_routing_policy_version_id, config_generation;
    `);
    expect(deactivate.status).toBe(0);
    expect(deactivate.stdout).toMatch(/UPDATE 1/);
    ownerPointerPolicyId = null;

    const { data: deactivated, error: deactivationReadError } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id,config_generation")
      .eq("id", true)
      .single();
    expect(deactivationReadError).toBeNull();
    expect(deactivated?.active_routing_policy_version_id).toBeNull();
    expect(Number(deactivated?.config_generation)).toBe(
      Number(activated?.config_generation) + 1,
    );
  });

  it("makes policy execution fields immutable", async () => {
    const profile = await createProfileVersion("immutable-policy", "validated");
    const policy = await createPolicy(profile, "immutable-policy", "validated");

    ownerDomainProbe(
      String.raw`
        update public.ai_routing_policy_versions
        set rules = '{"changed":true}'::jsonb
        where id = '${policy.id}'::uuid;
      `,
      CHECK_VIOLATION,
    );

    ownerDomainProbe(
      String.raw`
        update public.ai_routing_policy_versions
        set status = 'draft'
        where id = '${policy.id}'::uuid;
      `,
      CHECK_VIOLATION,
    );
  });

  it("clamps policy lifecycle timestamps to monotonic row time", async () => {
    const profile = await createProfileVersion("policy-clock-clamp", "validated");
    const futureCreatedAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const policyId = crypto.randomUUID();
    const authored = runOwnerSql(String.raw`
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, status, timezone, rules,
        default_profile_version_id, legal_bundle_version,
        runtime_contract_id, config_sha256,
        created_at
      ) values (
        '${policyId}'::uuid,
        ${sqlLiteral(`test.routing.policy-clock-clamp.${crypto.randomUUID()}`)},
        1,
        'draft',
        'Asia/Shanghai',
        ${sqlJson(strictRules(profile))},
        '${profile.id}'::uuid,
        ${sqlLiteral(legalBundleVersion)},
        ${sqlLiteral(profile.runtime.runtimeContractId)},
        '${"f".repeat(64)}',
        ${sqlLiteral(futureCreatedAt)}::timestamptz
      );
    `);
    expect(authored.status).toBe(0);
    const { data: policy, error: insertError } = await service
      .from("ai_routing_policy_versions")
      .select("id,created_at")
      .eq("id", policyId)
      .single();
    expect(insertError).toBeNull();

    transitionPolicyAsDatabaseOwner(policy!.id, "validated");
    const validated = await service
      .from("ai_routing_policy_versions")
      .select("created_at,validated_at")
      .eq("id", policy!.id)
      .single();
    expect(validated.error).toBeNull();
    expect(Date.parse(validated.data!.validated_at!)).toBeGreaterThanOrEqual(
      Date.parse(validated.data!.created_at),
    );

    expect(runOwnerSql(String.raw`
      update public.ai_provider_profile_versions
      set status = 'active'
      where id = '${profile.id}'::uuid;
    `).status).toBe(0);
    transitionPolicyAsDatabaseOwner(policy!.id, "active");
    const active = await service
      .from("ai_routing_policy_versions")
      .select("created_at,validated_at,activated_at")
      .eq("id", policy!.id)
      .single();
    expect(active.error).toBeNull();
    expect(Date.parse(active.data!.activated_at!)).toBeGreaterThanOrEqual(
      Date.parse(active.data!.validated_at!),
    );

    ownerDomainProbe(
      String.raw`
        update public.ai_routing_policy_versions
        set status = 'retired'
        where id = '${policy!.id}'::uuid;
      `,
      CHECK_VIOLATION,
    );

    const retained = await service
      .from("ai_routing_policy_versions")
      .select("status,retired_at")
      .eq("id", policy!.id)
      .single();
    expect(retained.error).toBeNull();
    expect(retained.data).toEqual(
      expect.objectContaining({ status: "active", retired_at: null }),
    );
  });
});
