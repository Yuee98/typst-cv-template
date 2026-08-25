import { describe, expect, it, vi } from "vitest";

import {
  classifyGlobalUsage,
  collectAllPages,
  buildMetrics,
  summarizeTokenUsage,
} from "./metrics-logic.mjs";

const assert = {
  equal(actual, expected) {
    expect(actual).toBe(expected);
  },
  deepEqual(actual, expected) {
    expect(actual).toEqual(expected);
  },
};

describe("metrics logic", () => {
it("collectAllPages collects a full first page and a one-row second page", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ id: index }));
    const second = [{ id: 1000 }];
    const loadPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const rows = await collectAllPages(loadPage);

    assert.equal(rows.length, 1001);
    assert.deepEqual(rows.at(-1), { id: 1000 });
    assert.deepEqual(loadPage.mock.calls, [[0, 999], [1000, 1999]]);
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

    assert.deepEqual(summary.known, { count: 4, totals: { inputCached: 12, inputUncached: 16, output: 17 } });
    assert.deepEqual(summary.complete, { count: 2, totals: { inputCached: 5, inputUncached: 7, output: 9 } });
    assert.deepEqual(summary.incompleteKnown, { count: 2, totals: { inputCached: 7, inputUncached: 9, output: 8 } });
    assert.equal(summary.completeWithInput.count, 2);
    assert.equal(summary.succeededCompleteWithInput.count, 1);
});

it("classifyGlobalUsage reports a zero limit with zero use as disabled, not OK", () => {
  assert.deepEqual(classifyGlobalUsage(0, 0), { level: "disabled", ratio: null });
});

it("classifyGlobalUsage preserves alert and critical thresholds", () => {
  assert.equal(classifyGlobalUsage(79, 100).level, "ok");
  assert.equal(classifyGlobalUsage(80, 100).level, "alert");
  assert.equal(classifyGlobalUsage(100, 100).level, "critical");
  assert.equal(classifyGlobalUsage(1, 0).level, "critical");
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

  assert.equal(metrics.requestLevel.totalRequests, 1);
  assert.equal(metrics.requestLevel.totalRetries, 1);
  assert.equal(metrics.attemptLevel.totalAttempts, 2);
  assert.equal(metrics.attemptLevel.totalRetries, 1);
  assert.equal(metrics.requestLevel.usage.inputCacheReadTokens, "10");
  assert.equal(metrics.attemptLevel.usage.inputCacheReadTokens, "20");
  assert.deepEqual(metrics.alerts.unexpectedRoute, { requestCount: 1, attemptCount: 1 });
  const serialized = JSON.stringify(metrics);
  assert.equal(serialized.includes("raw-provider-id-must-not-escape"), false);
  assert.equal(serialized.includes("https://secret.example.test/key"), false);
  assert.equal(serialized.includes("secret-alias"), false);
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
  assert.equal(groups.some((group) => group.key.currency === "CNY"), true);
  assert.equal(groups.some((group) => group.key.currency === "USD"), true);
  const legacy = groups.find((group) => group.key.routeSchemaVersion === "legacy_v1");
  assert.deepEqual(legacy.key, {
    routeSchemaVersion: "legacy_v1",
    profileVersionId: null,
    routingPolicyVersionId: null,
    priceVersionId: null,
    runtimeContractId: null,
    runtimeContractSha256: null,
    gatewayKind: null,
    currency: null,
  });
  assert.equal(legacy.cost.knownEstimatedNanos, "0");
  assert.equal(legacy.usage.inputCacheReadTokens, "10");
  const legacyPricing = groups.find((group) => group.key.routeSchemaVersion === "legacy_pricing_v1");
  assert.deepEqual(legacyPricing.key, {
    routeSchemaVersion: "legacy_pricing_v1",
    profileVersionId: CURRENT_ROUTE.profile_version_id,
    routingPolicyVersionId: null,
    priceVersionId: CURRENT_ROUTE.price_version_id,
    runtimeContractId: null,
    runtimeContractSha256: null,
    gatewayKind: null,
    currency: "CNY",
  });
  assert.equal(legacyPricing.cost.knownEstimatedNanos, "100");
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

  assert.equal(metrics.requestLevel.usage.inputCacheReadTokens, "7");
  assert.equal(metrics.requestLevel.usage.inputStandardTokens, "8");
  assert.deepEqual(metrics.requestLevel.groups[0].key, {
    routeSchemaVersion: "legacy_v1",
    profileVersionId: null,
    routingPolicyVersionId: null,
    priceVersionId: null,
    runtimeContractId: null,
    runtimeContractSha256: null,
    gatewayKind: null,
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
  assert.deepEqual(malformedOnly.alerts.unexpectedRoute, { requestCount: 1, attemptCount: 0 });
  const malformedLegacy = buildMetrics({
    requests: [requestRow({ route_schema_version: "legacy_pricing_v1", profile_version_id: null })],
    attempts: [],
  });
  assert.deepEqual(malformedLegacy.alerts.unexpectedRoute, { requestCount: 1, attemptCount: 0 });
  const bounded = buildMetrics({
    requests: [requestRow({
      input_cache_read_tokens: "9223372036854775808",
      input_standard_tokens: "12345678901234567890",
    })],
    attempts: [],
  });
  assert.equal(bounded.requestLevel.usage.inputCacheReadTokens, "0");
  assert.equal(bounded.requestLevel.usage.inputStandardTokens, "0");

  const drifted = buildMetrics({ requests: [requestRow()], attempts: [driftedAttempt] });
  assert.deepEqual(drifted.alerts.unexpectedRoute, { requestCount: 1, attemptCount: 1 });
});
});
