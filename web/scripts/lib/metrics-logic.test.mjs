import { describe, expect, it, vi } from "vitest";

import {
  classifyGlobalUsage,
  collectAllPages,
  buildMetrics,
  summarizeTokenUsage,
} from "./metrics-logic.mjs";

describe("metrics logic", () => {
  it("collectAllPages collects a full first page and a one-row second page", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ id: index }));
    const second = [{ id: 1000 }];
    const loadPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const rows = await collectAllPages(loadPage);

    expect(rows).toHaveLength(1001);
    expect(rows.at(-1)).toEqual({ id: 1000 });
    expect(loadPage).toHaveBeenNthCalledWith(1, 0, 999);
    expect(loadPage).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it("summarizeTokenUsage keeps known cost from every finalized status and incomplete rows", () => {
    const rows = [
      { status: "succeeded", usage_complete: true, input_cached_tokens: 1, input_uncached_tokens: 2, output_tokens: 3 },
      { status: "invalid_output", usage_complete: true, input_cached_tokens: 4, input_uncached_tokens: 5, output_tokens: 6 },
      { status: "failed_upstream", usage_complete: false, input_cached_tokens: 7, input_uncached_tokens: null, output_tokens: 8 },
      { status: "canceled", usage_complete: false, input_cached_tokens: null, input_uncached_tokens: 9, output_tokens: null },
      { status: "released", usage_complete: false, input_cached_tokens: null, input_uncached_tokens: null, output_tokens: null },
    ];

    const summary = summarizeTokenUsage(rows);

    expect(summary.known).toEqual({ count: 4, totals: { inputCached: 12, inputUncached: 16, output: 17 } });
    expect(summary.complete).toEqual({ count: 2, totals: { inputCached: 5, inputUncached: 7, output: 9 } });
    expect(summary.incompleteKnown).toEqual({ count: 2, totals: { inputCached: 7, inputUncached: 9, output: 8 } });
    expect(summary.completeWithInput.count).toBe(2);
    expect(summary.succeededCompleteWithInput.count).toBe(1);
  });

  it("classifyGlobalUsage reports a zero limit with zero use as disabled, not OK", () => {
    expect(classifyGlobalUsage(0, 0)).toEqual({ level: "disabled", ratio: null });
  });

  it("classifyGlobalUsage preserves alert and critical thresholds", () => {
    expect(classifyGlobalUsage(79, 100).level).toBe("ok");
    expect(classifyGlobalUsage(80, 100).level).toBe("alert");
    expect(classifyGlobalUsage(100, 100).level).toBe("critical");
    expect(classifyGlobalUsage(1, 0).level).toBe("critical");
  });

  const CURRENT_ROUTE = {
    route_schema_version: "route_snapshot_v1",
    config_generation: "42",
    routing_policy_version_id: "11111111-1111-4111-8111-111111111111",
    profile_version_id: "22222222-2222-4222-8222-222222222222",
    price_version_id: "33333333-3333-4333-8333-333333333333",
    legal_bundle_version: "legal-v1",
    runtime_contract_id: "runtime-v1",
    runtime_contract_sha256: "a".repeat(64),
    gateway_kind: "direct_deepseek",
    model_id: "deepseek-v4-flash",
    wire_api_kind: "responses_v1",
    display_disclosure_key: "deepseek.flash",
    billing_currency: "CNY",
  };

  function requestRow(overrides = {}) {
    return {
      reservation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state: "finalized",
      status: "succeeded",
      attempt_count: 2,
      usage_complete: true,
      input_cache_read_tokens: 10,
      input_cache_write_tokens: 4,
      input_standard_tokens: 6,
      output_tokens: 8,
      reasoning_tokens: 2,
      known_estimated_cost_nanos: 100,
      estimated_cost_nanos: 100,
      provider_reported_currency: "CNY",
      provider_reported_cost_nanos: 100,
      cost_reconciliation_status: "matched",
      ...CURRENT_ROUTE,
      ...overrides,
    };
  }

  function attemptRow(overrides = {}) {
    return {
      attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      reservation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attempt_no: 1,
      status: "failed_upstream",
      usage_observation_kind: "observed",
      usage_complete: true,
      input_cache_read_tokens: 10,
      input_cache_write_tokens: 4,
      input_standard_tokens: 6,
      output_tokens: 8,
      reasoning_tokens: 2,
      estimated_cost_nanos: 100,
      provider_reported_currency: "CNY",
      provider_reported_cost_nanos: 100,
      cost_reconciliation_status: "matched",
      gateway_request_id: "raw-provider-id-must-not-escape",
      actual_upstream_endpoint: "https://secret.example.test/key",
      credential_alias: "secret-alias",
      ...CURRENT_ROUTE,
      ...overrides,
    };
  }

  it("buildMetrics separates request and attempt totals and reports route mismatch without IDs", () => {
    const metrics = buildMetrics({
      requests: [requestRow()],
      attempts: [
        attemptRow(),
        attemptRow({
          attempt_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          attempt_no: 2,
          status: "succeeded",
          gateway_kind: "direct_mimo",
        }),
      ],
    });

    expect(metrics.requestLevel.totalRequests).toBe(1);
    expect(metrics.requestLevel.totalRetries).toBe(1);
    expect(metrics.attemptLevel.totalAttempts).toBe(2);
    expect(metrics.attemptLevel.totalRetries).toBe(1);
    expect(metrics.requestLevel.usage.inputCacheReadTokens).toBe("10");
    expect(metrics.attemptLevel.usage.inputCacheReadTokens).toBe("20");
    expect(metrics.alerts.unexpectedRoute).toEqual({ requestCount: 1, attemptCount: 1 });
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain("raw-provider-id-must-not-escape");
    expect(serialized).not.toContain("https://secret.example.test/key");
    expect(serialized).not.toContain("secret-alias");
  });

  it("buildMetrics keeps CNY and USD groups separate and preserves legacy_v1 fallback", () => {
    const metrics = buildMetrics({
      requests: [
        requestRow(),
        requestRow({
          reservation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          billing_currency: "USD",
          provider_reported_currency: "USD",
          cost_reconciliation_status: "mismatch",
        }),
        requestRow({
          reservation_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          route_schema_version: "legacy_pricing_v1",
          config_generation: null,
          routing_policy_version_id: null,
          legal_bundle_version: null,
          runtime_contract_id: null,
          runtime_contract_sha256: null,
          gateway_kind: null,
          model_id: null,
          wire_api_kind: null,
          display_disclosure_key: null,
        }),
        requestRow({
          reservation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          route_schema_version: null,
          config_generation: null,
          routing_policy_version_id: null,
          profile_version_id: null,
          price_version_id: null,
          legal_bundle_version: null,
          runtime_contract_id: null,
          runtime_contract_sha256: null,
          gateway_kind: null,
          model_id: null,
          wire_api_kind: null,
          display_disclosure_key: null,
          billing_currency: null,
          provider_reported_currency: null,
          known_estimated_cost_nanos: null,
          estimated_cost_nanos: null,
          provider_reported_cost_nanos: null,
          cost_reconciliation_status: null,
        }),
      ],
      attempts: [],
    });

    const groups = metrics.requestLevel.groups;
    expect(groups.some((group) => group.key.currency === "CNY")).toBe(true);
    expect(groups.some((group) => group.key.currency === "USD")).toBe(true);
    const current = groups.find((group) => group.key.routeSchemaVersion === "route_snapshot_v1");
    expect(current.key).toMatchObject({
      configGeneration: "42",
      legalBundleVersion: "legal-v1",
      modelId: "deepseek-v4-flash",
      wireApiKind: "responses_v1",
      displayDisclosureKey: "deepseek.flash",
    });
    const legacy = groups.find((group) => group.key.routeSchemaVersion === "legacy_v1");
    expect(legacy.key).toEqual({
      routeSchemaVersion: "legacy_v1",
      configGeneration: null,
      profileVersionId: null,
      routingPolicyVersionId: null,
      priceVersionId: null,
      legalBundleVersion: null,
      runtimeContractId: null,
      runtimeContractSha256: null,
      gatewayKind: null,
      modelId: null,
      wireApiKind: null,
      displayDisclosureKey: null,
      currency: null,
    });
    expect(legacy.cost.knownEstimatedNanos).toBe("0");
    expect(legacy.usage.inputCacheReadTokens).toBe("10");
    const legacyPricing = groups.find((group) => group.key.routeSchemaVersion === "legacy_pricing_v1");
    expect(legacyPricing.key).toEqual({
      routeSchemaVersion: "legacy_pricing_v1",
      profileVersionId: CURRENT_ROUTE.profile_version_id,
      routingPolicyVersionId: null,
      priceVersionId: CURRENT_ROUTE.price_version_id,
      runtimeContractId: null,
      runtimeContractSha256: null,
      gatewayKind: null,
      currency: "CNY",
    });
    expect(legacyPricing.cost.knownEstimatedNanos).toBe("100");
  });

  it("buildMetrics keeps request and attempt latency percentiles disjoint and grouped", () => {
    const metrics = buildMetrics({
      requests: [
        requestRow({ latency_ms: 120 }),
        requestRow({ reservation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", latency_ms: 40 }),
        requestRow({ reservation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", latency_ms: -1 }),
      ],
      attempts: [
        attemptRow({ latency_ms: 90 }),
        attemptRow({ reservation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", latency_ms: 30 }),
        attemptRow({ reservation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", latency_ms: "50" }),
      ],
    });

    expect(metrics.requestLevel.latency).toEqual({ knownCount: 2, p50Ms: 40, p95Ms: 120 });
    expect(metrics.attemptLevel.latency).toEqual({ knownCount: 2, p50Ms: 30, p95Ms: 90 });
    const requestGroup = metrics.requestLevel.groups.find(
      (group) => group.key.routeSchemaVersion === "route_snapshot_v1",
    );
    const attemptGroup = metrics.attemptLevel.groups.find(
      (group) => group.key.routeSchemaVersion === "route_snapshot_v1",
    );
    expect(requestGroup.latency).toEqual({ knownCount: 2, p50Ms: 40, p95Ms: 120 });
    expect(attemptGroup.latency).toEqual({ knownCount: 2, p50Ms: 30, p95Ms: 90 });
  });

  it("buildMetrics retains legacy usage fields without inventing route or currency dimensions", () => {
    const metrics = buildMetrics({
      requests: [requestRow({
        route_schema_version: null,
        config_generation: null,
        routing_policy_version_id: null,
        profile_version_id: null,
        price_version_id: null,
        legal_bundle_version: null,
        runtime_contract_id: null,
        runtime_contract_sha256: null,
        gateway_kind: null,
        model_id: null,
        wire_api_kind: null,
        display_disclosure_key: null,
        billing_currency: null,
        input_cache_read_tokens: null,
        input_cached_tokens: 7,
        input_standard_tokens: null,
        input_uncached_tokens: 8,
      })],
      attempts: [],
    });

    expect(metrics.requestLevel.usage.inputCacheReadTokens).toBe("7");
    expect(metrics.requestLevel.usage.inputStandardTokens).toBe("8");
    expect(metrics.requestLevel.groups[0].key).toEqual({
      routeSchemaVersion: "legacy_v1",
      configGeneration: null,
      profileVersionId: null,
      routingPolicyVersionId: null,
      priceVersionId: null,
      legalBundleVersion: null,
      runtimeContractId: null,
      runtimeContractSha256: null,
      gatewayKind: null,
      modelId: null,
      wireApiKind: null,
      displayDisclosureKey: null,
      currency: null,
    });
  });

  it("buildMetrics alerts on malformed V2 tuples and route-only drift", () => {
    const malformed = requestRow({
      runtime_contract_sha256: "not-a-hash",
    });
    const driftedAttempt = attemptRow({
      wire_api_kind: "chat_completions_v1",
      display_disclosure_key: "deepseek.other",
    });
    const malformedOnly = buildMetrics({ requests: [malformed], attempts: [] });
    expect(malformedOnly.alerts.unexpectedRoute).toEqual({ requestCount: 1, attemptCount: 0 });
    const malformedLegacy = buildMetrics({
      requests: [requestRow({ route_schema_version: "legacy_pricing_v1", profile_version_id: null })],
      attempts: [],
    });
    expect(malformedLegacy.alerts.unexpectedRoute).toEqual({ requestCount: 1, attemptCount: 0 });
    const bounded = buildMetrics({
      requests: [requestRow({
        input_cache_read_tokens: "9223372036854775808",
        input_standard_tokens: "12345678901234567890",
      })],
      attempts: [],
    });
    expect(bounded.requestLevel.usage.inputCacheReadTokens).toBe("0");
    expect(bounded.requestLevel.usage.inputStandardTokens).toBe("0");

    const drifted = buildMetrics({ requests: [requestRow()], attempts: [driftedAttempt] });
    expect(drifted.alerts.unexpectedRoute).toEqual({ requestCount: 1, attemptCount: 1 });
  });

  it("buildMetrics does not mix provider-reported cost across currencies", () => {
    const metrics = buildMetrics({
      requests: [requestRow({ provider_reported_currency: "USD", provider_reported_cost_nanos: 999 })],
      attempts: [],
    });

    expect(metrics.requestLevel.cost.byCurrency.CNY).toEqual({
      knownEstimatedNanos: "100",
      providerReportedNanos: "0",
    });
    expect(metrics.requestLevel.cost.reconciliationCounts.unknown).toBe(1);
  });
});
