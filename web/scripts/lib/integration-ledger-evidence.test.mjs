import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_INTEGRATION_PROFILE,
  evaluateRequestLedgerEvidence,
  evaluateRunLedgerEvidence,
  isOfficialDeepSeekChatCompletionsEndpoint,
  isWithinTransmissionBudget,
  resolveIntegrationProfile,
} from "./integration-ledger-evidence.mjs";

function attempt(overrides = {}) {
  return {
    attempt_no: 1,
    route_schema_version: "route_snapshot_v1",
    config_generation: 7,
    routing_policy_version_id: "policy-1",
    profile_version_id: DEEPSEEK_INTEGRATION_PROFILE.profileVersionId,
    price_version_id: "price-1",
    legal_bundle_version: "2026-08-23-multi-provider-v1",
    runtime_contract_id: DEEPSEEK_INTEGRATION_PROFILE.runtimeContractId,
    runtime_contract_sha256: "a".repeat(64),
    gateway_kind: "direct_deepseek",
    model_id: "deepseek-v4-flash",
    wire_api_kind: "chat_completions_v1",
    display_disclosure_key: "deepseek-official-v1",
    endpoint_alias: "deepseek_official",
    actual_upstream_endpoint: "https://api.deepseek.com/chat/completions",
    actual_model_id: "deepseek-v4-flash",
    status: "succeeded",
    transmitted: true,
    provider_billable: true,
    usage_observation_kind: "observed",
    usage_complete: true,
    input_cache_read_tokens: 2,
    input_cache_write_tokens: 3,
    input_standard_tokens: 5,
    output_tokens: 7,
    billing_currency: "USD",
    estimated_currency: "USD",
    estimated_cost_nanos: 17,
    provider_reported_currency: "USD",
    provider_reported_cost_nanos: 17,
    ...overrides,
  };
}

function parent(children, overrides = {}) {
  const rows = children;
  const knownEstimatedRows = rows.filter((row) => row.estimated_cost_nanos != null);
  const knownEstimated =
    knownEstimatedRows.length === 0
      ? null
      : knownEstimatedRows.reduce((sum, row) => sum + row.estimated_cost_nanos, 0);
  const allKnownEstimated = rows.every((row) => row.estimated_cost_nanos != null || row.provider_billable === false);
  const billable = rows.some((row) => row.provider_billable === true)
    ? true
    : rows.every((row) => row.provider_billable === false)
      ? false
      : null;
  const applicable = rows.filter((row) => row.provider_billable !== false);
  const allReported = applicable.length > 0 && applicable.every((row) => row.provider_reported_cost_nanos != null);
  const reported = allReported ? applicable.reduce((sum, row) => sum + row.provider_reported_cost_nanos, 0) : null;
  const estimated = allKnownEstimated ? knownEstimated : null;
  return {
    state: "finalized",
    attempt_count: rows.length,
    route_schema_version: "route_snapshot_v1",
    config_generation: 7,
    routing_policy_version_id: "policy-1",
    profile_version_id: DEEPSEEK_INTEGRATION_PROFILE.profileVersionId,
    price_version_id: "price-1",
    legal_bundle_version: "2026-08-23-multi-provider-v1",
    runtime_contract_id: DEEPSEEK_INTEGRATION_PROFILE.runtimeContractId,
    runtime_contract_sha256: "a".repeat(64),
    gateway_kind: "direct_deepseek",
    model_id: "deepseek-v4-flash",
    wire_api_kind: "chat_completions_v1",
    display_disclosure_key: "deepseek-official-v1",
    provider_billable: billable,
    usage_complete: rows.every((row) => row.usage_observation_kind === "observed" && row.usage_complete === true),
    input_cached_tokens: rows.reduce((sum, row) => sum + (row.input_cache_read_tokens ?? 0), 0),
    input_uncached_tokens: rows.reduce((sum, row) => sum + (row.input_cache_write_tokens ?? 0) + (row.input_standard_tokens ?? 0), 0),
    output_tokens: rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
    incomplete_fields: allKnownEstimated ? [] : ["attempt_usage", "estimated_cost", "provider_billable"],
    billing_currency: "USD",
    cost_basis: "frozen_price_version_v1",
    known_estimated_cost_nanos: knownEstimated,
    estimated_cost_nanos: estimated,
    provider_reported_currency: reported == null ? null : "USD",
    provider_reported_cost_nanos: reported,
    cost_reconciliation_status: !allKnownEstimated
      ? "incomplete_usage"
      : reported == null
        ? "not_available"
        : reported === estimated
          ? "matched"
          : "mismatch",
    ...overrides,
  };
}

describe("integration ledger evidence", () => {
  it("accepts only the exact official DeepSeek chat-completions path", () => {
    expect(isOfficialDeepSeekChatCompletionsEndpoint("https://api.deepseek.com/chat/completions")).toBe(true);
    for (const endpoint of [
      "https://api.deepseek.com/v1/chat/completions",
      "https://api.deepseek.com/chat/completions/",
      "https://api.deepseek.com.evil.example/chat/completions",
      "http://api.deepseek.com/chat/completions",
    ]) {
      expect(isOfficialDeepSeekChatCompletionsEndpoint(endpoint)).toBe(false);
    }
  });

  it("enforces the 0..4 transmitted-run budget and rejects 5", () => {
    expect([0, 1, 2, 3, 4].every(isWithinTransmissionBudget)).toBe(true);
    expect(isWithinTransmissionBudget(5)).toBe(false);
    expect(evaluateRequestLedgerEvidence(parent([]), []).issues).toContain("child_count_out_of_range");
  });

  it("rejects gaps and duplicates while accepting a false pre-entry transmission", () => {
    const first = attempt({ status: "failed_upstream", transmitted: false, provider_billable: false, estimated_cost_nanos: null, estimated_currency: null, provider_reported_cost_nanos: null, provider_reported_currency: null });
    expect(evaluateRequestLedgerEvidence(parent([first]), [first]).ok).toBe(true);

    const gap = attempt({ attempt_no: 2 });
    expect(evaluateRequestLedgerEvidence(parent([gap]), [gap]).issues).toContain("attempt_no_gap_or_order");

    const duplicate = [attempt(), attempt({ attempt_no: 1, transmitted: false, status: "failed_upstream", provider_billable: false, estimated_cost_nanos: null, estimated_currency: null, provider_reported_cost_nanos: null, provider_reported_currency: null })];
    expect(evaluateRequestLedgerEvidence(parent(duplicate), duplicate).issues).toContain("attempt_no_duplicate");
  });

  it("rejects null transmission on a known terminal outcome but preserves an unknown cancellation fact", () => {
    const nullTransmission = attempt({ transmitted: null });
    expect(evaluateRequestLedgerEvidence(parent([nullTransmission]), [nullTransmission]).issues).toContain("attempt_transmission_truth_invalid");

    const unknown = attempt({
      status: "unknown",
      transmitted: null,
      provider_billable: null,
      usage_observation_kind: "unavailable",
      usage_complete: false,
      input_cache_read_tokens: null,
      input_cache_write_tokens: null,
      input_standard_tokens: null,
      output_tokens: null,
      estimated_currency: null,
      estimated_cost_nanos: null,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
    });
    const unknownParent = parent([unknown], {
      provider_billable: null,
      usage_complete: false,
      input_cached_tokens: 0,
      input_uncached_tokens: 0,
      output_tokens: 0,
      incomplete_fields: ["attempt_usage", "input_cache_write", "reasoning", "provider_billable", "estimated_cost"],
      known_estimated_cost_nanos: null,
      estimated_cost_nanos: null,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
    });
    expect(evaluateRequestLedgerEvidence(unknownParent, [unknown]).ok).toBe(true);

    const canceled = attempt({
      status: "canceled",
      transmitted: true,
      provider_billable: null,
      usage_observation_kind: "unavailable",
      usage_complete: false,
      input_cache_read_tokens: null,
      input_cache_write_tokens: null,
      input_standard_tokens: null,
      output_tokens: null,
      estimated_currency: null,
      estimated_cost_nanos: null,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
    });
    expect(evaluateRequestLedgerEvidence(parent([canceled]), [canceled]).ok).toBe(true);
  });

  it("rejects parent-child identity mismatches", () => {
    const child = attempt({ actual_model_id: "other-model" });
    expect(evaluateRequestLedgerEvidence(parent([child]), [child]).issues).toContain("attempt_model_mismatch");
  });

  it("preserves incomplete cost and rejects mixed-currency aggregation", () => {
    const incomplete = attempt({ estimated_cost_nanos: null, estimated_currency: null, provider_reported_cost_nanos: null, provider_reported_currency: null });
    const incompleteParent = parent([incomplete], {
      known_estimated_cost_nanos: null,
      estimated_cost_nanos: null,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
      incomplete_fields: [],
    });
    expect(evaluateRequestLedgerEvidence(incompleteParent, [incomplete]).issues).toContain("incomplete_estimated_cost_not_preserved");

    const mixedCurrency = attempt({ estimated_currency: "CNY" });
    expect(evaluateRequestLedgerEvidence(parent([mixedCurrency]), [mixedCurrency]).issues).toContain("estimated_currency_mismatch");
  });

  it("never grants an official-proof verdict to a custom upstream diagnostic", () => {
    const row = attempt({ actual_upstream_endpoint: "https://diagnostic.internal/chat/completions" });
    const result = evaluateRunLedgerEvidence([{ parent: parent([row]), attempts: [row] }], { officialProof: false });
    expect(result.ok).toBe(false);
    expect(result.officialProof).toBe(false);
    expect(result.requestResults[0].ok).toBe(true);
  });

  it("fails closed for the dark MiMo draft", () => {
    expect(() => resolveIntegrationProfile("mimo")).toThrow(/fail-closed/i);
  });
});
