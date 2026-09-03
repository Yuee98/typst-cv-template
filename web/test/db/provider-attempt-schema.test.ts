import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import routingRulesFixture from "../fixtures/routing-rules-v1.json";
import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  DB_TEST_ENV,
  deleteTestUser,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";
import {
  authorSyntheticRuntimeContract,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
} from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const PERMISSION_DENIED = "42501";
const SAFE_INTEGER_MAX = "9007199254740991";
const GATEWAY_CORRELATION_TAG = `hmac-sha256:${"a".repeat(64)}`;
const PROVIDER_CORRELATION_TAG = `hmac-sha256:${"b".repeat(64)}`;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface OwnerMutationResult {
  data: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

function ownerMutationResult(
  sql: string,
  expectFailure: boolean,
): OwnerMutationResult {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \set VERBOSITY verbose
    \pset format unaligned
    \pset tuples_only on
    ${sql}
  `, { expectFailure });
  if (expectFailure) {
    const match = result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\r\n]+)/u);
    return {
      data: null,
      error: {
        code: match?.[1] ?? "XXXXX",
        message: match?.[2] ?? result.stderr,
      },
    };
  }
  const jsonLine = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{"));
  return {
    data: jsonLine ? JSON.parse(jsonLine) as Record<string, unknown> : null,
    error: null,
  };
}

function ownerInsertAttempt(
  value: Record<string, unknown>,
  expectFailure = false,
): OwnerMutationResult {
  const completeValue = {
    attempt_id: crypto.randomUUID(),
    status: "started",
    started_at: new Date().toISOString(),
    ...value,
  };
  return ownerMutationResult(String.raw`
    with inserted as (
      insert into public.ai_provider_attempt_ledger
      select (pg_catalog.jsonb_populate_record(
        null::public.ai_provider_attempt_ledger,
        ${sqlLiteral(JSON.stringify(completeValue))}::jsonb
      )).*
      returning *
    )
    select pg_catalog.row_to_json(inserted)::text from inserted;
  `, expectFailure);
}

function ownerUpdateAttempt(
  attemptId: string,
  value: Record<string, unknown>,
  expectFailure = false,
): OwnerMutationResult {
  const keys = Object.keys(value);
  if (keys.some((key) => !/^[a-z][a-z0-9_]*$/u.test(key))) {
    throw new Error("unsafe owner attempt fixture column");
  }
  const assignments = keys.map((key) => `${key} = patch.${key}`).join(",\n");
  return ownerMutationResult(String.raw`
    with patch as (
      select (pg_catalog.jsonb_populate_record(
        null::public.ai_provider_attempt_ledger,
        ${sqlLiteral(JSON.stringify(value))}::jsonb
      )).*
    ), updated as (
      update public.ai_provider_attempt_ledger as attempt
      set ${assignments}
      from patch
      where attempt.attempt_id = ${sqlLiteral(attemptId)}::uuid
      returning attempt.*
    )
    select pg_catalog.row_to_json(updated)::text from updated;
  `, expectFailure);
}

function ownerDeleteAttempt(
  attemptId: string,
  expectFailure = false,
): OwnerMutationResult {
  return ownerMutationResult(String.raw`
    with deleted as (
      delete from public.ai_provider_attempt_ledger
      where attempt_id = ${sqlLiteral(attemptId)}::uuid
      returning *
    )
    select pg_catalog.row_to_json(deleted)::text from deleted;
  `, expectFailure);
}

interface FrozenFixture {
  reservationId: string;
  snapshot: Record<string, unknown>;
  attemptAliases?: Record<string, unknown>;
}

describe.skipIf(!RUN_DB_TESTS)("provider attempt ledger schema (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let user: TestUser;
  let profileVersionId: string;
  let priceVersionId: string;
  let policyVersionId: string;
  let legalBundleVersion: string;
  let runtimeContractId: string;
  let secondRuntimeContractId: string;

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    user = await createTestUser(service, "provider-attempt-schema");

    const currentLegal = await service.rpc("current_ai_terms_version");
    expect(currentLegal.error).toBeNull();
    legalBundleVersion = currentLegal.data as string;

    const profileKey = `test.attempt.${crypto.randomUUID()}`;
    const profileId = crypto.randomUUID();
    profileVersionId = crypto.randomUUID();
    priceVersionId = crypto.randomUUID();
    expect(runOwnerSql(String.raw`
      begin;
      insert into public.ai_provider_profiles (id, profile_key, display_name, gateway_kind, model_vendor)
      values ('${profileId}', '${profileKey}', 'Attempt schema fixture', 'direct_deepseek', 'fixture');
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, adapter_kind, wire_api_kind, credential_alias,
        endpoint_alias, model_id, upstream_route, capability_contract_id,
        cache_policy_id, legal_manifest_id, display_disclosure_key, config, config_sha256
      ) values (
        '${profileVersionId}', '${profileId}', 1, 'deepseek_chat_v1', 'chat_completions_v1',
        'deepseek_api_key_v1', 'deepseek_official', 'deepseek-v4-flash', '{}'::jsonb,
        'deepseek_chat_capabilities_v1', 'automatic_cache_v1', 'deepseek-official-2026-08-23-v1',
        'deepseek.official', '{}'::jsonb, '${"a".repeat(64)}'
      );
      insert into public.ai_price_versions (
        id, profile_version_id, pricing_lane, version, currency, calculator_kind,
        valid_from, source_url, source_checked_at, source_snapshot_sha256, parameters
      ) values (
        '${priceVersionId}', '${profileVersionId}', 'default', 1, 'CNY', 'linear_token_v1',
        '2026-01-01T00:00:00Z', 'https://example.com/attempt-price-fixture',
        '2026-08-23T00:00:00Z', '${"b".repeat(64)}', '{}'::jsonb
      );
      insert into public.ai_price_components (price_version_id, component, nanos_per_million)
      values
        ('${priceVersionId}', 'input_cache_read', 20000000),
        ('${priceVersionId}', 'input_standard', 1000000000),
        ('${priceVersionId}', 'output', 2000000000);
      commit;
    `).status).toBe(0);
    expect(runOwnerSql(String.raw`
      begin;
      update public.ai_provider_profile_versions
      set status = 'validated'
      where id = '${profileVersionId}';
      update public.ai_provider_profile_versions
      set status = 'canary'
      where id = '${profileVersionId}';
      commit;
    `).status).toBe(0);
    sealPriceAsDatabaseOwner(priceVersionId);

    const runtime = authorSyntheticRuntimeContract({ profileKey });
    runtimeContractId = runtime.runtimeContractId;
    const secondRuntime = authorSyntheticRuntimeContract({ profileKey });
    secondRuntimeContractId = secondRuntime.runtimeContractId;
    expect(secondRuntimeContractId).not.toBe(runtimeContractId);

    policyVersionId = crypto.randomUUID();
    expect(runOwnerSql(String.raw`
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, timezone, rules, default_profile_version_id,
        legal_bundle_version, runtime_contract_id, config_sha256
      ) values (
        '${policyVersionId}', 'test.attempt.${crypto.randomUUID()}', 1, 'Asia/Shanghai',
        '{"kind":"fixture_default_only_v1"}'::jsonb, '${profileVersionId}',
        '${legalBundleVersion}', '${runtimeContractId}', '${"c".repeat(64)}'
      );
    `).status).toBe(0);
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  async function createReservation(owner = user): Promise<FrozenFixture> {
    const snapshot = {
      route_schema_version: "route_snapshot_v1",
      config_generation: 7,
      routing_policy_version_id: policyVersionId,
      profile_version_id: profileVersionId,
      price_version_id: priceVersionId,
      legal_bundle_version: legalBundleVersion,
      runtime_contract_id: runtimeContractId,
      gateway_kind: "direct_deepseek",
      model_id: "deepseek-v4-flash",
      wire_api_kind: "chat_completions_v1",
      display_disclosure_key: "deepseek.official",
    };
    const request = await service
      .from("ai_request_ledger")
      .insert({
        request_id: crypto.randomUUID(),
        client_request_id: crypto.randomUUID(),
        user_id: owner.id,
        ...snapshot,
      })
      .select("reservation_id")
      .single();
    expect(request.error).toBeNull();
    return { reservationId: request.data!.reservation_id, snapshot };
  }

  async function createCustomReservation(input: {
    key: string;
    gatewayKind: "direct_deepseek" | "direct_mimo";
    adapterKind: string;
    wireApiKind: "chat_completions_v1" | "responses_v1";
    endpointAlias: string;
    modelId: string;
  }): Promise<FrozenFixture> {
    const profileKey = `test.attempt.${input.key}.${crypto.randomUUID()}`;
    const credentialAlias = `${input.key}_api_key_v1`;
    const capabilityContractId = `${input.key}_capabilities_v1`;
    const cachePolicyId = "automatic_cache_v1";
    const legalManifestId = `${input.key}-legal-v1`;
    const displayDisclosureKey = `${input.key}-disclosure-v1`;
    const profileId = crypto.randomUUID();
    const profileVersionId = crypto.randomUUID();
    const priceVersionId = crypto.randomUUID();
    expect(runOwnerSql(String.raw`
      begin;
      insert into public.ai_provider_profiles (id, profile_key, display_name, gateway_kind, model_vendor)
      values ('${profileId}', '${profileKey}', '${input.key} attempt schema fixture', '${input.gatewayKind}', 'fixture');
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, adapter_kind, wire_api_kind, credential_alias,
        endpoint_alias, model_id, upstream_route, capability_contract_id,
        cache_policy_id, legal_manifest_id, display_disclosure_key, config, config_sha256
      ) values (
        '${profileVersionId}', '${profileId}', 1, '${input.adapterKind}', '${input.wireApiKind}',
        '${credentialAlias}', '${input.endpointAlias}', '${input.modelId}', '{}'::jsonb,
        '${capabilityContractId}', '${cachePolicyId}', '${legalManifestId}',
        '${displayDisclosureKey}', '{}'::jsonb, '${"d".repeat(64)}'
      );
      insert into public.ai_price_versions (
        id, profile_version_id, pricing_lane, version, currency, calculator_kind,
        valid_from, source_url, source_checked_at, source_snapshot_sha256, parameters
      ) values (
        '${priceVersionId}', '${profileVersionId}', 'default', 1, 'CNY', 'linear_token_v1',
        '2026-01-01T00:00:00Z', 'https://example.com/${input.key}-price-fixture',
        '2026-08-23T00:00:00Z', '${"e".repeat(64)}', '{}'::jsonb
      );
      insert into public.ai_price_components (price_version_id, component, nanos_per_million)
      values
        ('${priceVersionId}', 'input_cache_read', 20000000),
        ('${priceVersionId}', 'input_standard', 1000000000),
        ('${priceVersionId}', 'output', 2000000000);
      commit;
    `).status).toBe(0);
    expect(runOwnerSql(String.raw`
      begin;
      update public.ai_provider_profile_versions
      set status = 'validated'
      where id = '${profileVersionId}';
      update public.ai_provider_profile_versions
      set status = 'canary'
      where id = '${profileVersionId}';
      commit;
    `).status).toBe(0);
    sealPriceAsDatabaseOwner(priceVersionId);

    const runtime = authorSyntheticRuntimeContract();

    const policyVersionId = crypto.randomUUID();
    expect(runOwnerSql(String.raw`
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, timezone, rules, default_profile_version_id,
        legal_bundle_version, runtime_contract_id, config_sha256
      ) values (
        '${policyVersionId}', 'test.attempt.${input.key}.${crypto.randomUUID()}', 1, 'Asia/Shanghai',
        '{"kind":"fixture_default_only_v1"}'::jsonb, '${profileVersionId}',
        '${legalBundleVersion}', '${runtime.runtimeContractId}', '${"f".repeat(64)}'
      );
    `).status).toBe(0);

    const snapshot = {
      route_schema_version: "route_snapshot_v1",
      config_generation: 8,
      routing_policy_version_id: policyVersionId,
      profile_version_id: profileVersionId,
      price_version_id: priceVersionId,
      legal_bundle_version: legalBundleVersion,
      runtime_contract_id: runtime.runtimeContractId,
      gateway_kind: input.gatewayKind,
      model_id: input.modelId,
      wire_api_kind: input.wireApiKind,
      display_disclosure_key: displayDisclosureKey,
    };
    const request = await service
      .from("ai_request_ledger")
      .insert({
        request_id: crypto.randomUUID(),
        client_request_id: crypto.randomUUID(),
        user_id: user.id,
        ...snapshot,
      })
      .select("reservation_id")
      .single();
    expect(request.error).toBeNull();

    return {
      reservationId: request.data!.reservation_id,
      snapshot,
      attemptAliases: {
        adapter_kind: input.adapterKind,
        credential_alias: credentialAlias,
        endpoint_alias: input.endpointAlias,
        capability_contract_id: capabilityContractId,
        cache_policy_id: cachePolicyId,
        legal_manifest_id: legalManifestId,
        calculator_kind: "linear_token_v1",
        billing_currency: "CNY",
      },
    };
  }

  function startedAttempt(fixture: FrozenFixture, attemptNo = 1) {
    return {
      reservation_id: fixture.reservationId,
      attempt_no: attemptNo,
      ...fixture.snapshot,
      ...(fixture.attemptAliases ?? {
        adapter_kind: "deepseek_chat_v1",
        credential_alias: "deepseek_api_key_v1",
        endpoint_alias: "deepseek_official",
        capability_contract_id: "deepseek_chat_capabilities_v1",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id: "deepseek-official-2026-08-23-v1",
        calculator_kind: "linear_token_v1",
        billing_currency: "CNY",
      }),
    };
  }

  function observedCompletion(overrides: Record<string, unknown> = {}) {
    return {
      status: "succeeded",
      // DB and host clocks can differ by a few milliseconds on Windows.
      terminal_at: new Date(Date.now() + 1_000).toISOString(),
      provider_billable: true,
      usage_observation_kind: "observed",
      usage_schema_version: "normalized_usage_v2",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: null,
      input_standard_tokens: 40,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_usage_reporting: "unavailable",
      usage_complete: true,
      route_observation_schema_version: "route_observation_v1",
      gateway_request_id: GATEWAY_CORRELATION_TAG,
      provider_request_id: PROVIDER_CORRELATION_TAG,
      actual_upstream_endpoint: "https://api.deepseek.com/chat/completions",
      actual_model_id: "deepseek-v4-flash",
      router_attempt_count: null,
      cost_observation_schema_version: "cost_observation_v1",
      estimated_currency: "CNY",
      estimated_cost_nanos: 1234,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
      cost_reconciliation_status: "not_available",
      finish_reason: "stop",
      failure_stage: null,
      latency_ms: 1234,
      ...overrides,
    };
  }

  function unavailableCompletion(status = "failed_upstream") {
    return observedCompletion({
      status,
      provider_billable: null,
      usage_observation_kind: "unavailable",
      usage_schema_version: null,
      input_total_tokens: null,
      input_cache_read_tokens: null,
      input_cache_write_tokens: null,
      input_standard_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_usage_reporting: null,
      usage_complete: false,
      estimated_currency: null,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
      finish_reason: null,
      failure_stage: "provider_http",
    });
  }

  async function insertStarted(fixture: FrozenFixture, attemptNo = 1) {
    return ownerInsertAttempt(startedAttempt(fixture, attemptNo));
  }

  async function finalizeReservation(reservationId: string) {
    const finalized = await service
      .from("ai_request_ledger")
      .update({
        state: "finalized",
        status: "released",
        quota_charged: false,
        provider_billable: false,
        usage_complete: false,
        finalized_at: new Date(Date.now() + 1_000).toISOString(),
      })
      .eq("reservation_id", reservationId)
      .select("state")
      .single();
    expect(finalized.error).toBeNull();
    expect(finalized.data?.state).toBe("finalized");
  }

  it("defines a not-null versioned runtime ID foreign key without changing temporary grants", () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $assertions$
      declare
        role_name text;
        privilege_name text;
        column_name text;
      begin
        if (
          select count(*)
          from pg_catalog.pg_attribute
          where attrelid = 'public.ai_provider_attempt_ledger'::regclass
            and attname = 'runtime_contract_id'
            and attnotnull
            and not atthasdef
            and not attisdropped
        ) <> 1 then
          raise exception 'attempt runtime ID must be not-null with no default';
        end if;

        if not exists (
          select 1
          from pg_catalog.pg_constraint
          where conrelid = 'public.ai_provider_attempt_ledger'::regclass
            and confrelid = 'public.ai_service_runtime_contract_versions'::regclass
            and conname = 'ai_provider_attempt_ledger_runtime_contract_fkey'
            and contype = 'f'
            and confmatchtype = 's'
        ) then
          raise exception 'attempt runtime ID must use a simple FK';
        end if;

        if not (
          select relrowsecurity
          from pg_catalog.pg_class
          where oid = 'public.ai_provider_attempt_ledger'::regclass
        ) then
          raise exception 'attempt ledger RLS is not enabled';
        end if;

        foreach role_name in array array['anon', 'authenticated'] loop
          foreach privilege_name in array array[
            'SELECT', 'INSERT', 'UPDATE', 'DELETE',
            'TRUNCATE', 'REFERENCES', 'TRIGGER'
          ] loop
            if has_table_privilege(
              role_name,
              'public.ai_provider_attempt_ledger',
              privilege_name
            ) then
              raise exception '% unexpectedly has % on attempt ledger',
                role_name, privilege_name;
            end if;
          end loop;
        end loop;

        if not has_table_privilege(
          'service_role',
          'public.ai_provider_attempt_ledger',
          'SELECT'
        ) then
          raise exception 'service_role lacks attempt ledger SELECT';
        end if;
        foreach privilege_name in array array[
          'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
        ] loop
          if has_table_privilege(
            'service_role',
            'public.ai_provider_attempt_ledger',
            privilege_name
          ) then
            raise exception 'service_role retains forbidden attempt ledger %',
              privilege_name;
          end if;
        end loop;

        foreach privilege_name in array array['INSERT', 'UPDATE'] loop
          if pg_catalog.has_any_column_privilege(
            'service_role',
            'public.ai_provider_attempt_ledger',
            privilege_name
          ) then
            raise exception 'service_role retains % on an attempt column',
              privilege_name;
          end if;
          for column_name in
            select attribute.attname
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid =
              'public.ai_provider_attempt_ledger'::pg_catalog.regclass
              and attribute.attnum > 0
              and not attribute.attisdropped
            order by attribute.attnum
          loop
            if pg_catalog.has_column_privilege(
              'service_role',
              'public.ai_provider_attempt_ledger',
              column_name,
              privilege_name
            ) then
              raise exception 'service_role retains % on attempt column %',
                privilege_name, column_name;
            end if;
          end loop;
        end loop;

        if (
          select pg_catalog.count(*)
          from pg_catalog.pg_constraint as constraint_row
          where constraint_row.contype = 'f'
            and constraint_row.confdeltype = 'c'
            and (
              constraint_row.conrelid =
                'public.ai_provider_attempt_ledger'::pg_catalog.regclass
              or constraint_row.confrelid =
                'public.ai_provider_attempt_ledger'::pg_catalog.regclass
            )
        ) <> 1
           or not exists (
             select 1
             from pg_catalog.pg_constraint as constraint_row
             where constraint_row.contype = 'f'
               and constraint_row.confdeltype = 'c'
               and constraint_row.conrelid =
                 'public.ai_provider_attempt_ledger'::pg_catalog.regclass
               and constraint_row.confrelid =
                 'public.ai_request_ledger'::pg_catalog.regclass
               and constraint_row.conkey = array[
                 (
                   select attribute.attnum
                   from pg_catalog.pg_attribute as attribute
                   where attribute.attrelid = constraint_row.conrelid
                     and attribute.attname = 'reservation_id'
                     and not attribute.attisdropped
                 )
               ]::smallint[]
               and constraint_row.confkey = array[
                 (
                   select attribute.attnum
                   from pg_catalog.pg_attribute as attribute
                   where attribute.attrelid = constraint_row.confrelid
                     and attribute.attname = 'reservation_id'
                     and not attribute.attisdropped
                 )
               ]::smallint[]
           ) then
          raise exception 'attempt cleanup cascade topology drifted';
        end if;

        if has_function_privilege(
          'service_role',
          'public.guard_ai_provider_attempt_ledger()',
          'EXECUTE'
        ) then
          raise exception 'service_role can execute the attempt guard directly';
        end if;
      end;
      $assertions$;
    `);
  });

  it("allows service-role reads but denies direct DML and every attempt row lock", async () => {
    const fixture = await createReservation();
    const inserted = await insertStarted(fixture);
    expect(inserted.error).toBeNull();
    const attemptId = inserted.data!.attempt_id as string;

    const selected = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      \pset format unaligned
      \pset tuples_only on
      begin;
      set local role service_role;
      select attempt_id
      from public.ai_provider_attempt_ledger
      where attempt_id = ${sqlLiteral(attemptId)}::uuid;
      rollback;
    `);
    expect(selected.stdout).toContain(attemptId);

    for (const statement of [
      String.raw`insert into public.ai_provider_attempt_ledger (attempt_id)
        values (${sqlLiteral(crypto.randomUUID())}::uuid)`,
      String.raw`update public.ai_provider_attempt_ledger
        set status = status
        where attempt_id = ${sqlLiteral(attemptId)}::uuid`,
      String.raw`delete from public.ai_provider_attempt_ledger
        where attempt_id = ${sqlLiteral(attemptId)}::uuid`,
      "truncate table public.ai_provider_attempt_ledger",
    ]) {
      const denied = runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        \set VERBOSITY verbose
        begin;
        set local role service_role;
        ${statement};
        rollback;
      `, { expectFailure: true });
      expect(denied.stderr, statement).toMatch(/ERROR:\s+42501:/u);
    }

    const locked = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      \set VERBOSITY verbose
      begin;
      set local role service_role;
      select attempt_id
      from public.ai_provider_attempt_ledger
      where attempt_id = ${sqlLiteral(attemptId)}::uuid
      for update;
      rollback;
    `, { expectFailure: true });
    expect(locked.stderr).toMatch(/ERROR:\s+42501:/u);
  });

  it("stores a frozen started attempt and rejects duplicate caller identity", async () => {
    const fixture = await createReservation();
    const identity = crypto.randomUUID();
    const first = ownerInsertAttempt({
      ...startedAttempt(fixture),
      attempt_id: identity,
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      status: "started",
      runtime_contract_id: runtimeContractId,
    });

    const duplicate = ownerInsertAttempt(startedAttempt(fixture), true);
    expect(duplicate.error?.code).toBe(UNIQUE_VIOLATION);
  });

  it("rejects missing, null, and malformed runtime IDs at row boundaries", async () => {
    const fixture = await createReservation();
    const exact = startedAttempt(fixture) as Record<string, unknown>;
    const withoutId = { ...exact };
    delete withoutId.runtime_contract_id;

    const notNullCases = [
      ["missing id", withoutId],
      ["null id", { ...exact, runtime_contract_id: null }],
    ] as const;

    for (const [label, attempt] of notNullCases) {
      const result = ownerInsertAttempt(attempt, true);
      expect(result.error?.code, label).toBe("23502");
    }

    const malformedCases = [
      ["uppercase id", { runtime_contract_id: "Bad_Runtime" }],
      ["invalid first id character", { runtime_contract_id: "-bad-runtime" }],
      ["empty id", { runtime_contract_id: "" }],
      ["oversized id", { runtime_contract_id: `a${"b".repeat(200)}` }],
    ] as const;

    for (const [label, drift] of malformedCases) {
      const result = ownerInsertAttempt({ ...exact, ...drift }, true);
      expect(result.error?.code, label).toBe(CHECK_VIOLATION);
      expect(result.error?.message, label).toContain(
        "ai_provider_attempt_ledger_snapshot_shape_check",
      );
    }
  });

  it("enforces the runtime ID FK independently of the parent guard", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();
    const attemptId = started.data!.attempt_id as string;
    const unknownRuntimeId = `unknown-runtime.${crypto.randomUUID()}`;

    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      alter table public.ai_provider_attempt_ledger
        disable trigger guard_ai_provider_attempt_ledger;
      do $assertions$
      declare
        rejected boolean;
      begin
        rejected := false;
        begin
          update public.ai_provider_attempt_ledger
          set runtime_contract_id = ${sqlLiteral(unknownRuntimeId)}
          where attempt_id = ${sqlLiteral(attemptId)}::uuid;
        exception when foreign_key_violation then
          rejected := true;
        end;
        if not rejected then
          raise exception 'unknown runtime ID bypassed FK';
        end if;
      end;
      $assertions$;
      alter table public.ai_provider_attempt_ledger
        enable trigger guard_ai_provider_attempt_ledger;
      commit;
    `);
  });

  it("rejects a different known sealed runtime ID at the parent equality guard", async () => {
    const fixture = await createReservation();
    const knownPairDrift = ownerInsertAttempt({
      ...startedAttempt(fixture),
      runtime_contract_id: secondRuntimeContractId,
    }, true);
    expect(knownPairDrift.error?.code).toBe(CHECK_VIOLATION);
    expect(knownPairDrift.error?.message).toContain(
      "provider attempt route snapshot differs from its reservation",
    );
  });

  it("rejects runtime ID clear and swap on started and terminal rows", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();

    for (const [label, drift] of [
      ["clear started id", { runtime_contract_id: null }],
      ["swap started ID", {
        runtime_contract_id: secondRuntimeContractId,
      }],
    ] as const) {
      const update = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        drift,
        true,
      );
      expect(update.error?.code, label).toBe(CHECK_VIOLATION);
    }

    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      observedCompletion(),
    );
    expect(completed.error).toBeNull();

    for (const [label, drift] of [
      ["clear terminal id", { runtime_contract_id: null }],
      ["swap terminal ID", {
        runtime_contract_id: secondRuntimeContractId,
      }],
      ["mutate terminal observation", { latency_ms: 9999 }],
    ] as const) {
      const update = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        drift,
        true,
      );
      expect(update.error?.code, label).toBe(CHECK_VIOLATION);
    }

    const unchanged = await service
      .from("ai_provider_attempt_ledger")
      .select("runtime_contract_id,latency_ms")
      .eq("attempt_id", started.data!.attempt_id)
      .single();
    expect(unchanged.error).toBeNull();
    expect(unchanged.data).toEqual({
      runtime_contract_id: runtimeContractId,
      latency_ms: 1234,
    });
  });

  it("admits only started attempts and only a started-to-terminal update", async () => {
    const terminalFixture = await createReservation();
    const terminalInsert = ownerInsertAttempt({
      ...startedAttempt(terminalFixture),
      ...unavailableCompletion(),
    }, true);
    expect(terminalInsert.error?.code).toBe(CHECK_VIOLATION);

    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();
    const startedUpdate = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      { status: "started" },
      true,
    );
    expect(startedUpdate.error?.code).toBe(CHECK_VIOLATION);
  });

  it("rejects insert, late completion, and direct child deletion after parent finalization", async () => {
    const finalizedBeforeStart = await createReservation();
    await finalizeReservation(finalizedBeforeStart.reservationId);
    const insertAfterFinalize = ownerInsertAttempt(
      startedAttempt(finalizedBeforeStart),
      true,
    );
    expect(insertAfterFinalize.error?.code).toBe(CHECK_VIOLATION);

    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();
    await finalizeReservation(fixture.reservationId);

    const lateCompletion = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      unavailableCompletion(),
      true,
    );
    expect(lateCompletion.error?.code).toBe(CHECK_VIOLATION);

    const directDelete = ownerDeleteAttempt(
      started.data!.attempt_id as string,
      true,
    );
    expect(directDelete.error?.code).toBe(CHECK_VIOLATION);

    const unchanged = await service
      .from("ai_provider_attempt_ledger")
      .select("status")
      .eq("attempt_id", started.data!.attempt_id)
      .single();
    expect(unchanged.error).toBeNull();
    expect(unchanged.data?.status).toBe("started");
  });

  it("preserves observed automatic-cache usage as NULL + unavailable", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      observedCompletion(),
    );
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({
      runtime_contract_id: runtimeContractId,
      usage_observation_kind: "observed",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: null,
      input_standard_tokens: 40,
      usage_complete: true,
      cost_reconciliation_status: "not_available",
    });

    const overwrite = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      { input_cache_write_tokens: 0 },
      true,
    );
    expect(overwrite.error?.code).toBe(CHECK_VIOLATION);
  });

  it("accepts HMAC correlation tags plus exact frozen DeepSeek/MiMo route provenance", async () => {
    const deepseek = await createReservation();
    const routePairs = routingRulesFixture.routeObservationPairs;
    expect(routePairs.map(({ endpointAlias }) => endpointAlias).sort()).toEqual([
      "deepseek_official",
      "mimo_cn_official",
    ]);

    const mimoPair = routePairs.find(({ endpointAlias }) => endpointAlias === "mimo_cn_official");
    expect(mimoPair).toBeDefined();
    if (!mimoPair) {
      throw new Error("routing fixture is missing mimo_cn_official");
    }
    const mimo = await createCustomReservation({
      key: "mimo",
      gatewayKind: "direct_mimo",
      adapterKind: "mimo_responses_v1",
      wireApiKind: "responses_v1",
      endpointAlias: mimoPair.endpointAlias,
      modelId: mimoPair.modelId,
    });
    const modelProvenance = await createCustomReservation({
      key: "model-provenance",
      gatewayKind: "direct_deepseek",
      adapterKind: "fixture_chat_v1",
      wireApiKind: "chat_completions_v1",
      endpointAlias: "deepseek_official",
      modelId: "vendor/basic-model@2026",
    });
    const fixtureByEndpointAlias = new Map([
      ["deepseek_official", deepseek],
      ["mimo_cn_official", mimo],
    ]);
    const cases = [
      ...routePairs.map((pair) => {
        const fixture = fixtureByEndpointAlias.get(pair.endpointAlias);
        if (!fixture) {
          throw new Error(`DB route mirror is missing ${pair.endpointAlias}`);
        }
        return {
          fixture,
          modelId: pair.modelId,
          endpoint: pair.canonicalEndpoint,
        };
      }),
      {
        fixture: modelProvenance,
        modelId: "vendor/basic-model@2026",
        endpoint: "https://api.deepseek.com/chat/completions",
      },
    ];

    for (const { fixture, modelId, endpoint } of cases) {
      const started = await insertStarted(fixture);
      const completed = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        observedCompletion({
          actual_model_id: modelId,
          actual_upstream_endpoint: endpoint,
        }),
      );
      expect(completed.error).toBeNull();
      expect(completed.data).toMatchObject({
        gateway_request_id: GATEWAY_CORRELATION_TAG,
        provider_request_id: PROVIDER_CORRELATION_TAG,
        actual_model_id: modelId,
        actual_upstream_endpoint: endpoint,
      });
    }
  });

  it("accepts explicit NULL when no safe route observation is available", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      observedCompletion({
        gateway_request_id: null,
        provider_request_id: null,
        actual_model_id: null,
        actual_upstream_endpoint: null,
      }),
    );
    expect(completed.error).toBeNull();
  });

  it("rejects raw upstream IDs, credentials, JWTs, prose, and malformed HMAC tags", async () => {
    const unsafeRequestIds = [
      "gw-123",
      "provider-123",
      crypto.randomUUID(),
      "sk-live-do-not-store",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature",
      "ordinary request id prose",
      `hmac-sha256:${"A".repeat(64)}`,
      `HMAC-SHA256:${"a".repeat(64)}`,
      `hmac-sha256:${"a".repeat(63)}`,
      `hmac-sha256:${"a".repeat(65)}`,
      `hmac-sha256:${"g".repeat(64)}`,
      `hmac-sha256:${"a".repeat(32)}\n${"b".repeat(31)}`,
    ];

    for (const field of ["gateway_request_id", "provider_request_id"]) {
      for (const value of unsafeRequestIds) {
        const fixture = await createReservation();
        const started = await insertStarted(fixture);
        const completed = ownerUpdateAttempt(
          started.data!.attempt_id as string,
          observedCompletion({ [field]: value }),
          true,
        );
        expect(completed.error?.code, `${field}=${JSON.stringify(value)}`).toBe(CHECK_VIOLATION);
      }
    }
  });

  it("rejects any observed model that is not the frozen reservation model", async () => {
    for (const modelId of [
      "vendor/model.v2:pro",
      "deepseek-v4-flash ",
      "DeepSeek-v4-flash",
      "sk-live-model-prose",
      "",
    ]) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        observedCompletion({ actual_model_id: modelId }),
        true,
      );
      expect(completed.error?.code, JSON.stringify(modelId)).toBe(CHECK_VIOLATION);
    }
  });

  it("rejects malformed, credential-bearing, encoded, or non-HTTPS endpoint observations", async () => {
    const unsafeEndpoints = [
      "https:///api_key=do-not-store",
      "https://api.deepseek.com/v1/chat/completions",
      "https://api.deepseek.com/chat/completions/",
      "https://api.xiaomimimo.com/v1/responses",
      "https://api.deepseek.com/chat/completions/api_key=sk-live-do-not-store",
      "https://api.deepseek.com/chat/completions/sk-live-do-not-store",
      "http://api.example.com/v1",
      "HTTPS://api.example.com/v1",
      "https://",
      "https://api",
      "https://user:pass@api.example.com/v1",
      "https://api.example.com/v1?token=secret",
      "https://api.example.com/v1#fragment",
      "https://api.example.com/with space",
      "https://api.example.com/line\nbreak",
      "https://api.example.com/path@user",
      "https://api.example.com/%40hidden-userinfo",
      "https://secret.example.com/v1",
      "https://999.999.999.999/v1",
      "https://[::1]/v1",
      "https://-api.example.com/v1",
      "https://api..example.com/v1",
      "https://api.example.123/v1",
      "https://api.example.com:0/v1",
      "https://api.example.com:65536/v1",
      `https://${"a".repeat(500)}.com/v1`,
      `https://${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(63), "com"].join(".")}/v1`,
      `https://api.example.com/${"a".repeat(490)}`,
    ];

    for (const endpoint of unsafeEndpoints) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        observedCompletion({ actual_upstream_endpoint: endpoint }),
        true,
      );
      expect(completed.error?.code, endpoint).toBe(CHECK_VIOLATION);
    }
  });

  it("requires NULL endpoint observations for unknown aliases and alias/route mismatches", async () => {
    const cases = [
      {
        input: {
          key: "unknown-endpoint",
          gatewayKind: "direct_deepseek" as const,
          adapterKind: "fixture_chat_v1",
          wireApiKind: "chat_completions_v1" as const,
          endpointAlias: "unregistered_endpoint_v1",
          modelId: "fixture-unknown-endpoint-model",
        },
        endpoint: "https://unregistered.example.net/v1/responses",
      },
      {
        input: {
          key: "mismatched-endpoint",
          gatewayKind: "direct_deepseek" as const,
          adapterKind: "fixture_responses_v1",
          wireApiKind: "responses_v1" as const,
          endpointAlias: "deepseek_official",
          modelId: "fixture-mismatched-endpoint-model",
        },
        endpoint: "https://api.deepseek.com/chat/completions",
      },
    ];

    for (const { input, endpoint } of cases) {
      const fixture = await createCustomReservation(input);
      const started = await insertStarted(fixture);
      const nonNullEndpoint = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        observedCompletion({
          actual_model_id: input.modelId,
          actual_upstream_endpoint: endpoint,
        }),
        true,
      );
      expect(nonNullEndpoint.error?.code, input.key).toBe(CHECK_VIOLATION);

      const nullEndpoint = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        observedCompletion({
          actual_model_id: input.modelId,
          actual_upstream_endpoint: null,
        }),
      );
      expect(nullEndpoint.error, input.key).toBeNull();
    }
  });

  it("stores wholly unavailable usage without manufacturing zero tokens or cost", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      unavailableCompletion(),
    );
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({
      usage_observation_kind: "unavailable",
      input_total_tokens: null,
      input_cache_write_tokens: null,
      usage_complete: false,
      provider_billable: null,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
    });
  });

  it("keeps false distinct from unknown provider billability", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      {
        ...unavailableCompletion("canceled"),
        provider_billable: false,
      },
    );
    expect(completed.error).toBeNull();
    expect(completed.data?.provider_billable).toBe(false);
  });

  it.each([
    "succeeded",
    "invalid_output",
    "failed_upstream",
    "timed_out",
    "canceled",
    "unknown",
  ])("accepts terminal lifecycle status %s exactly once", async (status) => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      unavailableCompletion(status),
    );
    expect(completed.error).toBeNull();

    const secondCompletion = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      { latency_ms: 9999 },
      true,
    );
    expect(secondCompletion.error?.code).toBe(CHECK_VIOLATION);
  });

  it("reserves unknown for the reconciler's null-billable unavailable-usage shape", async () => {
    const invalidUnknownCompletions = [
      {
        label: "observed complete usage",
        completion: observedCompletion({
          status: "unknown",
          provider_billable: null,
          estimated_currency: null,
          estimated_cost_nanos: null,
          cost_reconciliation_status: "incomplete_usage",
          finish_reason: null,
        }),
      },
      {
        label: "known provider billability",
        completion: {
          ...unavailableCompletion("unknown"),
          provider_billable: false,
        },
      },
      {
        label: "known provider-reported cost",
        completion: {
          ...unavailableCompletion("unknown"),
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: 1,
        },
      },
      {
        label: "manufactured zero usage",
        completion: {
          ...unavailableCompletion("unknown"),
          usage_observation_kind: "observed",
          usage_schema_version: "normalized_usage_v2",
          input_total_tokens: 0,
          input_cache_read_tokens: 0,
          input_cache_write_tokens: 0,
          input_standard_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_usage_reporting: "not_applicable",
          usage_complete: true,
        },
      },
    ];

    for (const { label, completion } of invalidUnknownCompletions) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        completion,
        true,
      );
      expect(completed.error?.code, label).toBe(CHECK_VIOLATION);
    }
  });

  it.each([
    ["reported", 10, 20, 30, 60],
    ["not_applicable", 0, 0, 60, 60],
  ] as const)("accepts conserved %s cache usage", async (reporting, read, write, standard, total) => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      observedCompletion({
        cache_usage_reporting: reporting,
        input_cache_read_tokens: read,
        input_cache_write_tokens: write,
        input_standard_tokens: standard,
        input_total_tokens: total,
      }),
    );
    expect(completed.error).toBeNull();
  });

  it.each([
    ["pending", { estimated_currency: "CNY", estimated_cost_nanos: 10 }],
    ["matched", { estimated_currency: "CNY", estimated_cost_nanos: 10, provider_reported_currency: "CNY", provider_reported_cost_nanos: 10 }],
    ["mismatch", { estimated_currency: "CNY", estimated_cost_nanos: 10, provider_reported_currency: "CNY", provider_reported_cost_nanos: 11 }],
    ["incomplete_usage", { estimated_currency: null, estimated_cost_nanos: null }],
  ] as const)("accepts canonical %s cost reconciliation", async (reconciliation, cost) => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = ownerUpdateAttempt(
      started.data!.attempt_id as string,
      observedCompletion({
        cost_reconciliation_status: reconciliation,
        ...cost,
      }),
    );
    expect(completed.error).toBeNull();
  });

  it("rejects partial/UNKNOWN-shaped facts, unsafe route metadata, and numeric overflow", async () => {
    const cases: Array<Record<string, unknown>> = [
      { usage_observation_kind: null },
      { usage_schema_version: null },
      { usage_complete: null },
      { cache_usage_reporting: null },
      { input_cache_write_tokens: 0 },
      { input_standard_tokens: 41 },
      { reasoning_tokens: 21 },
      { input_total_tokens: "9007199254740992", input_cache_read_tokens: SAFE_INTEGER_MAX, input_standard_tokens: 1 },
      { route_observation_schema_version: null },
      { router_attempt_count: 0 },
      { router_attempt_count: 101 },
      { cost_observation_schema_version: null },
      { estimated_currency: null },
      { estimated_currency: "USD" },
      { provider_reported_currency: "USD", provider_reported_cost_nanos: 1234 },
      { cost_reconciliation_status: null },
      { cost_reconciliation_status: "matched", provider_reported_currency: null, provider_reported_cost_nanos: null },
      { actual_upstream_endpoint: "https://user:secret@example.com/v1" },
      { actual_upstream_endpoint: "https://api.example.com/v1?token=secret" },
      { provider_request_id: "api_key=do-not-store" },
      { failure_stage: "provider_http\nraw-message" },
      { latency_ms: null },
      { terminal_at: null },
      { terminal_at: "1970-01-01T00:00:00Z" },
    ];

    for (const invalid of cases) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = ownerUpdateAttempt(
        started.data!.attempt_id as string,
        observedCompletion(invalid),
        true,
      );
      expect(completed.error?.code, JSON.stringify(invalid)).toBe(CHECK_VIOLATION);
    }
  });

  it("rejects snapshot/profile/price alias drift and attempts for legacy parents", async () => {
    const fixture = await createReservation();
    for (const drift of [
      { model_id: "different-model" },
      { config_generation: 8 },
      { endpoint_alias: "other_endpoint_v1" },
      { calculator_kind: "other_calculator_v1" },
      { billing_currency: "USD" },
    ]) {
      const result = ownerInsertAttempt(
        { ...startedAttempt(fixture), ...drift },
        true,
      );
      expect(result.error?.code, JSON.stringify(drift)).toBe(CHECK_VIOLATION);
    }

    const legacy = await service
      .from("ai_request_ledger")
      .insert({
        request_id: crypto.randomUUID(),
        client_request_id: crypto.randomUUID(),
        user_id: user.id,
      })
      .select("reservation_id")
      .single();
    expect(legacy.error).toBeNull();

    const historicalAttempts = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_id", { count: "exact" })
      .eq("reservation_id", legacy.data!.reservation_id);
    expect(historicalAttempts.error).toBeNull();
    expect(historicalAttempts.count).toBe(0);

    const forged = ownerInsertAttempt({
      ...startedAttempt(fixture),
      reservation_id: legacy.data!.reservation_id,
    }, true);
    expect(forged.error?.code).toBe(CHECK_VIOLATION);
  });

  it("allows parent retention and user deletion cascades while leaving no orphan", async () => {
    const retentionFixture = await createReservation();
    const retentionAttempt = await insertStarted(retentionFixture);
    expect(retentionAttempt.error).toBeNull();
    await finalizeReservation(retentionFixture.reservationId);

    const deleteParent = await service
      .from("ai_request_ledger")
      .delete()
      .eq("reservation_id", retentionFixture.reservationId);
    expect(deleteParent.error).toBeNull();
    const retainedChild = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_id")
      .eq("attempt_id", retentionAttempt.data!.attempt_id)
      .maybeSingle();
    expect(retainedChild.error).toBeNull();
    expect(retainedChild.data).toBeNull();

    const cascadeUser = await createTestUser(service, "attempt-cascade");
    const fixture = await createReservation(cascadeUser);
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();

    await deleteTestUser(service, cascadeUser.id);
    const remaining = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_id")
      .eq("attempt_id", started.data!.attempt_id)
      .maybeSingle();
    expect(remaining.error).toBeNull();
    expect(remaining.data).toBeNull();
  });

  it("exposes no content-bearing/raw-provider columns", async () => {
    const response = await fetch(`${DB_TEST_ENV!.url}/rest/v1/`, {
      headers: {
        apikey: DB_TEST_ENV!.secretKey,
        authorization: `Bearer ${DB_TEST_ENV!.secretKey}`,
        accept: "application/openapi+json",
      },
    });
    expect(response.ok).toBe(true);
    const openApi = await response.json() as {
      definitions?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const columns = Object.keys(
      openApi.definitions?.ai_provider_attempt_ledger?.properties ?? {},
    );
    expect(columns).toContain("output_tokens");
    expect(columns).toContain("runtime_contract_id");
    expect(columns).not.toContain("runtime_contract_sha256");
    expect(columns.filter((column) =>
      /(^|_)(prompt|cv|content|body|message|raw|text)($|_)/.test(column),
    )).toEqual([]);
  });

  it("keeps attempt facts service-role only", async () => {
    const read = await anon
      .from("ai_provider_attempt_ledger")
      .select("attempt_id")
      .limit(1);
    expect(read.data).toBeNull();
    expect(read.error?.code).toBe(PERMISSION_DENIED);

    const fixture = await createReservation();
    const write = await anon
      .from("ai_provider_attempt_ledger")
      .insert(startedAttempt(fixture));
    expect(write.error?.code).toBe(PERMISSION_DENIED);

    const update = await anon
      .from("ai_provider_attempt_ledger")
      .update({ status: "canceled" })
      .eq("reservation_id", fixture.reservationId);
    expect(update.error?.code).toBe(PERMISSION_DENIED);

    const remove = await anon
      .from("ai_provider_attempt_ledger")
      .delete()
      .eq("reservation_id", fixture.reservationId);
    expect(remove.error?.code).toBe(PERMISSION_DENIED);
  });
});
