import type { SupabaseClient } from "@supabase/supabase-js";
import { expect } from "vitest";

import {
  acceptAiLegalBundle,
  configureFeature,
  createTestUser,
  deleteTestUser,
  FEATURE_CONFIG_DEFAULTS,
  type TestUser,
} from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  MIMO_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_MANIFEST_SHA256,
  readLifecycleEvidenceRoot,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
} from "./runtime-contract-fixtures";

export const LARGE_GLOBAL_LIMIT = 2_000_000;

export interface SettlementRouteSnapshot {
  schemaVersion: "route_snapshot_v1";
  configGeneration: string;
  routingPolicyVersionId: string;
  profileVersionId: string;
  priceVersionId: string;
  legalBundleVersion: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  gatewayKind: "direct_deepseek" | "direct_mimo";
  modelId: string;
  wireApiKind: "chat_completions_v1" | "responses_v1";
  displayDisclosureKey: string;
}

export type SettlementProviderKind = "deepseek" | "mimo";

export interface SettlementRouteFixture {
  profileId: string;
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  modelId: string;
  displayDisclosureKey: string;
}

export interface SettlementReservation {
  reservationId: string;
  routeSnapshot: SettlementRouteSnapshot;
}

export interface SettlementAttempt {
  attemptId: string;
  attemptNo: number;
}

export interface CompletePayload {
  p_attempt_id: string;
  p_status: string;
  p_transmitted: boolean;
  p_retry_eligible: boolean;
  p_provider_billable: boolean | null;
  p_usage: unknown;
  p_route: unknown;
  p_cost: unknown;
  p_metadata: unknown;
}

export function observedUsage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "normalized_usage_v2",
    input_total_tokens: 100,
    input_cache_read_tokens: 60,
    input_cache_write_tokens: 10,
    input_standard_tokens: 30,
    output_tokens: 20,
    reasoning_tokens: 5,
    cache_usage_reporting: "reported",
    usage_complete: true,
    ...overrides,
  };
}

export function routeObservation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "route_observation_v1",
    gateway_request_id: null,
    provider_request_id: null,
    actual_upstream_endpoint: null,
    actual_model_id: null,
    router_attempt_count: null,
    ...overrides,
  };
}

export function costObservation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "cost_observation_v1",
    estimated_currency: "CNY",
    estimated_cost_nanos: "1234",
    provider_reported_currency: null,
    provider_reported_cost_nanos: null,
    reconciliation_status: "not_available",
    ...overrides,
  };
}

export function attemptMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "attempt_metadata_v1",
    finish_reason: "stop",
    failure_stage: null,
    latency_ms: 1234,
    ...overrides,
  };
}

export function completePayload(
  attemptId: string,
  overrides: Partial<CompletePayload> = {},
): CompletePayload {
  return {
    p_attempt_id: attemptId,
    p_status: "succeeded",
    p_transmitted: true,
    p_retry_eligible: false,
    p_provider_billable: true,
    p_usage: observedUsage(),
    p_route: routeObservation(),
    p_cost: costObservation(),
    p_metadata: attemptMetadata(),
    ...overrides,
  };
}

export class SettlementHarness {
  readonly users: TestUser[] = [];
  fixture!: SettlementRouteFixture;

  constructor(readonly service: SupabaseClient) {}

  async setup(): Promise<void> {
    await this.activateFreshRouteFixture();
    await configureFeature(this.service, {
      enabled: true,
      globalDailyLimit: LARGE_GLOBAL_LIMIT,
      allowlist: [],
    });
  }

  async activateFreshRouteFixture(
    provider: SettlementProviderKind = "deepseek",
  ): Promise<SettlementRouteFixture> {
    this.fixture = await this.createActiveRouteFixture(provider);
    return this.fixture;
  }

  async resetFeature(): Promise<void> {
    await configureFeature(this.service, {
      enabled: true,
      globalDailyLimit: LARGE_GLOBAL_LIMIT,
      allowlist: [],
    });
  }

  private lifecycleEvidence(
    fixture: SettlementRouteFixture,
    reason: string,
  ): Record<string, string> {
    const root = readLifecycleEvidenceRoot({
      runtimeContractId: fixture.runtimeContractId,
      runtimeContractSha256: fixture.runtimeContractSha256,
      priceVersionIds: [fixture.priceVersionId],
    });
    return {
      p_runtime_contract_id: fixture.runtimeContractId,
      p_runtime_contract_sha256: fixture.runtimeContractSha256,
      p_actor: "provider-attempt-settlement-test",
      p_reason: reason,
      p_reviewed_source_commit_oid: root.reviewedSourceCommitOid,
      p_reviewed_source_sha256: fixture.runtimeContractSha256,
      p_rechecked_at: root.recheckedAt,
      p_rechecked_sha256: fixture.runtimeContractSha256,
    };
  }

  async cleanup(): Promise<void> {
    if (this.fixture) {
      const { data: config, error: configError } = await this.service
        .from("ai_feature_config")
        .select("active_routing_policy_version_id")
        .eq("id", true)
        .single();
      expect(configError).toBeNull();
      if (
        config?.active_routing_policy_version_id === this.fixture.policyVersionId
      ) {
        const reason = `settlement cleanup ${crypto.randomUUID()}`;
        const cleared = await this.service.rpc(
          "clear_ai_routing_policy_pointer_v1",
          {
            p_expected_policy_version_id: this.fixture.policyVersionId,
            ...this.lifecycleEvidence(this.fixture, reason),
          },
        );
        expect(cleared.error).toBeNull();
      }
    }
    // Immutable catalog fixture rows intentionally remain until the fresh DB
    // reset; cleanup releases only the exact live pointer and mutable users.
    await configureFeature(this.service, { ...FEATURE_CONFIG_DEFAULTS });
    for (const user of this.users) {
      await deleteTestUser(this.service, user.id);
    }
  }

  async makeUser(label: string): Promise<TestUser> {
    const user = await createTestUser(this.service, label);
    this.users.push(user);
    return user;
  }

  async reserveV2(user: TestUser): Promise<SettlementReservation> {
    await acceptAiLegalBundle(
      this.service,
      user.id,
      INITIAL_LEGAL_BUNDLE_VERSION,
    );
    const config = await this.service
      .from("ai_feature_config")
      .select("config_generation")
      .eq("id", true)
      .single();
    expect(config.error).toBeNull();
    const result = await this.service.rpc("reserve_ai_polish_request_v2", {
      p_user_id: user.id,
      p_request_id: crypto.randomUUID(),
      p_client_request_id: crypto.randomUUID(),
      p_expected_route: {
        schema_version: "expected_route_v1",
        config_generation: String(config.data!.config_generation),
        profile_version_id: this.fixture.profileVersionId,
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        runtime_contract_id: this.fixture.runtimeContractId,
        runtime_contract_sha256: this.fixture.runtimeContractSha256,
      },
    });
    expect(result.error).toBeNull();
    expect(result.data?.allowed).toBe(true);
    return {
      reservationId: result.data.reservationId as string,
      routeSnapshot: result.data.routeSnapshot as SettlementRouteSnapshot,
    };
  }

  async startAttempt(
    reservationId: string,
    attemptNo: 1 | 2,
  ): Promise<SettlementAttempt> {
    const result = await this.service.rpc("start_ai_polish_provider_attempt", {
      p_reservation_id: reservationId,
      p_attempt_no: attemptNo,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      ok: true,
      attemptNo,
      alreadyStarted: false,
      status: "started",
    });
    return {
      attemptId: result.data.attemptId as string,
      attemptNo,
    };
  }

  async complete(payload: CompletePayload) {
    const result = await this.service.rpc(
      "complete_ai_polish_provider_attempt",
      payload,
    );
    expect(result.error).toBeNull();
    return result.data;
  }

  async finalize(
    reservationId: string,
    options: {
      status?: string;
      quotaCharged?: boolean;
      providerBillable?: boolean | null;
      usage?: unknown;
      metadata?: unknown;
    } = {},
  ) {
    const result = await this.service.rpc("finalize_ai_polish_request", {
      p_reservation_id: reservationId,
      p_status: options.status ?? "succeeded",
      p_quota_charged: options.quotaCharged ?? true,
      p_provider_billable:
        options.providerBillable === undefined
          ? true
          : options.providerBillable,
      p_usage: options.usage === undefined ? null : options.usage,
      p_metadata:
        options.metadata === undefined
          ? { usage_schema_version: "attempt_v2" }
          : options.metadata,
      p_settlement_contract: "durable_cancellation_sequence_v1",
    });
    expect(result.error).toBeNull();
    return result.data;
  }

  private async createActiveRouteFixture(
    provider: SettlementProviderKind,
  ): Promise<SettlementRouteFixture> {
    const suffix = crypto.randomUUID();
    const profileKey = `test.attempt-settlement.${provider}.${suffix}`;
    const isMimo = provider === "mimo";
    const modelId = isMimo ? "mimo-v2.5-pro" : "deepseek-v4-flash";
    const displayDisclosureKey = isMimo
      ? "mimo.official"
      : "deepseek.official";

    const runtime = authorSyntheticRuntimeContract({
      profileKey,
      ...(isMimo
        ? {
            legalManifestId: MIMO_LEGAL_MANIFEST_ID,
            manifestSha256: MIMO_LEGAL_MANIFEST_SHA256,
          }
        : {}),
    });
    const profileId = crypto.randomUUID();
    const profileVersionId = crypto.randomUUID();
    const priceVersionId = crypto.randomUUID();
    const policyVersionId = crypto.randomUUID();
    const authored = runOwnerSql(`begin;
      insert into public.ai_provider_profiles(id,profile_key,display_name,gateway_kind,model_vendor) values ('${profileId}','${profileKey}','Provider attempt settlement fixture','${isMimo ? "direct_mimo" : "direct_deepseek"}','${provider}');
      insert into public.ai_provider_profile_versions(id,profile_id,version,adapter_kind,wire_api_kind,credential_alias,endpoint_alias,model_id,upstream_route,capability_contract_id,cache_policy_id,legal_manifest_id,display_disclosure_key,config,config_sha256) values ('${profileVersionId}','${profileId}',1,'${isMimo ? "mimo_responses_v1" : "deepseek_chat_v1"}','${isMimo ? "responses_v1" : "chat_completions_v1"}','${isMimo ? "mimo_api_key" : "deepseek_api_key"}','${isMimo ? "mimo_cn_official" : "deepseek_official"}','${modelId}','{}','polish_v2','automatic_cache_v1','${isMimo ? MIMO_LEGAL_MANIFEST_ID : DEEPSEEK_LEGAL_MANIFEST_ID}','${displayDisclosureKey}','{}','${"4".repeat(64)}');
      update public.ai_provider_profile_versions set status='validated' where id='${profileVersionId}'::uuid;
      insert into public.ai_price_versions(id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters) values ('${priceVersionId}','${profileVersionId}','default',1,'CNY','linear_token_v1',pg_catalog.clock_timestamp()-interval '1 hour','https://example.com/provider-attempt-settlement-price',pg_catalog.clock_timestamp(),'${"5".repeat(64)}','{}');
      insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ('${priceVersionId}','input_standard',1),('${priceVersionId}','input_cache_read',1),('${priceVersionId}','output',1);
      insert into public.ai_routing_policy_versions(id,policy_key,version,timezone,rules,default_profile_version_id,legal_bundle_version,runtime_contract_id,runtime_contract_sha256,config_sha256) values ('${policyVersionId}','test.attempt-settlement.${suffix}',1,'Asia/Shanghai',pg_catalog.jsonb_build_object('schemaVersion','routing_rules_v1','defaultRoute',pg_catalog.jsonb_build_object('profileVersionId','${profileVersionId}','priceVersionId','${priceVersionId}'),'windows','[]'::jsonb),'${profileVersionId}','${INITIAL_LEGAL_BUNDLE_VERSION}','${runtime.runtimeContractId}','${runtime.runtimeContractSha256}','${"6".repeat(64)}');
      commit;`);
    expect(authored.status).toBe(0);
    sealPriceAsDatabaseOwner(priceVersionId);
    const fixture: SettlementRouteFixture = {
      profileId,
      profileVersionId,
      priceVersionId,
      policyVersionId,
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      modelId,
      displayDisclosureKey,
    };

    const validated = await this.service.rpc(
      "transition_ai_routing_policy_v2",
      {
        p_policy_version_id: policyVersionId,
        p_to_status: "validated",
        ...this.lifecycleEvidence(
          fixture,
          `validate settlement fixture ${suffix}`,
        ),
      },
    );
    expect(validated.error).toBeNull();

    const promotedProfile = runOwnerSql(String.raw`
      update public.ai_provider_profile_versions
      set status = 'canary'
      where id = '${profileVersionId}'::uuid;
    `);
    expect(promotedProfile.status, promotedProfile.stderr).toBe(0);

    const canary = await this.service.rpc("transition_ai_routing_policy_v2", {
      p_policy_version_id: policyVersionId,
      p_to_status: "canary",
      ...this.lifecycleEvidence(
        fixture,
        `promote settlement fixture ${suffix} to canary`,
      ),
    });
    expect(canary.error).toBeNull();

    const activated = await this.service.rpc(
      "set_ai_routing_policy_pointer_v1",
      {
        p_policy_version_id: policyVersionId,
        ...this.lifecycleEvidence(
          fixture,
          `activate settlement fixture ${suffix}`,
        ),
      },
    );
    expect(activated.error).toBeNull();

    return fixture;
  }
}
