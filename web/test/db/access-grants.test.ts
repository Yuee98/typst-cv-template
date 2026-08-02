/**
 * Real-DB privilege tests (unit 1.4, plan card 1.4): the five AI polish
 * tables and six RPCs must be service_role only.
 *
 * The migration revokes all privileges from public/anon/authenticated and
 * enables RLS with no policies, so every direct table read/write and every
 * RPC call from an end-user role must fail with a Postgres permission error
 * (42501). The service role keeps full access — the API server uses it for
 * quota accounting, so a working service_role path is asserted too.
 */

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

const AI_TABLES = [
  "ai_feature_config",
  "ai_request_ledger",
  "ai_usage_daily",
  "ai_rate_minutes",
  "ai_global_usage_daily",
] as const;

const PERMISSION_DENIED = "42501";

describe.skipIf(!RUN_DB_TESTS)("service_role-only grants (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let authed: SupabaseClient;
  let user: TestUser;

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    user = await createTestUser(service, "grants");
    authed = await signInAsUser(user);
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  // Static probe args: permission checks precede any validation, so the
  // values never need to reference real rows (and it.each computes its data
  // at collection time, before beforeAll has created the test user).
  const SOME_UUID = "00000000-0000-4000-8000-000000000000";

  function rpcProbes() {
    return [
      ["reserve_ai_polish_request", {
        p_user_id: SOME_UUID,
        p_request_id: crypto.randomUUID(),
        p_client_request_id: crypto.randomUUID(),
      }],
      ["mark_ai_polish_provider_started", {
        p_reservation_id: crypto.randomUUID(),
        p_provider_request_id: null,
      }],
      ["finalize_ai_polish_request", {
        p_reservation_id: crypto.randomUUID(),
        p_status: "succeeded",
        p_quota_charged: true,
        p_provider_billable: null,
        p_usage: null,
        p_metadata: null,
      }],
      ["reconcile_stale_ai_polish_reservations", {}],
      ["cleanup_ai_polish_metadata", {}],
      ["get_ai_polish_quota", { p_user_id: SOME_UUID }],
    ] as const;
  }

  describe.each([
    ["anon", () => anon],
    ["authenticated", () => authed],
  ] as const)("%s role is fully denied", (_label, getClient) => {
    it.each(AI_TABLES)("cannot SELECT %s", async (table) => {
      const { data, error } = await getClient()
        .from(table)
        .select("*")
        .limit(1);
      expect(data).toBeNull();
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it.each(AI_TABLES)("cannot INSERT into %s", async (table) => {
      const { error } = await getClient()
        .from(table)
        .insert({});
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it("cannot DELETE from ai_request_ledger", async () => {
      // A filter on the real pk keeps this a privilege check (no row ever
      // matches); Postgres denies before evaluating anything.
      const { error } = await getClient()
        .from("ai_request_ledger")
        .delete()
        .eq("reservation_id", crypto.randomUUID());
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it.each(rpcProbes())("cannot EXECUTE %s", async (fn, args) => {
      const { data, error } = await getClient().rpc(fn, args);
      expect(data).toBeNull();
      expect(error?.code).toBe(PERMISSION_DENIED);
    });
  });

  it("authenticated sanity: the signed-in client really is authenticated", async () => {
    // Executable by authenticated (granted in the terms migrations) and
    // auth.uid()-dependent: proves the JWT is honored, so the 42501 probes
    // above exercise the authenticated role — not a broken anon session.
    const { data, error } = await authed.rpc("has_accepted_current_terms");
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("service_role can read all five tables", async () => {
    for (const table of AI_TABLES) {
      const { error } = await service.from(table).select("*").limit(1);
      expect(error).toBeNull();
    }
  });

  it("service_role can execute the read RPC", async () => {
    const { data, error } = await service.rpc("get_ai_polish_quota", {
      p_user_id: user.id,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ limit: 20, remaining: 20 });
  });
});
