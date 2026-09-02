import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acceptAiLegalBundle,
  configureFeature,
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  getLedgerRows,
  getRateBuckets,
  getUsageRow,
  RUN_DB_TESTS,
  setCurrentRateBucketCount,
  setDailyUsageCount,
  settleAwayFromMinuteBoundary,
  signInAsUser,
} from "./helpers";
import {
  authorSyntheticRuntimeContractSet,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  MIMO_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_MANIFEST_SHA256,
  readLifecycleEvidenceRoot,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  transitionPolicyAsDatabaseOwner,
  type SyntheticRuntimeContractSet,
} from "./runtime-contract-fixtures";

const PERMISSION_DENIED = "42501";
const V1_FUNCTION_DEFINITION_SHA256 =
  "bbb26fb02b70241ecab26dbb84bd934a0074c317dcc48119c55618902237ecb2";

interface RouteNode {
  profileId: string;
  profileKey: string;
  profileVersionId: string;
  priceVersionId: string;
  legalManifestId: string;
  displayDisclosureKey: string;
  gatewayKind: "direct_deepseek" | "direct_mimo";
  modelId: string;
  wireApiKind: "chat_completions_v1" | "responses_v1";
}

interface ActiveRouteFixture {
  policyVersionId: string;
  defaultNode: RouteNode;
  selectedNode: RouteNode;
  runtime: SyntheticRuntimeContractSet;
}

interface ExpectedRoute {
  schema_version: "expected_route_v1";
  config_generation: string;
  profile_version_id: string;
  legal_bundle_version: string;
  runtime_contract_id: string;
}

interface ReserveV2Result {
  allowed: boolean;
  reason?: string;
  reservationId?: string;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  routeSnapshot?: Record<string, unknown>;
}

function shanghaiClock() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  const jsWeekday = shifted.getUTCDay();
  return {
    weekday: jsWeekday === 0 ? 7 : jsWeekday,
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function ownerReplica(sql: string): void {
  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    set local session_replication_role = replica;
    ${sql}
    commit;
  `);
}

function ownerSql(sql: string): void {
  runOwnerSql(String.raw`\set ON_ERROR_STOP on
    begin;
    ${sql}
    commit;`);
}

describe.skipIf(!RUN_DB_TESTS)("reserve V2 route snapshot (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
    anon = createAnonClient();
  });

  afterAll(async () => {
    const { data } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id")
      .eq("id", true)
      .single();
    if (data?.active_routing_policy_version_id) {
      ownerSql(`update public.ai_feature_config set active_routing_policy_version_id=null, routing_updated_by='reserve-v2-cleanup', routing_change_reason='reserve V2 cleanup ${crypto.randomUUID()}' where id=true;`);
    }
    await configureFeature(service, {
      enabled: false,
      globalDailyLimit: 2000,
      allowlist: [],
    });
  });

  async function createRouteNode(input: {
    label: string;
    gatewayKind: RouteNode["gatewayKind"];
    modelVendor: string;
    adapterKind: string;
    wireApiKind: RouteNode["wireApiKind"];
    modelId: string;
    legalManifestId: string;
    displayDisclosureKey: string;
  }): Promise<RouteNode> {
    const suffix = crypto.randomUUID();
    const profileKey = `test.reserve-v2.${input.label}.${suffix}`;
    const profileId = crypto.randomUUID(); const profileVersionId = crypto.randomUUID(); const priceVersionId = crypto.randomUUID();
      ownerSql(String.raw`
        insert into public.ai_provider_profiles(id,profile_key,display_name,gateway_kind,model_vendor)
          values ('${profileId}','${profileKey}','Reserve V2 ${input.label}','${input.gatewayKind}','${input.modelVendor}');
        insert into public.ai_provider_profile_versions(
          id,profile_id,version,adapter_kind,wire_api_kind,credential_alias,
          endpoint_alias,model_id,upstream_route,capability_contract_id,
          cache_policy_id,legal_manifest_id,display_disclosure_key,config,config_sha256
        ) values (
          '${profileVersionId}','${profileId}',1,'${input.adapterKind}','${input.wireApiKind}',
          '${input.modelVendor}_api_key','${input.modelVendor}_official','${input.modelId}',
          '{}'::jsonb,'polish_v2','automatic_cache_v1','${input.legalManifestId}',
          '${input.displayDisclosureKey}','{}'::jsonb,'${"1".repeat(64)}'
        );
        insert into public.ai_price_versions(
          id,profile_version_id,version,pricing_lane,currency,calculator_kind,
          valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters
        ) values (
          '${priceVersionId}','${profileVersionId}',1,'default','CNY','linear_token_v1',
          clock_timestamp()-interval '1 hour','https://example.com/${input.label}-price',
          clock_timestamp(),'${"2".repeat(64)}','{}'::jsonb
        );
        insert into public.ai_price_components(price_version_id,component,nanos_per_million)
          values ('${priceVersionId}','input_standard',1),
                 ('${priceVersionId}','input_cache_read',1),
                 ('${priceVersionId}','output',1);
      `);
    sealPriceAsDatabaseOwner(priceVersionId);
    ownerSql(`update public.ai_provider_profile_versions set status='validated' where id='${profileVersionId}';`);

    return {
      profileId,
      profileKey,
      profileVersionId,
      priceVersionId,
      legalManifestId: input.legalManifestId,
      displayDisclosureKey: input.displayDisclosureKey,
      gatewayKind: input.gatewayKind,
      modelId: input.modelId,
      wireApiKind: input.wireApiKind,
    };
  }

  async function createAdditionalPrice(input: {
    profileVersionId: string;
    label: string;
    pricingLane: string;
  }): Promise<string> {
    const priceId = crypto.randomUUID();
    ownerSql(String.raw`
      insert into public.ai_price_versions(
        id,profile_version_id,version,pricing_lane,currency,calculator_kind,
        valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters
      ) values (
        '${priceId}','${input.profileVersionId}',1,'${input.pricingLane}','CNY','linear_token_v1',
        clock_timestamp()-interval '1 hour','https://example.com/${input.label}-price',
        clock_timestamp(),'${"4".repeat(64)}','{}'::jsonb
      );
      insert into public.ai_price_components(price_version_id,component,nanos_per_million)
        values ('${priceId}','input_standard',1),
               ('${priceId}','input_cache_read',1),
               ('${priceId}','output',1);
    `);
    sealPriceAsDatabaseOwner(priceId);
    return priceId;
  }

  async function createActiveFixture(options: {
    label: string;
    window?:
      | "matches-alternate"
      | "ends-at-current-minute"
      | "same-profile-price";
  }): Promise<ActiveRouteFixture> {
    const defaultNode = await createRouteNode({
      label: `${options.label}.deepseek`,
      gatewayKind: "direct_deepseek",
      modelVendor: "deepseek",
      adapterKind: "deepseek_chat_v1",
      wireApiKind: "chat_completions_v1",
      modelId: "deepseek-v4-flash",
      legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
      displayDisclosureKey: "deepseek.official",
    });
    let alternateNode =
      options.window && options.window !== "same-profile-price"
      ? await createRouteNode({
          label: `${options.label}.mimo`,
          gatewayKind: "direct_mimo",
          modelVendor: "mimo",
          adapterKind: "mimo_responses_v1",
          wireApiKind: "responses_v1",
          modelId: "mimo-v2.5-pro",
          legalManifestId: MIMO_LEGAL_MANIFEST_ID,
          displayDisclosureKey: "mimo.official",
        })
      : null;
    if (options.window === "same-profile-price") {
      const sameProfilePriceVersionId = await createAdditionalPrice({
        profileVersionId: defaultNode.profileVersionId,
        label: `${options.label}.deepseek.peak`,
        pricingLane: "peak",
      });
      alternateNode = {
        ...defaultNode,
        priceVersionId: sameProfilePriceVersionId,
      };
    }
    const nodes = alternateNode ? [defaultNode, alternateNode] : [defaultNode];
    const uniqueProfileNodes = [
      ...new Map(nodes.map((node) => [node.profileVersionId, node])).values(),
    ];
    const runtime = authorSyntheticRuntimeContractSet(
      uniqueProfileNodes.map((node) => ({
        profileKey: node.profileKey,
        legalManifestId: node.legalManifestId,
        manifestSha256:
          node.legalManifestId === MIMO_LEGAL_MANIFEST_ID
            ? MIMO_LEGAL_MANIFEST_SHA256
            : DEEPSEEK_LEGAL_MANIFEST_SHA256,
      })),
    );

    const clock = shanghaiClock();
    let selectedNode = defaultNode;
    let windows: Array<Record<string, unknown>> = [];
    if (
      options.window === "matches-alternate"
      || options.window === "same-profile-price"
    ) {
      const endMinute = Math.min(1440, clock.minute + 5);
      const startMinute = Math.max(0, endMinute - 5);
      selectedNode = alternateNode!;
      windows = [
        {
          weekdays: [clock.weekday],
          startMinute,
          endMinute,
          route: {
            profileVersionId: alternateNode!.profileVersionId,
            priceVersionId: alternateNode!.priceVersionId,
          },
        },
      ];
    } else if (options.window === "ends-at-current-minute") {
      const startMinute = clock.minute === 0 ? 1 : Math.max(0, clock.minute - 5);
      const endMinute = clock.minute === 0 ? 2 : clock.minute;
      windows = [
        {
          weekdays: [clock.weekday],
          startMinute,
          endMinute,
          route: {
            profileVersionId: alternateNode!.profileVersionId,
            priceVersionId: alternateNode!.priceVersionId,
          },
        },
      ];
    }

    const policyId = crypto.randomUUID();
    const rulesJson = JSON.stringify({
      schemaVersion: "routing_rules_v1",
      defaultRoute: {
        profileVersionId: defaultNode.profileVersionId,
        priceVersionId: defaultNode.priceVersionId,
      },
      windows,
    }).replaceAll("'", "''");
    ownerSql(String.raw`
      insert into public.ai_routing_policy_versions(
        id,policy_key,version,status,timezone,rules,default_profile_version_id,
        legal_bundle_version,runtime_contract_id,config_sha256
      ) values (
        '${policyId}','test.reserve-v2.policy.${options.label}.${crypto.randomUUID()}',1,
        'draft','Asia/Shanghai',
         '${rulesJson}'::jsonb,
        '${defaultNode.profileVersionId}','${INITIAL_LEGAL_BUNDLE_VERSION}',
        '${runtime.runtimeContractId}','${"3".repeat(64)}'
      );
    `);

    transitionPolicyAsDatabaseOwner(policyId, "validated");
    for (const node of uniqueProfileNodes) {
      ownerSql(`update public.ai_provider_profile_versions set status='canary' where id='${node.profileVersionId}';`);
    }
    transitionPolicyAsDatabaseOwner(policyId, "canary");

    ownerSql(`update public.ai_feature_config set active_routing_policy_version_id='${policyId}', routing_updated_by='reserve-v2-test', routing_change_reason='activate ${options.label} ${crypto.randomUUID()}' where id=true;`);
    await configureFeature(service, {
      enabled: true,
      globalDailyLimit: 2000,
      allowlist: [],
    });

    return {
      policyVersionId: policyId,
      defaultNode,
      selectedNode,
      runtime,
    };
  }

  async function expectedRoute(
    fixture: ActiveRouteFixture,
  ): Promise<ExpectedRoute> {
    const { data, error } = await service
      .from("ai_feature_config")
      .select("config_generation")
      .eq("id", true)
      .single();
    expect(error).toBeNull();
    return {
      schema_version: "expected_route_v1",
      config_generation: String(data!.config_generation),
      profile_version_id: fixture.selectedNode.profileVersionId,
      legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
      runtime_contract_id: fixture.runtime.runtimeContractId,
    };
  }

  async function reserveV2(
    userId: string,
    expected: unknown,
    clientRequestId = crypto.randomUUID(),
    options: { acceptTerms?: boolean } = {},
  ) {
    if (options.acceptTerms !== false) {
      await acceptAiLegalBundle(service, userId, INITIAL_LEGAL_BUNDLE_VERSION);
    }
    return service.rpc("reserve_ai_polish_request_v2", {
      p_user_id: userId,
      p_request_id: crypto.randomUUID(),
      p_client_request_id: clientRequestId,
      p_expected_route: expected,
    });
  }

  async function availabilityV1(userId: string) {
    return service.rpc("get_ai_polish_availability_v1", {
      p_user_id: userId,
    });
  }

  async function expectNoAdmissionRows(userId: string) {
    expect(await getUsageRow(service, userId)).toBeNull();
    expect(await getRateBuckets(service, userId)).toEqual([]);
    expect(await getLedgerRows(service, userId)).toEqual([]);
  }

  function exactMutableState(
    userIds: string[],
    fixture: ActiveRouteFixture,
  ): string {
    const users = userIds.map((id) => `'${id}'::uuid`).join(", ");
    const profiles = [
      fixture.defaultNode.profileVersionId,
      fixture.selectedNode.profileVersionId,
    ]
      .map((id) => `'${id}'::uuid`)
      .join(", ");
    return runOwnerSql(String.raw`
      \pset format unaligned
      \pset tuples_only on
      select jsonb_build_object(
        'requests', (
          select coalesce(jsonb_agg(to_jsonb(row_value) order by reservation_id), '[]'::jsonb)
          from public.ai_request_ledger as row_value
          where user_id in (${users})
        ),
        'attempts', (
          select coalesce(jsonb_agg(to_jsonb(attempt) order by attempt.attempt_id), '[]'::jsonb)
          from public.ai_provider_attempt_ledger as attempt
          join public.ai_request_ledger as request
            on request.reservation_id = attempt.reservation_id
          where request.user_id in (${users})
        ),
        'userDaily', (
          select coalesce(jsonb_agg(to_jsonb(row_value) order by user_id, day), '[]'::jsonb)
          from public.ai_usage_daily as row_value
          where user_id in (${users})
        ),
        'rate', (
          select coalesce(jsonb_agg(to_jsonb(row_value) order by user_id, minute_bucket), '[]'::jsonb)
          from public.ai_rate_minutes as row_value
          where user_id in (${users})
        ),
        'globalDaily', (
          select coalesce(jsonb_agg(to_jsonb(row_value) order by day), '[]'::jsonb)
          from public.ai_global_usage_daily as row_value
        ),
        'profileDaily', (
          select coalesce(
            jsonb_agg(to_jsonb(row_value) order by day, profile_version_id, billing_currency),
            '[]'::jsonb
          )
          from public.ai_profile_usage_daily as row_value
          where profile_version_id in (${profiles})
        ),
        'acceptances', (
          select coalesce(jsonb_agg(to_jsonb(row_value) order by user_id, document_key, version), '[]'::jsonb)
          from public.user_terms_acceptances as row_value
          where user_id in (${users})
        ),
        'featureConfig', (
          select to_jsonb(row_value)
          from public.ai_feature_config as row_value
          where id = true
        ),
        'policy', (
          select to_jsonb(row_value)
          from public.ai_routing_policy_versions as row_value
          where id = '${fixture.policyVersionId}'::uuid
        ),
        'sequences', (
          select coalesce(
            jsonb_agg(to_jsonb(row_value) order by schemaname, sequencename),
            '[]'::jsonb
          )
          from pg_catalog.pg_sequences as row_value
          where schemaname = 'public'
        )
      )::text;
    `).stdout.trim();
  }

  it("freezes the exact signature, authority, grants, and unchanged V1 fingerprint", () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $$
      declare
        v_v2 pg_proc%rowtype;
        v_v1 pg_proc%rowtype;
        v_v1_hash text;
      begin
        select * into v_v2
        from pg_proc
        where oid = 'public.reserve_ai_polish_request_v2(uuid,uuid,uuid,jsonb)'::regprocedure;
        select * into v_v1
        from pg_proc
        where oid = 'public.reserve_ai_polish_request(uuid,uuid,uuid)'::regprocedure;

        if pg_get_function_arguments(v_v2.oid) is distinct from
             'p_user_id uuid, p_request_id uuid, p_client_request_id uuid, p_expected_route jsonb'
           or pg_get_function_result(v_v2.oid) is distinct from 'jsonb'
           or not v_v2.prosecdef
           or v_v2.proconfig is distinct from array['search_path=""']::text[] then
          raise exception 'reserve V2 signature/security/search_path drifted';
        end if;

        if not has_function_privilege(
             'service_role', v_v2.oid, 'EXECUTE'
           )
           or has_function_privilege('anon', v_v2.oid, 'EXECUTE')
           or has_function_privilege('authenticated', v_v2.oid, 'EXECUTE')
           or exists (
             select 1 from aclexplode(v_v2.proacl)
             where grantee = 0
           ) then
          raise exception 'reserve V2 is not service-role-only';
        end if;

        v_v1_hash := encode(
          extensions.digest(
            convert_to(
              replace(
                replace(
                  pg_get_functiondef(v_v1.oid),
                  chr(13) || chr(10),
                  chr(10)
                ),
                chr(13),
                chr(10)
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        );
         if v_v1_hash is distinct from '${V1_FUNCTION_DEFINITION_SHA256}' then
           raise exception 'reserve V1 body fingerprint changed' using detail = v_v1_hash;
         end if;
         if v_v1.prosecdef
            or v_v1.proconfig is distinct from array['search_path=""']::text[]
            or not has_function_privilege('service_role', v_v1.oid, 'EXECUTE')
            or has_function_privilege('anon', v_v1.oid, 'EXECUTE')
            or has_function_privilege('authenticated', v_v1.oid, 'EXECUTE') then
           raise exception 'reserve V1 security/grants changed';
         end if;

        if has_table_privilege(
             'service_role',
             'public.ai_service_runtime_contract_versions',
             'SELECT,INSERT,UPDATE,DELETE'
           )
           or has_table_privilege(
             'service_role',
             'public.ai_service_runtime_target_versions',
             'SELECT,INSERT,UPDATE,DELETE'
           )
           or has_table_privilege(
             'service_role',
             'public.ai_service_runtime_contract_targets',
             'SELECT,INSERT,UPDATE,DELETE'
           ) then
          raise exception 'reserve V2 leaked generic runtime catalog authority';
        end if;
      end;
      $$;
    `);
  });

  it("returns one coherent selected candidate and changes only exact-bundle acceptance", async () => {
    const user = await createTestUser(service, "availability-route");
    try {
      const fixture = await createActiveFixture({ label: "availability-route" });
      const expected = await expectedRoute(fixture);

      const beforeAcceptance = await availabilityV1(user.id);
      expect(beforeAcceptance.error).toBeNull();
      expect(beforeAcceptance.data).toEqual({
        enabled: true,
        configGeneration: expected.config_generation,
        routingPolicyVersionId: fixture.policyVersionId,
        profileVersionId: fixture.selectedNode.profileVersionId,
        legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
        runtimeContractId: fixture.runtime.runtimeContractId,
        displayDisclosureKey: fixture.selectedNode.displayDisclosureKey,
        termsAccepted: false,
      });
      await expectNoAdmissionRows(user.id);

      const acceptance = await service.from("user_terms_acceptances").insert({
        user_id: user.id,
        document_key: "ai_terms",
        version: INITIAL_LEGAL_BUNDLE_VERSION,
      });
      expect(acceptance.error).toBeNull();

      const afterAcceptance = await availabilityV1(user.id);
      expect(afterAcceptance.error).toBeNull();
      expect(afterAcceptance.data).toEqual({
        ...beforeAcceptance.data,
        termsAccepted: true,
      });
      await expectNoAdmissionRows(user.id);
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("denies anon/authenticated callers and direct service-role catalog reads", async () => {
    const user = await createTestUser(service, "reserve-v2-grants");
    const authed = await signInAsUser(user);
    const args = {
      p_user_id: user.id,
      p_request_id: crypto.randomUUID(),
      p_client_request_id: crypto.randomUUID(),
      p_expected_route: null,
    };
    try {
      for (const client of [anon, authed]) {
        const denied = await client.rpc("reserve_ai_polish_request_v2", args);
        expect(denied.data).toBeNull();
        expect(denied.error?.code).toBe(PERMISSION_DENIED);
      }
      for (const table of [
        "ai_service_runtime_contract_versions",
        "ai_service_runtime_target_versions",
        "ai_service_runtime_contract_targets",
      ]) {
        const denied = await service.from(table).select("*").limit(1);
        expect(denied.data).toBeNull();
        expect(denied.error?.code).toBe(PERMISSION_DENIED);
      }
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("inserts and returns one authoritative complete snapshot without sealing mutations", async () => {
    const fixture = await createActiveFixture({ label: "success" });
    const user = await createTestUser(service, "reserve-v2-success");
    const expected = await expectedRoute(fixture);
    const rootBefore = runOwnerSql(String.raw`
      select sealed_at::text
      from public.ai_service_runtime_contract_versions
      where runtime_contract_id = '${fixture.runtime.runtimeContractId}';
    `).stdout.trim();
    const { data: priceBefore, error: priceBeforeError } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", fixture.selectedNode.priceVersionId)
      .single();
    expect(priceBeforeError).toBeNull();

    try {
      const startedAt = Date.now();
      const result = await reserveV2(user.id, expected);
      const finishedAt = Date.now();
      expect(result.error).toBeNull();
      const body = result.data as ReserveV2Result;
      expect(body).toMatchObject({ allowed: true, limit: 20, remaining: 19 });
      expect(body.routeSnapshot).toEqual({
        schemaVersion: "route_snapshot_v1",
        configGeneration: expected.config_generation,
        routingPolicyVersionId: fixture.policyVersionId,
        profileVersionId: fixture.selectedNode.profileVersionId,
        priceVersionId: fixture.selectedNode.priceVersionId,
        legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
        runtimeContractId: fixture.runtime.runtimeContractId,
        gatewayKind: fixture.selectedNode.gatewayKind,
        modelId: fixture.selectedNode.modelId,
        wireApiKind: fixture.selectedNode.wireApiKind,
        displayDisclosureKey: fixture.selectedNode.displayDisclosureKey,
      });

      const rows = await getLedgerRows(service, user.id);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        reservation_id: body.reservationId,
        reserved_at: expect.any(String),
        route_schema_version: "route_snapshot_v1",
        config_generation: Number(expected.config_generation),
        routing_policy_version_id: fixture.policyVersionId,
        profile_version_id: fixture.selectedNode.profileVersionId,
        price_version_id: fixture.selectedNode.priceVersionId,
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        runtime_contract_id: fixture.runtime.runtimeContractId,
        gateway_kind: fixture.selectedNode.gatewayKind,
        model_id: fixture.selectedNode.modelId,
        wire_api_kind: fixture.selectedNode.wireApiKind,
        display_disclosure_key: fixture.selectedNode.displayDisclosureKey,
      });
      const reservedAt = new Date(row.reserved_at).getTime();
      expect(reservedAt).toBeGreaterThanOrEqual(startedAt - 1_000);
      expect(reservedAt).toBeLessThanOrEqual(finishedAt + 1_000);
      const expectedMinute = new Date(reservedAt);
      expectedMinute.setUTCSeconds(0, 0);
      const [rateBucket] = await getRateBuckets(service, user.id);
      expect(new Date(rateBucket!.minute_bucket).toISOString()).toBe(
        expectedMinute.toISOString(),
      );
      expect((await getUsageRow(service, user.id))?.day).toBe(
        new Date(reservedAt).toISOString().slice(0, 10),
      );
      const nextUtcDay = new Date(
        `${new Date(reservedAt).toISOString().slice(0, 10)}T00:00:00.000Z`,
      );
      nextUtcDay.setUTCDate(nextUtcDay.getUTCDate() + 1);
      expect(new Date(body.resetAt!).toISOString()).toBe(nextUtcDay.toISOString());

      const rootAfter = runOwnerSql(String.raw`
        select sealed_at::text
        from public.ai_service_runtime_contract_versions
        where runtime_contract_id = '${fixture.runtime.runtimeContractId}';
      `).stdout.trim();
      expect(rootAfter).toBe(rootBefore);
      const { data: priceAfter, error: priceAfterError } = await service
        .from("ai_price_versions")
        .select("components_sealed_at")
        .eq("id", fixture.selectedNode.priceVersionId)
        .single();
      expect(priceAfterError).toBeNull();
      expect(priceAfter?.components_sealed_at).toBe(
        priceBefore?.components_sealed_at,
      );
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("requires the exact route bundle before every admission-side mutation", async () => {
    const fixture = await createActiveFixture({ label: "terms-gate" });
    const expected = await expectedRoute(fixture);
    const missing = await createTestUser(service, "reserve-v2-terms-missing");
    const old = await createTestUser(service, "reserve-v2-terms-old");
    const wrongDocument = await createTestUser(
      service,
      "reserve-v2-terms-wrong-document",
    );
    const wrongUser = await createTestUser(service, "reserve-v2-terms-wrong-user");
    const acceptedOther = await createTestUser(
      service,
      "reserve-v2-terms-accepted-other",
    );
    const users = [missing, old, wrongDocument, wrongUser, acceptedOther];

    try {
      const { error: oldError } = await service.from("user_terms_acceptances").insert({
        user_id: old.id,
        document_key: "ai_terms",
        version: "2026-08-04",
      });
      expect(oldError).toBeNull();
      const { error: wrongDocumentError } = await service
        .from("user_terms_acceptances")
        .insert({
          user_id: wrongDocument.id,
          document_key: "terms",
          version: INITIAL_LEGAL_BUNDLE_VERSION,
        });
      expect(wrongDocumentError).toBeNull();
      await acceptAiLegalBundle(
        service,
        acceptedOther.id,
        INITIAL_LEGAL_BUNDLE_VERSION,
      );

      for (const user of [missing, old, wrongDocument, wrongUser]) {
        const before = exactMutableState(
          users.map(({ id }) => id),
          fixture,
        );
        const result = await reserveV2(user.id, expected, crypto.randomUUID(), {
          acceptTerms: false,
        });
        expect(result.error).toBeNull();
        expect(result.data).toEqual({
          allowed: false,
          reason: "AI_TERMS_REQUIRED",
          message:
            "Acceptance of the current AI terms is required before polishing.",
        });
        expect(exactMutableState(users.map(({ id }) => id), fixture)).toBe(before);
      }

      const staleRoute = {
        ...expected,
        config_generation: String(BigInt(expected.config_generation) + BigInt(1)),
      };
      const beforeStale = exactMutableState(
        users.map(({ id }) => id),
        fixture,
      );
      const stale = await reserveV2(
        missing.id,
        staleRoute,
        crypto.randomUUID(),
        { acceptTerms: false },
      );
      expect(stale.error).toBeNull();
      expect(stale.data).toEqual({
        allowed: false,
        reason: "AI_ROUTE_CHANGED",
        message: "The AI route changed; refresh availability and confirm again.",
      });
      expect(exactMutableState(users.map(({ id }) => id), fixture)).toBe(
        beforeStale,
      );

      await acceptAiLegalBundle(
        service,
        missing.id,
        INITIAL_LEGAL_BUNDLE_VERSION,
      );
      const accepted = await reserveV2(
        missing.id,
        expected,
        crypto.randomUUID(),
        { acceptTerms: false },
      );
      expect(accepted.error).toBeNull();
      expect(accepted.data).toMatchObject({
        allowed: true,
        routeSnapshot: {
          legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
          profileVersionId: fixture.selectedNode.profileVersionId,
          priceVersionId: fixture.selectedNode.priceVersionId,
        },
      });
    } finally {
      for (const user of users) {
        await deleteTestUser(service, user.id);
      }
    }
  });

  it("rejects every malformed expected route before admission mutation", async () => {
    const fixture = await createActiveFixture({ label: "malformed" });
    const user = await createTestUser(service, "reserve-v2-malformed");
    const expected = await expectedRoute(fixture);
    const malformed: unknown[] = [
      null,
      [],
      "expected_route_v1",
      { schema_version: "expected_route_v1" },
      { ...expected, extra: "forbidden" },
      { ...expected, config_generation: null },
      { ...expected, config_generation: 1 },
      { ...expected, config_generation: "01" },
      {
        ...expected,
        profile_version_id: expected.profile_version_id.toUpperCase(),
      },
      Object.fromEntries(
        Object.entries(expected).filter(([key]) => key !== "runtime_contract_id"),
      ),
    ];

    try {
      for (const value of malformed) {
        const result = await reserveV2(user.id, value);
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({
          allowed: false,
          reason: "AI_ROUTE_CHANGED",
        });
      }
      await expectNoAdmissionRows(user.id);
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("handles bigint generation boundaries without cast errors or mutation", async () => {
    const fixture = await createActiveFixture({ label: "generation-boundary" });
    const user = await createTestUser(service, "reserve-v2-generation-boundary");
    const expected = await expectedRoute(fixture);
    try {
      for (const configGeneration of [
        "9223372036854775807",
        "9223372036854775808",
        "9999999999999999999",
        "9".repeat(10_000),
      ]) {
        const result = await reserveV2(user.id, {
          ...expected,
          config_generation: configGeneration,
        });
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({
          allowed: false,
          reason: "AI_ROUTE_CHANGED",
        });
      }
      await expectNoAdmissionRows(user.id);
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("fails closed on NULL server identities before admission mutation", async () => {
    const fixture = await createActiveFixture({ label: "null-identities" });
    const user = await createTestUser(service, "reserve-v2-null-identities");
    const expected = await expectedRoute(fixture);
    try {
      for (const args of [
        {
          p_user_id: null,
          p_request_id: crypto.randomUUID(),
          p_client_request_id: crypto.randomUUID(),
        },
        {
          p_user_id: user.id,
          p_request_id: null,
          p_client_request_id: crypto.randomUUID(),
        },
        {
          p_user_id: user.id,
          p_request_id: crypto.randomUUID(),
          p_client_request_id: null,
        },
      ]) {
        const result = await service.rpc("reserve_ai_polish_request_v2", {
          ...args,
          p_expected_route: expected,
        });
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({
          allowed: false,
          reason: "SERVICE_UNAVAILABLE",
        });
      }
      await expectNoAdmissionRows(user.id);
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("rejects every route equality mismatch before admission mutation", async () => {
    const fixture = await createActiveFixture({ label: "mismatch" });
    const user = await createTestUser(service, "reserve-v2-mismatch");
    const expected = await expectedRoute(fixture);
    const mismatches: ExpectedRoute[] = [
      {
        ...expected,
        config_generation: String(BigInt(expected.config_generation) + BigInt(1)),
      },
      { ...expected, profile_version_id: crypto.randomUUID() },
      { ...expected, legal_bundle_version: "other-legal-v1" },
      { ...expected, runtime_contract_id: "other-runtime-v1" },
    ];

    try {
      for (const value of mismatches) {
        const result = await reserveV2(user.id, value);
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({
          allowed: false,
          reason: "AI_ROUTE_CHANGED",
        });
      }
      await expectNoAdmissionRows(user.id);
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("evaluates stale route assertions before reserved/finalized dedup", async () => {
    const fixture = await createActiveFixture({ label: "route-before-dedup" });
    const user = await createTestUser(service, "reserve-v2-route-before-dedup");
    const expected = await expectedRoute(fixture);
    const staleExpected = {
      ...expected,
      config_generation: String(BigInt(expected.config_generation) + BigInt(1)),
    };
    const clientRequestId = crypto.randomUUID();
    try {
      const reserved = await reserveV2(user.id, expected, clientRequestId);
      expect(reserved.error).toBeNull();
      expect(reserved.data).toMatchObject({ allowed: true });

      const reservedState = {
        usage: await getUsageRow(service, user.id),
        rate: await getRateBuckets(service, user.id),
        ledger: await getLedgerRows(service, user.id),
      };
      const staleWhileReserved = await reserveV2(
        user.id,
        staleExpected,
        clientRequestId,
      );
      expect(staleWhileReserved.error).toBeNull();
      expect(staleWhileReserved.data).toMatchObject({
        allowed: false,
        reason: "AI_ROUTE_CHANGED",
      });
      expect({
        usage: await getUsageRow(service, user.id),
        rate: await getRateBuckets(service, user.id),
        ledger: await getLedgerRows(service, user.id),
      }).toEqual(reservedState);
      expect((await reserveV2(user.id, expected, clientRequestId)).data).toMatchObject({
        allowed: false,
        reason: "REQUEST_IN_PROGRESS",
      });

      const finalized = await service.rpc("finalize_ai_polish_request", {
        p_reservation_id: (reserved.data as ReserveV2Result).reservationId,
        p_status: "released",
        p_quota_charged: false,
        p_provider_billable: false,
        p_usage: null,
        p_metadata: null,
        p_settlement_contract: "durable_cancellation_sequence_v1",
      });
      expect(finalized.error).toBeNull();
      expect(finalized.data).toMatchObject({ ok: true });
      const finalizedState = {
        usage: await getUsageRow(service, user.id),
        rate: await getRateBuckets(service, user.id),
        ledger: await getLedgerRows(service, user.id),
      };
      const staleWhileFinalized = await reserveV2(
        user.id,
        staleExpected,
        clientRequestId,
      );
      expect(staleWhileFinalized.error).toBeNull();
      expect(staleWhileFinalized.data).toMatchObject({
        allowed: false,
        reason: "AI_ROUTE_CHANGED",
      });
      expect({
        usage: await getUsageRow(service, user.id),
        rate: await getRateBuckets(service, user.id),
        ledger: await getLedgerRows(service, user.id),
      }).toEqual(finalizedState);
      expect((await reserveV2(user.id, expected, clientRequestId)).data).toMatchObject({
        allowed: false,
        reason: "DUPLICATE_REQUEST",
      });
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("preserves V1 NULL-route compatibility and core V2 denial semantics", async () => {
    const fixture = await createActiveFixture({ label: "compat-denials" });
    const v1User = await createTestUser(service, "reserve-v1-compat");
    const v2User = await createTestUser(service, "reserve-v2-denials");
    const expected = await expectedRoute(fixture);
    try {
      const v1 = await service.rpc("reserve_ai_polish_request", {
        p_user_id: v1User.id,
        p_request_id: crypto.randomUUID(),
        p_client_request_id: crypto.randomUUID(),
      });
      expect(v1.error).toBeNull();
      expect(v1.data).toMatchObject({ allowed: true });
      const [v1Row] = await getLedgerRows(service, v1User.id);
      expect(v1Row).toMatchObject({
        route_schema_version: null,
        runtime_contract_id: null,
      });

      await configureFeature(service, { enabled: false });
      expect((await reserveV2(v2User.id, expected)).data).toMatchObject({
        allowed: false,
        reason: "AI_DISABLED",
      });
      await configureFeature(service, { enabled: true });

      await setDailyUsageCount(service, v2User.id, 20);
      expect((await reserveV2(v2User.id, expected)).data).toMatchObject({
        allowed: false,
        reason: "QUOTA_EXCEEDED",
        remaining: 0,
      });
      await setDailyUsageCount(service, v2User.id, 0);

      await setCurrentRateBucketCount(service, v2User.id, 3);
      expect((await reserveV2(v2User.id, expected)).data).toMatchObject({
        allowed: false,
        reason: "RATE_LIMITED",
      });
      await service
        .from("ai_rate_minutes")
        .delete()
        .eq("user_id", v2User.id);

      const clientRequestId = crypto.randomUUID();
      const first = await reserveV2(v2User.id, expected, clientRequestId);
      expect(first.data).toMatchObject({ allowed: true });
      expect((await reserveV2(v2User.id, expected, clientRequestId)).data).toMatchObject({
        allowed: false,
        reason: "REQUEST_IN_PROGRESS",
      });
      const finalized = await service.rpc("finalize_ai_polish_request", {
        p_reservation_id: (first.data as ReserveV2Result).reservationId,
        p_status: "released",
        p_quota_charged: false,
        p_provider_billable: false,
        p_usage: null,
        p_metadata: null,
        p_settlement_contract: "durable_cancellation_sequence_v1",
      });
      expect(finalized.error).toBeNull();
      expect(finalized.data).toMatchObject({ ok: true });
      expect((await reserveV2(v2User.id, expected, clientRequestId)).data).toMatchObject({
        allowed: false,
        reason: "DUPLICATE_REQUEST",
      });
    } finally {
      await deleteTestUser(service, v1User.id);
      await deleteTestUser(service, v2User.id);
    }
  });

  it("selects Asia/Shanghai windows with half-open boundary semantics", async () => {
    await settleAwayFromMinuteBoundary(10_000);
    const matching = await createActiveFixture({
      label: "window-match",
      window: "matches-alternate",
    });
    const matchingUser = await createTestUser(service, "reserve-v2-window-match");
    try {
      const result = await reserveV2(
        matchingUser.id,
        await expectedRoute(matching),
      );
      expect(result.error).toBeNull();
      expect((result.data as ReserveV2Result).routeSnapshot).toMatchObject({
        profileVersionId: matching.selectedNode.profileVersionId,
        priceVersionId: matching.selectedNode.priceVersionId,
        gatewayKind: "direct_mimo",
      });
    } finally {
      await deleteTestUser(service, matchingUser.id);
    }

    await settleAwayFromMinuteBoundary(10_000);
    const atExclusiveEnd = await createActiveFixture({
      label: "window-exclusive-end",
      window: "ends-at-current-minute",
    });
    const boundaryUser = await createTestUser(service, "reserve-v2-window-end");
    try {
      const result = await reserveV2(
        boundaryUser.id,
        await expectedRoute(atExclusiveEnd),
      );
      expect(result.error).toBeNull();
      expect((result.data as ReserveV2Result).routeSnapshot).toMatchObject({
        profileVersionId: atExclusiveEnd.defaultNode.profileVersionId,
        priceVersionId: atExclusiveEnd.defaultNode.priceVersionId,
        gatewayKind: "direct_deepseek",
      });
    } finally {
      await deleteTestUser(service, boundaryUser.id);
    }
  });

  it("keeps one profile with distinct default/peak prices exact", async () => {
    await settleAwayFromMinuteBoundary(10_000);
    const fixture = await createActiveFixture({
      label: "same-profile-prices",
      window: "same-profile-price",
    });
    const user = await createTestUser(service, "reserve-v2-same-profile-prices");
    try {
      expect(fixture.selectedNode.profileVersionId).toBe(
        fixture.defaultNode.profileVersionId,
      );
      expect(fixture.selectedNode.priceVersionId).not.toBe(
        fixture.defaultNode.priceVersionId,
      );
      const result = await reserveV2(user.id, await expectedRoute(fixture));
      expect(result.error).toBeNull();
      expect((result.data as ReserveV2Result).routeSnapshot).toMatchObject({
        profileVersionId: fixture.defaultNode.profileVersionId,
        priceVersionId: fixture.selectedNode.priceVersionId,
      });
      expect((await getLedgerRows(service, user.id))[0]).toMatchObject({
        profile_version_id: fixture.defaultNode.profileVersionId,
        price_version_id: fixture.selectedNode.priceVersionId,
      });
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("maps unavailable current-route facts to generic SERVICE_UNAVAILABLE", async () => {
    const fixture = await createActiveFixture({ label: "invalid-current" });
    const user = await createTestUser(service, "reserve-v2-unavailable");
    const target = fixture.runtime.targets.find(
      ({ profileKey }) => profileKey === fixture.defaultNode.profileKey,
    )!;

    async function assertUnavailable(
      corruptSql: string,
      restoreSql: string,
    ): Promise<void> {
      const expected = await expectedRoute(fixture);
      ownerReplica(corruptSql);
      try {
        const result = await reserveV2(user.id, expected);
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({
          allowed: false,
          reason: "SERVICE_UNAVAILABLE",
        });
      } finally {
        ownerReplica(restoreSql);
      }
    }

    try {
      const expectedBeforeClear = await expectedRoute(fixture);
      const runtimeRoot = readLifecycleEvidenceRoot({
        runtimeContractId: fixture.runtime.runtimeContractId,
        priceVersionIds: [
          ...new Set([
            fixture.defaultNode.priceVersionId,
            fixture.selectedNode.priceVersionId,
          ]),
        ],
      });
      const lifecycleEvidence = {
        p_runtime_contract_id: fixture.runtime.runtimeContractId,
        p_actor: "reserve-v2-test",
        p_reason: `test pointer lifecycle ${crypto.randomUUID()}`,
        p_reviewed_source_commit_oid: runtimeRoot.reviewedSourceCommitOid,
        p_reviewed_source_sha256: runtimeRoot.reviewedSourceSha256,
        p_rechecked_at: runtimeRoot.recheckedAt,
        p_rechecked_sha256: runtimeRoot.reviewedSourceSha256,
      };

      ownerReplica("delete from public.ai_feature_config where id = true;");
      try {
        expect((await reserveV2(user.id, expectedBeforeClear)).data).toMatchObject({
          allowed: false,
          reason: "SERVICE_UNAVAILABLE",
        });
      } finally {
        ownerReplica(String.raw`
          insert into public.ai_feature_config (
            id, ai_polish_enabled, global_daily_limit,
            enabled_user_allowlist, active_routing_policy_version_id,
            config_generation, routing_updated_at, routing_updated_by,
            routing_change_reason
          ) values (
            true, true, 2000, '{}'::uuid[],
            '${fixture.policyVersionId}'::uuid,
            ${expectedBeforeClear.config_generation}::bigint,
            clock_timestamp(), 'reserve-v2-test', 'restore missing singleton'
          );
        `);
      }

      await assertUnavailable(
        `update public.ai_feature_config
         set active_routing_policy_version_id = '${crypto.randomUUID()}'::uuid
         where id = true;`,
        `update public.ai_feature_config
         set active_routing_policy_version_id = '${fixture.policyVersionId}'::uuid
         where id = true;`,
      );

      const cleared = await service.rpc("clear_ai_routing_policy_pointer_v1", {
        p_expected_policy_version_id: fixture.policyVersionId,
        ...lifecycleEvidence,
      });
      expect(cleared.error).toBeNull();
      expect((await reserveV2(user.id, expectedBeforeClear)).data).toMatchObject({
        allowed: false,
        reason: "SERVICE_UNAVAILABLE",
      });
      const restored = await service.rpc("set_ai_routing_policy_pointer_v1", {
        p_policy_version_id: fixture.policyVersionId,
        ...lifecycleEvidence,
        p_reason: `restore test pointer ${crypto.randomUUID()}`,
      });
      expect(restored.error).toBeNull();

      await assertUnavailable(
        `update public.ai_routing_policy_versions set status = 'draft'
         where id = '${fixture.policyVersionId}';`,
        `update public.ai_routing_policy_versions set status = 'canary'
         where id = '${fixture.policyVersionId}';`,
      );
      await assertUnavailable(
        `update public.ai_service_runtime_contract_versions set sealed_at = null
         where runtime_contract_id = '${fixture.runtime.runtimeContractId}';`,
        `update public.ai_service_runtime_contract_versions
         set sealed_at = greatest(created_at, clock_timestamp())
         where runtime_contract_id = '${fixture.runtime.runtimeContractId}';`,
      );
      await assertUnavailable(
        `update public.ai_routing_policy_versions
         set legal_bundle_version = 'other-legal-v1'
         where id = '${fixture.policyVersionId}';`,
        `update public.ai_routing_policy_versions
         set legal_bundle_version = '${INITIAL_LEGAL_BUNDLE_VERSION}'
         where id = '${fixture.policyVersionId}';`,
      );
      await assertUnavailable(
        `update public.ai_provider_profile_versions
         set legal_manifest_id = '${MIMO_LEGAL_MANIFEST_ID}'
         where id = '${fixture.defaultNode.profileVersionId}';`,
        `update public.ai_provider_profile_versions
         set legal_manifest_id = '${DEEPSEEK_LEGAL_MANIFEST_ID}'
         where id = '${fixture.defaultNode.profileVersionId}';`,
      );
      await assertUnavailable(
        `delete from public.ai_service_runtime_contract_targets
         where runtime_contract_id = '${fixture.runtime.runtimeContractId}'
           and runtime_target_id = '${target.runtimeTargetId}';`,
        `insert into public.ai_service_runtime_contract_targets (
           runtime_contract_id,
           runtime_target_id, runtime_target_sha256, profile_key,
           legal_manifest_id, manifest_sha256,
           route_descriptor_id, route_descriptor_sha256
         ) values (
           '${fixture.runtime.runtimeContractId}',
           '${target.runtimeTargetId}', '${target.runtimeTargetSha256}',
           '${target.profileKey}', '${target.legalManifestId}',
           '${target.manifestSha256}', '${target.routeDescriptorId}',
           '${target.routeDescriptorSha256}'
         );`,
      );
      await assertUnavailable(
        `update public.ai_price_versions
         set valid_to = greatest(valid_from + interval '1 second', clock_timestamp() - interval '1 second')
         where id = '${fixture.defaultNode.priceVersionId}';`,
        `update public.ai_price_versions set valid_to = null
         where id = '${fixture.defaultNode.priceVersionId}';`,
      );
      await assertUnavailable(
        `update public.ai_provider_profile_versions
         set status = 'retired', retired_at = greatest(created_at, clock_timestamp())
         where id = '${fixture.defaultNode.profileVersionId}';`,
        `update public.ai_provider_profile_versions
         set status = 'canary', retired_at = null
         where id = '${fixture.defaultNode.profileVersionId}';`,
      );
      await assertUnavailable(
        `update public.ai_provider_profile_versions
         set display_disclosure_key = null
         where id = '${fixture.defaultNode.profileVersionId}';`,
        `update public.ai_provider_profile_versions
         set display_disclosure_key = '${fixture.defaultNode.displayDisclosureKey}'
         where id = '${fixture.defaultNode.profileVersionId}';`,
      );
      await assertUnavailable(
        `update public.ai_routing_policy_versions
         set rules = jsonb_set(
           rules,
           '{defaultRoute,priceVersionId}',
           to_jsonb('${crypto.randomUUID()}'::text)
         )
         where id = '${fixture.policyVersionId}';`,
        `update public.ai_routing_policy_versions
         set rules = jsonb_set(
           rules,
           '{defaultRoute,priceVersionId}',
           to_jsonb('${fixture.defaultNode.priceVersionId}'::text)
         )
         where id = '${fixture.policyVersionId}';`,
      );
      await expectNoAdmissionRows(user.id);
    } finally {
      await deleteTestUser(service, user.id);
    }
  });

  it("serializes duplicate admission but lets independent users share route locks", async () => {
    const fixture = await createActiveFixture({ label: "parallel" });
    const firstUser = await createTestUser(service, "reserve-v2-parallel-a");
    const secondUser = await createTestUser(service, "reserve-v2-parallel-b");
    const expected = await expectedRoute(fixture);
    try {
      const sharedClientRequestId = crypto.randomUUID();
      const duplicatePair = await Promise.all([
        reserveV2(firstUser.id, expected, sharedClientRequestId),
        reserveV2(firstUser.id, expected, sharedClientRequestId),
      ]);
      expect(duplicatePair.every(({ error }) => error === null)).toBe(true);
      expect(
        duplicatePair.map(({ data }) => (data as ReserveV2Result).allowed).sort(),
      ).toEqual([false, true]);
      expect(
        duplicatePair.find(({ data }) => !(data as ReserveV2Result).allowed)?.data,
      ).toMatchObject({ reason: "REQUEST_IN_PROGRESS" });
      expect((await getUsageRow(service, firstUser.id))?.request_count).toBe(1);
      expect(await getLedgerRows(service, firstUser.id)).toHaveLength(1);

      const independent = await Promise.all([
        reserveV2(firstUser.id, expected),
        reserveV2(secondUser.id, expected),
      ]);
      for (const result of independent) {
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({ allowed: true });
      }
    } finally {
      await deleteTestUser(service, firstUser.id);
      await deleteTestUser(service, secondUser.id);
    }
  });
});
