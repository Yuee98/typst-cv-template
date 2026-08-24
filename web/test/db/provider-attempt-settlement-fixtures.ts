import type { SupabaseClient } from "@supabase/supabase-js";
import { expect } from "vitest";

import {
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
  sealPriceAsDatabaseOwner,
  transitionPolicyAsDatabaseOwner,
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
  gatewayKind: "direct_deepseek";
  modelId: string;
  wireApiKind: "chat_completions_v1";
  displayDisclosureKey: string;
}

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

  async activateFreshRouteFixture(): Promise<SettlementRouteFixture> {
    this.fixture = await this.createActiveRouteFixture();
    return this.fixture;
  }

  async resetFeature(): Promise<void> {
    await configureFeature(this.service, {
      enabled: true,
      globalDailyLimit: LARGE_GLOBAL_LIMIT,
      allowlist: [],
    });
  }

  async cleanup(): Promise<void> {
    const pointer = await this.service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: null,
        routing_updated_by: "provider-attempt-settlement-test",
        routing_change_reason: `settlement cleanup ${crypto.randomUUID()}`,
      })
      .eq("id", true);
    expect(pointer.error).toBeNull();
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
    });
    expect(result.error).toBeNull();
    return result.data;
  }

  private async createActiveRouteFixture(): Promise<SettlementRouteFixture> {
    const suffix = crypto.randomUUID();
    const profileKey = `test.attempt-settlement.${suffix}`;
    const modelId = "deepseek-v4-flash";
    const displayDisclosureKey = "deepseek.official";

    const profile = await this.service
      .from("ai_provider_profiles")
      .insert({
        profile_key: profileKey,
        display_name: "Provider attempt settlement fixture",
        gateway_kind: "direct_deepseek",
        model_vendor: "deepseek",
      })
      .select("id")
      .single();
    expect(profile.error).toBeNull();

    const version = await this.service
      .from("ai_provider_profile_versions")
      .insert({
        profile_id: profile.data!.id,
        version: 1,
        adapter_kind: "deepseek_chat_v1",
        wire_api_kind: "chat_completions_v1",
        credential_alias: "deepseek_api_key",
        endpoint_alias: "deepseek_official",
        model_id: modelId,
        upstream_route: {},
        capability_contract_id: "polish_v2",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id: DEEPSEEK_LEGAL_MANIFEST_ID,
        display_disclosure_key: displayDisclosureKey,
        config: {},
        config_sha256: "4".repeat(64),
      })
      .select("id")
      .single();
    expect(version.error).toBeNull();

    const price = await this.service
      .from("ai_price_versions")
      .insert({
        profile_version_id: version.data!.id,
        pricing_lane: "default",
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: new Date(Date.now() - 3_600_000).toISOString(),
        source_url: "https://example.com/provider-attempt-settlement-price",
        source_checked_at: new Date().toISOString(),
        source_snapshot_sha256: "5".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(price.error).toBeNull();

    const components = await this.service.from("ai_price_components").insert(
      ["input_standard", "input_cache_read", "output"].map((component) => ({
        price_version_id: price.data!.id,
        component,
        nanos_per_million: 1,
      })),
    );
    expect(components.error).toBeNull();
    sealPriceAsDatabaseOwner(price.data!.id);

    const validated = await this.service
      .from("ai_provider_profile_versions")
      .update({ status: "validated" })
      .eq("id", version.data!.id);
    expect(validated.error).toBeNull();

    const runtime = authorSyntheticRuntimeContract({ profileKey });
    const policy = await this.service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.attempt-settlement.${suffix}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules: {
          schemaVersion: "routing_rules_v1",
          defaultRoute: {
            profileVersionId: version.data!.id,
            priceVersionId: price.data!.id,
          },
          windows: [],
        },
        default_profile_version_id: version.data!.id,
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        runtime_contract_id: runtime.runtimeContractId,
        runtime_contract_sha256: runtime.runtimeContractSha256,
        config_sha256: "6".repeat(64),
      })
      .select("id")
      .single();
    expect(policy.error).toBeNull();

    transitionPolicyAsDatabaseOwner(policy.data!.id, "validated");
    const canary = await this.service
      .from("ai_provider_profile_versions")
      .update({ status: "canary" })
      .eq("id", version.data!.id);
    expect(canary.error).toBeNull();
    transitionPolicyAsDatabaseOwner(policy.data!.id, "canary");

    const pointer = await this.service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: policy.data!.id,
        routing_updated_by: "provider-attempt-settlement-test",
        routing_change_reason: `activate settlement fixture ${suffix}`,
      })
      .eq("id", true);
    expect(pointer.error).toBeNull();

    return {
      profileId: profile.data!.id,
      profileVersionId: version.data!.id,
      priceVersionId: price.data!.id,
      policyVersionId: policy.data!.id,
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      modelId,
      displayDisclosureKey,
    };
  }
}
