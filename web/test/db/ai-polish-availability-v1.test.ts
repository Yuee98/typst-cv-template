import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configureFeature,
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
const DISABLED = {
  enabled: false,
  configGeneration: null,
  routingPolicyVersionId: null,
  profileVersionId: null,
  legalBundleVersion: null,
  runtimeContractId: null,
  runtimeContractSha256: null,
  displayDisclosureKey: null,
  termsAccepted: false,
} as const;

const OBSERVED_TABLES = [
  "ai_feature_config",
  "ai_routing_policy_versions",
  "ai_request_ledger",
  "ai_provider_attempt_ledger",
  "ai_usage_daily",
  "ai_global_usage_daily",
  "ai_profile_usage_daily",
  "ai_rate_minutes",
  "user_terms_acceptances",
] as const;

async function databaseSnapshot(service: SupabaseClient) {
  const result: Record<string, unknown> = {};
  for (const table of OBSERVED_TABLES) {
    const { data, error } = await service.from(table).select("*");
    expect(error).toBeNull();
    result[table] = data;
  }
  return result;
}

describe.skipIf(!RUN_DB_TESTS)("AI polish availability V1 (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let authenticated: SupabaseClient;
  let user: TestUser;

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    user = await createTestUser(service, "availability-v1");
    authenticated = await signInAsUser(user);
    await configureFeature(service, {
      enabled: false,
      globalDailyLimit: 2000,
      allowlist: [],
    });
  });

  afterAll(async () => {
    await configureFeature(service, {
      enabled: false,
      globalDailyLimit: 2000,
      allowlist: [],
    });
    await deleteTestUser(service, user.id);
  });

  it("freezes the exact same-owner definer catalog and execute matrix", () => {
    runOwnerSql(String.raw`
      do $catalog$
      declare
        v_availability pg_catalog.pg_proc%rowtype;
        v_reserve pg_catalog.pg_proc%rowtype;
        v_owner_name text;
        v_count integer;
      begin
        select count(*) into v_count
        from pg_catalog.pg_proc as procedure
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = 'get_ai_polish_availability_v1';

        if v_count <> 1 then
          raise exception 'availability overload count drifted: %', v_count;
        end if;

        select procedure.* into strict v_availability
        from pg_catalog.pg_proc as procedure
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = 'get_ai_polish_availability_v1'
          and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'p_user_id uuid';

        select procedure.* into strict v_reserve
        from pg_catalog.pg_proc as procedure
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = 'reserve_ai_polish_request_v2';

        select role.rolname into strict v_owner_name
        from pg_catalog.pg_roles as role
        where role.oid = v_availability.proowner;

        if v_availability.prorettype <> 'jsonb'::pg_catalog.regtype
           or not v_availability.prosecdef
           or v_availability.provolatile <> 'v'
           or v_availability.proconfig is distinct from array['search_path=""']::text[]
           or v_availability.proowner is distinct from v_reserve.proowner
           or v_owner_name in ('service_role', 'anon', 'authenticated', 'authenticator')
           or pg_catalog.pg_has_role('service_role', v_availability.proowner, 'SET') then
          raise exception 'availability catalog contract drifted';
        end if;

        if not pg_catalog.has_function_privilege(
             'service_role', v_availability.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_availability.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_availability.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('public', v_availability.oid, 'EXECUTE') then
          raise exception 'availability execute matrix drifted';
        end if;
      end;
      $catalog$;
    `);
  });

  it("denies API roles before validation", async () => {
    const args = { p_user_id: user.id };
    const anonymous = await anon.rpc("get_ai_polish_availability_v1", args);
    expect(anonymous.data).toBeNull();
    expect(anonymous.error?.code).toBe(PERMISSION_DENIED);

    const signedIn = await authenticated.rpc("get_ai_polish_availability_v1", args);
    expect(signedIn.data).toBeNull();
    expect(signedIn.error?.code).toBe(PERMISSION_DENIED);
  });

  it("collapses null, nonexistent, and disabled users to one exact zero-DML object", async () => {
    const before = await databaseSnapshot(service);
    const inputs = [null, crypto.randomUUID(), user.id];

    for (const userId of inputs) {
      const { data, error } = await service.rpc("get_ai_polish_availability_v1", {
        p_user_id: userId,
      });
      expect(error).toBeNull();
      expect(data).toEqual(DISABLED);
      expect(Object.keys(data as Record<string, unknown>).sort()).toEqual(
        Object.keys(DISABLED).sort(),
      );
    }

    expect(await databaseSnapshot(service)).toEqual(before);
  });
});
