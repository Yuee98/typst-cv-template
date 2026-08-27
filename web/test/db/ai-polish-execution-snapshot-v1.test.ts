import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAnonClient,
  createServiceClient,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";
import {
  SettlementHarness,
  type SettlementReservation,
  type SettlementRouteFixture,
} from "./provider-attempt-settlement-fixtures";
import {
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
} from "./runtime-contract-fixtures";

const PERMISSION_DENIED = "42501";
const SCHEMA_VERSION = "ai_polish_execution_snapshot_v1";
const MAX_BIGINT = "9223372036854775807";

const FAILURE_KEYS = ["ok", "reason", "schemaVersion"].sort();
const SUCCESS_KEYS = [
  "ok",
  "priceSnapshot",
  "profileExecutionConfig",
  "reservationId",
  "routeSnapshot",
  "schemaVersion",
].sort();
const ROUTE_KEYS = [
  "configGeneration",
  "displayDisclosureKey",
  "gatewayKind",
  "legalBundleVersion",
  "modelId",
  "priceVersionId",
  "profileVersionId",
  "routingPolicyVersionId",
  "runtimeContractId",
  "runtimeContractSha256",
  "schemaVersion",
  "wireApiKind",
].sort();
const PROFILE_KEYS = [
  "adapterKind",
  "cachePolicyId",
  "calculatorKind",
  "capabilityContractId",
  "config",
  "credentialAlias",
  "displayDisclosureKey",
  "endpointAlias",
  "gatewayKind",
  "legalManifestId",
  "modelId",
  "profileKey",
  "schemaVersion",
  "wireApiKind",
].sort();
const PRICE_KEYS = [
  "calculatorKind",
  "components",
  "currency",
  "parameters",
  "priceVersionId",
  "schemaVersion",
].sort();

type JsonObject = Record<string, unknown>;

function ownerReplica(sql: string): void {
  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    set local session_replication_role = replica;
    ${sql}
    commit;
  `);
}

function exactFailure(reason: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    reason,
  };
}

describe.skipIf(!RUN_DB_TESTS)("AI polish execution snapshot V1 (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let authenticated: SupabaseClient;
  let harness: SettlementHarness;
  let primaryUser: TestUser;
  let primaryFixture: SettlementRouteFixture;
  let primaryReservation: SettlementReservation;

  async function snapshot(
    reservationId: string | null,
    userId: string | null,
  ) {
    return service.rpc("get_ai_polish_execution_snapshot_v1", {
      p_reservation_id: reservationId,
      p_user_id: userId,
    });
  }

  async function successfulPrimarySnapshot(): Promise<JsonObject> {
    const result = await snapshot(primaryReservation.reservationId, primaryUser.id);
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      reservationId: primaryReservation.reservationId,
    });
    return result.data as JsonObject;
  }

  // Replica-role catalog mutations below are hostile, owner-only corruption
  // fixtures. They are not valid DB-013 operator lifecycle calls.
  async function expectUnavailableDuring(
    corruptSql: string,
    restoreSql: string,
  ): Promise<void> {
    ownerReplica(corruptSql);
    try {
      const result = await snapshot(primaryReservation.reservationId, primaryUser.id);
      expect(result.error).toBeNull();
      expect(result.data).toEqual(exactFailure("SERVICE_UNAVAILABLE"));
      expect(Object.keys(result.data as JsonObject).sort()).toEqual(FAILURE_KEYS);
    } finally {
      ownerReplica(restoreSql);
    }
  }

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    harness = new SettlementHarness(service);
    await harness.setup();
    primaryFixture = { ...harness.fixture };
    primaryUser = await harness.makeUser("execution-snapshot-primary");
    primaryReservation = await harness.reserveV2(primaryUser);
    authenticated = await signInAsUser(primaryUser);
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("freezes the exact same-owner definer, lock boundary, and execute matrix", () => {
    runOwnerSql(String.raw`
      do $catalog$
      declare
        v_snapshot pg_catalog.pg_proc%rowtype;
        v_reserve pg_catalog.pg_proc%rowtype;
        v_definition text;
        v_owner_name text;
        v_count integer;
      begin
        select count(*) into v_count
        from pg_catalog.pg_proc as procedure
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = 'get_ai_polish_execution_snapshot_v1';

        if v_count <> 1 then
          raise exception 'execution snapshot overload count drifted: %', v_count;
        end if;

        select procedure.* into strict v_snapshot
        from pg_catalog.pg_proc as procedure
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = 'get_ai_polish_execution_snapshot_v1'
          and pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
            'p_reservation_id uuid, p_user_id uuid';

        select procedure.* into strict v_reserve
        from pg_catalog.pg_proc as procedure
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = 'reserve_ai_polish_request_v2';

        v_definition := lower(pg_catalog.pg_get_functiondef(v_snapshot.oid));
        select role.rolname into strict v_owner_name
        from pg_catalog.pg_roles as role
        where role.oid = v_snapshot.proowner;

        if v_snapshot.prorettype <> 'jsonb'::pg_catalog.regtype
           or not v_snapshot.prosecdef
           or v_snapshot.provolatile <> 'v'
           or v_snapshot.proconfig is distinct from array['search_path=""']::text[]
           or v_snapshot.proowner is distinct from v_reserve.proowner
           or v_owner_name in ('service_role', 'anon', 'authenticated', 'authenticator')
           or pg_catalog.pg_has_role('service_role', v_snapshot.proowner, 'SET') then
          raise exception 'execution snapshot catalog contract drifted';
        end if;

        if (
             length(v_definition) - length(replace(v_definition, 'for share', ''))
           ) / length('for share') <> 1
           or position('for update' in v_definition) <> 0
           or position('ai_feature_config' in v_definition) <> 0
           or position('ai_routing_policy_versions' in v_definition) <> 0
           or position('ai_provider_attempt_ledger' in v_definition) <> 0
           or position('clock_timestamp' in v_definition) <> 0
           or position('now()' in v_definition) <> 0
           or position('pg_advisory' in v_definition) <> 0
           or v_definition ~ '\m(insert|update|delete)\M' then
          raise exception 'execution snapshot read/lock boundary drifted';
        end if;

        if not pg_catalog.has_function_privilege(
             'service_role', v_snapshot.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_snapshot.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_snapshot.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('public', v_snapshot.oid, 'EXECUTE') then
          raise exception 'execution snapshot execute matrix drifted';
        end if;
      end;
      $catalog$;
    `);
  });

  it("denies API roles before exposing reservation existence", async () => {
    const args = {
      p_reservation_id: primaryReservation.reservationId,
      p_user_id: primaryUser.id,
    };
    for (const client of [anon, authenticated]) {
      const result = await client.rpc("get_ai_polish_execution_snapshot_v1", args);
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("returns the exact request-bound route, profile, and price shapes", async () => {
    const profile = await service
      .from("ai_provider_profiles")
      .select("profile_key")
      .eq("id", primaryFixture.profileId)
      .single();
    expect(profile.error).toBeNull();

    const result = await successfulPrimarySnapshot();
    expect(Object.keys(result).sort()).toEqual(SUCCESS_KEYS);
    expect(Object.keys(result.routeSnapshot as JsonObject).sort()).toEqual(
      ROUTE_KEYS,
    );
    expect(Object.keys(result.profileExecutionConfig as JsonObject).sort()).toEqual(
      PROFILE_KEYS,
    );
    expect(Object.keys(result.priceSnapshot as JsonObject).sort()).toEqual(
      PRICE_KEYS,
    );

    expect(result.routeSnapshot).toEqual(primaryReservation.routeSnapshot);
    expect(result.profileExecutionConfig).toEqual({
      schemaVersion: "profile_execution_config_v1",
      profileKey: profile.data!.profile_key,
      gatewayKind: "direct_deepseek",
      adapterKind: "deepseek_chat_v1",
      wireApiKind: "chat_completions_v1",
      credentialAlias: "deepseek_api_key",
      endpointAlias: "deepseek_official",
      modelId: primaryFixture.modelId,
      capabilityContractId: "polish_v2",
      cachePolicyId: "automatic_cache_v1",
      legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
      calculatorKind: "linear_token_v1",
      displayDisclosureKey: primaryFixture.displayDisclosureKey,
      config: {},
    });
    expect(result.priceSnapshot).toEqual({
      schemaVersion: "price_snapshot_v1",
      priceVersionId: primaryFixture.priceVersionId,
      currency: "CNY",
      calculatorKind: "linear_token_v1",
      components: {
        input_cache_read: "1",
        input_standard: "1",
        output: "1",
      },
      parameters: {},
    });
    expect(JSON.stringify(result)).not.toMatch(
      /display_name|model_vendor|model_snapshot|upstream_route|config_sha256|source_url|source_snapshot|https:\/\//,
    );
  });

  it("makes null, unknown, and wrong-user reservations byte-equal NOT_FOUND", async () => {
    const otherUser = await harness.makeUser("execution-snapshot-wrong-user");
    const probes = [
      await snapshot(null, primaryUser.id),
      await snapshot(crypto.randomUUID(), primaryUser.id),
      await snapshot(primaryReservation.reservationId, null),
      await snapshot(primaryReservation.reservationId, otherUser.id),
    ];
    for (const result of probes) {
      expect(result.error).toBeNull();
      expect(result.data).toEqual(exactFailure("NOT_FOUND"));
      expect(Object.keys(result.data as JsonObject).sort()).toEqual(FAILURE_KEYS);
    }
  });

  it("returns finalized precedence without inspecting corrupted route facts", async () => {
    const user = await harness.makeUser("execution-snapshot-finalized");
    const reservation = await harness.reserveV2(user);
    const finalized = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: reservation.reservationId,
      p_status: "released",
      p_quota_charged: false,
      p_provider_billable: false,
      p_usage: null,
      p_metadata: null,
      p_settlement_contract: "durable_cancellation_sequence_v1",
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({ ok: true });

    ownerReplica(String.raw`
      update public.ai_request_ledger
      set model_id = 'drifted-after-finalize'
      where reservation_id = '${reservation.reservationId}'::uuid;
    `);
    try {
      const result = await snapshot(reservation.reservationId, user.id);
      expect(result.error).toBeNull();
      expect(result.data).toEqual(exactFailure("ALREADY_FINALIZED"));
    } finally {
      ownerReplica(String.raw`
        update public.ai_request_ledger
        set model_id = '${reservation.routeSnapshot.modelId}'
        where reservation_id = '${reservation.reservationId}'::uuid;
      `);
    }
  });

  it("maps non-final legacy reservations to exact SERVICE_UNAVAILABLE", async () => {
    const user = await harness.makeUser("execution-snapshot-legacy");
    const legacy = await service.rpc("reserve_ai_polish_request", {
      p_user_id: user.id,
      p_request_id: crypto.randomUUID(),
      p_client_request_id: crypto.randomUUID(),
    });
    expect(legacy.error).toBeNull();
    expect(legacy.data).toMatchObject({ allowed: true });

    const result = await snapshot(legacy.data.reservationId as string, user.id);
    expect(result.error).toBeNull();
    expect(result.data).toEqual(exactFailure("SERVICE_UNAVAILABLE"));
  });

  it("ignores current pointer/time and round-trips bigint maxima as strings", async () => {
    const frozenBefore = await successfulPrimarySnapshot();
    await harness.activateFreshRouteFixture("mimo");
    expect(await successfulPrimarySnapshot()).toEqual(frozenBefore);

    const originalGeneration = primaryReservation.routeSnapshot.configGeneration;
    ownerReplica(String.raw`
      update public.ai_request_ledger
      set config_generation = ${MAX_BIGINT}::bigint
      where reservation_id = '${primaryReservation.reservationId}'::uuid;
      update public.ai_price_components
      set nanos_per_million = ${MAX_BIGINT}::bigint
      where price_version_id = '${primaryFixture.priceVersionId}'::uuid
        and component = 'input_standard';
    `);
    try {
      const result = await successfulPrimarySnapshot();
      expect((result.routeSnapshot as JsonObject).configGeneration).toBe(
        MAX_BIGINT,
      );
      expect(
        ((result.priceSnapshot as JsonObject).components as JsonObject)
          .input_standard,
      ).toBe(MAX_BIGINT);
      expect(JSON.stringify(result)).toContain(`"${MAX_BIGINT}"`);
    } finally {
      ownerReplica(String.raw`
        update public.ai_request_ledger
        set config_generation = ${originalGeneration}::bigint
        where reservation_id = '${primaryReservation.reservationId}'::uuid;
        update public.ai_price_components
        set nanos_per_million = 1
        where price_version_id = '${primaryFixture.priceVersionId}'::uuid
          and component = 'input_standard';
      `);
    }
  });

  it("fails closed on missing, cross-bound, unsealed, and drifting history", async () => {
    const replacement =
      harness.fixture.priceVersionId === primaryFixture.priceVersionId
        ? await harness.activateFreshRouteFixture("mimo")
        : harness.fixture;
    const requestId = primaryReservation.reservationId;
    const versionId = primaryFixture.profileVersionId;
    const priceId = primaryFixture.priceVersionId;
    const missingProfileVersionId = crypto.randomUUID();
    const missingPriceVersionId = crypto.randomUUID();
    const price = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", priceId)
      .single();
    expect(price.error).toBeNull();
    const bundle = await service
      .from("ai_legal_bundle_versions")
      .select("sealed_at")
      .eq("legal_bundle_version", INITIAL_LEGAL_BUNDLE_VERSION)
      .single();
    expect(bundle.error).toBeNull();

    await expectUnavailableDuring(
      `update public.ai_request_ledger
       set profile_version_id = '${missingProfileVersionId}'::uuid
       where reservation_id = '${requestId}'::uuid;`,
      `update public.ai_request_ledger
       set profile_version_id = '${versionId}'::uuid
       where reservation_id = '${requestId}'::uuid;`,
    );
    await expectUnavailableDuring(
      `update public.ai_request_ledger
       set price_version_id = '${missingPriceVersionId}'::uuid
       where reservation_id = '${requestId}'::uuid;`,
      `update public.ai_request_ledger
       set price_version_id = '${priceId}'::uuid
       where reservation_id = '${requestId}'::uuid;`,
    );
    await expectUnavailableDuring(
      `update public.ai_request_ledger
       set price_version_id = '${replacement.priceVersionId}'::uuid
       where reservation_id = '${requestId}'::uuid;`,
      `update public.ai_request_ledger
       set price_version_id = '${priceId}'::uuid
       where reservation_id = '${requestId}'::uuid;`,
    );

    for (const [column, corruptValue, restoreValue] of [
      ["gateway_kind", "direct_mimo", "direct_deepseek"],
      ["model_id", "drifted-model", primaryFixture.modelId],
      ["wire_api_kind", "responses_v1", "chat_completions_v1"],
      [
        "display_disclosure_key",
        "drifted-disclosure",
        primaryFixture.displayDisclosureKey,
      ],
    ]) {
      await expectUnavailableDuring(
        `update public.ai_request_ledger set ${column} = '${corruptValue}'
         where reservation_id = '${requestId}'::uuid;`,
        `update public.ai_request_ledger set ${column} = '${restoreValue}'
         where reservation_id = '${requestId}'::uuid;`,
      );
    }

    await expectUnavailableDuring(
      `update public.ai_provider_profile_versions
       set legal_manifest_id = 'missing-legal-manifest'
       where id = '${versionId}'::uuid;`,
      `update public.ai_provider_profile_versions
       set legal_manifest_id = '${DEEPSEEK_LEGAL_MANIFEST_ID}'
       where id = '${versionId}'::uuid;`,
    );
    await expectUnavailableDuring(
      `update public.ai_price_versions set components_sealed_at = null
       where id = '${priceId}'::uuid;`,
      `update public.ai_price_versions
       set components_sealed_at = '${price.data!.components_sealed_at}'::timestamptz
       where id = '${priceId}'::uuid;`,
    );
    await expectUnavailableDuring(
      `delete from public.ai_price_components
       where price_version_id = '${priceId}'::uuid and component = 'output';`,
      `insert into public.ai_price_components (
         price_version_id, component, nanos_per_million
       ) values ('${priceId}'::uuid, 'output', 1);`,
    );
    await expectUnavailableDuring(
      `update public.ai_service_runtime_contract_versions set sealed_at = null
       where runtime_contract_id = '${primaryFixture.runtimeContractId}';`,
      `update public.ai_service_runtime_contract_versions
       set sealed_at = greatest(created_at, clock_timestamp())
       where runtime_contract_id = '${primaryFixture.runtimeContractId}';`,
    );
    await expectUnavailableDuring(
      `update public.ai_legal_bundle_versions set sealed_at = null
       where legal_bundle_version = '${INITIAL_LEGAL_BUNDLE_VERSION}';`,
      `update public.ai_legal_bundle_versions
       set sealed_at = '${bundle.data!.sealed_at}'::timestamptz
       where legal_bundle_version = '${INITIAL_LEGAL_BUNDLE_VERSION}';`,
    );

    expect(await successfulPrimarySnapshot()).toMatchObject({
      routeSnapshot: { profileVersionId: versionId, priceVersionId: priceId },
    });
  });

  // Owner-only corruption seam: these direct catalog mutations intentionally
  // create an impossible state that DB-013 operator RPCs must never author.
  it("keeps frozen projection after owner-only price closure and profile-version retirement corruption", async () => {
    try {
      const before = await successfulPrimarySnapshot();
      const closePrice = runOwnerSql(String.raw`
        update public.ai_price_versions
        set valid_to = pg_catalog.clock_timestamp()
        where id = '${primaryFixture.priceVersionId}'::uuid;
      `);
      expect(closePrice.status).toBe(0);
      expect(await successfulPrimarySnapshot()).toEqual(before);

      const retireProfile = runOwnerSql(String.raw`
        update public.ai_provider_profile_versions
        set status = 'retired'
        where id = '${primaryFixture.profileVersionId}'::uuid;
      `);
      expect(retireProfile.status).toBe(0);
      expect(await successfulPrimarySnapshot()).toEqual(before);

      const start = await service.rpc("start_ai_polish_provider_attempt", {
        p_reservation_id: primaryReservation.reservationId,
        p_attempt_no: 1,
      });
      expect(start.error).toBeNull();
      expect(start.data).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
    } finally {
      // The corrupted catalog history cannot pass audited pointer-clear
      // revalidation. Replace it with a healthy audited route so afterAll can
      // clear that exact pointer through the normal DB013 lifecycle seam.
      await harness.activateFreshRouteFixture("deepseek");
    }
  });
});
