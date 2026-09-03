import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  completePayload,
  SettlementHarness,
  type SettlementReservation,
} from "./provider-attempt-settlement-fixtures";
import { runOwnerSql } from "./runtime-contract-fixtures";

const profileVersionId = crypto.randomUUID();
const priceVersionId = crypto.randomUUID();
const fixtureVersion =
  1_000_000 + (Number.parseInt(profileVersionId.slice(0, 8), 16) % 1_000_000_000);
const modelId = "synthetic-compatible-model";
const endpoint = "https://api.deepseek.com/chat/completions";
const credentialEnvName = "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY";
const runtimeBuildId = "local-test-build";
const bindingRevision = "local-binding-v1";

describe.skipIf(!RUN_DB_TESTS)("provider execution v2 lifecycle", () => {
  let service: SupabaseClient;
  let harness: SettlementHarness;
  let reservation: SettlementReservation;
  let userId: string;

  beforeAll(async () => {
    service = createServiceClient();
    harness = new SettlementHarness(service);
    await harness.setup();
    const user = await harness.makeUser("provider-execution-v2");
    userId = user.id;
    reservation = await harness.reserveV2(user);

    const result = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local session_replication_role = replica;

      insert into public.ai_provider_profile_versions
      select (jsonb_populate_record(
        null::public.ai_provider_profile_versions,
        to_jsonb(source_version) || jsonb_build_object(
          'id', '${profileVersionId}',
          'version', ${fixtureVersion},
          'status', 'active',
          'execution_schema_version', 'profile_execution_config_v2',
          'credential_alias', null,
          'endpoint_alias', null,
          'endpoint_url', '${endpoint}',
          'credential_env_name', '${credentialEnvName}',
          'model_id', '${modelId}',
          'validated_at', clock_timestamp(),
          'activated_at', clock_timestamp(),
          'retired_at', null
        )
      )).*
      from public.ai_provider_profile_versions as source_version
      join public.ai_provider_profiles as profile on profile.id = source_version.profile_id
      where profile.profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
      order by source_version.version
      limit 1;

      insert into public.ai_price_versions
      select (jsonb_populate_record(
        null::public.ai_price_versions,
        to_jsonb(price) || jsonb_build_object(
          'id', '${priceVersionId}',
          'profile_version_id', '${profileVersionId}',
          'version', ${fixtureVersion}
        )
      )).*
      from public.ai_price_versions as price
      where price.id = '${harness.fixture.priceVersionId}';

      insert into public.ai_price_components(price_version_id, component, nanos_per_million)
      select '${priceVersionId}', component, nanos_per_million
      from public.ai_price_components
      where price_version_id = '${harness.fixture.priceVersionId}';

      update public.ai_request_ledger
      set profile_version_id = '${profileVersionId}',
          price_version_id = '${priceVersionId}',
          model_id = '${modelId}',
          display_disclosure_key = 'deepseek-official-v1'
      where reservation_id = '${reservation.reservationId}';
      commit;
    `);
    expect(result.status).toBe(0);
    reservation = {
      ...reservation,
      routeSnapshot: {
        ...reservation.routeSnapshot,
        profileVersionId,
        priceVersionId,
        modelId,
        displayDisclosureKey: "deepseek-official-v1",
      },
    };
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("reads, admits, completes and settles one frozen v2 execution", async () => {
    const snapshot = await service.rpc("get_ai_polish_execution_snapshot_v2", {
      p_reservation_id: reservation.reservationId,
      p_user_id: userId,
    });
    expect(snapshot.error).toBeNull();
    expect(snapshot.data, JSON.stringify(snapshot.data)).toMatchObject({
      schemaVersion: "ai_polish_execution_snapshot_v2",
      ok: true,
      reservationId: reservation.reservationId,
      profileExecutionConfig: {
        schemaVersion: "profile_execution_config_v2",
        providerId: "706513a5-462b-4bba-93b0-53e50661416e",
        endpointUrl: endpoint,
        credentialEnvName,
        modelId,
      },
    });

    const start = await service.rpc("start_ai_polish_provider_attempt_v2", {
      p_reservation_id: reservation.reservationId,
      p_attempt_no: 1,
      p_runtime_build_id: runtimeBuildId,
      p_binding_manifest_revision: bindingRevision,
    });
    expect(start.error).toBeNull();
    expect(start.data).toMatchObject({
      ok: true,
      attemptNo: 1,
      alreadyStarted: false,
      status: "started",
    });

    const replayMismatch = await service.rpc(
      "start_ai_polish_provider_attempt_v2",
      {
        p_reservation_id: reservation.reservationId,
        p_attempt_no: 1,
        p_runtime_build_id: "different-build",
        p_binding_manifest_revision: bindingRevision,
      },
    );
    expect(replayMismatch.error).toBeNull();
    expect(replayMismatch.data).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });

    const attempt = await service
      .from("ai_provider_attempt_ledger")
      .select(
        "execution_schema_version,endpoint_url,credential_env_name,runtime_build_id,binding_manifest_revision",
      )
      .eq("attempt_id", start.data.attemptId)
      .single();
    expect(attempt.error).toBeNull();
    expect(attempt.data).toEqual({
      execution_schema_version: "profile_execution_config_v2",
      endpoint_url: endpoint,
      credential_env_name: credentialEnvName,
      runtime_build_id: runtimeBuildId,
      binding_manifest_revision: bindingRevision,
    });

    const completed = await harness.complete(
      completePayload(start.data.attemptId as string, {
        p_route: {
          schema_version: "route_observation_v1",
          gateway_request_id: null,
          provider_request_id: null,
          actual_upstream_endpoint: null,
          actual_model_id: modelId,
          router_attempt_count: 1,
        },
      }),
    );
    expect(completed).toMatchObject({ ok: true, status: "succeeded" });
    const finalized = await harness.finalize(reservation.reservationId);
    expect(finalized).toMatchObject({ ok: true, status: "succeeded" });
  });
});
