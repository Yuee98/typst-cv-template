/**
 * Pure evidence checks for the real-key integration harness.
 *
 * These helpers deliberately accept only bounded ledger metadata. Callers
 * must never pass provider bodies, credentials, prompt text, or polished text.
 */

const ROUTE_SCHEMA_VERSION = "route_snapshot_v1";
const LEGAL_BUNDLE_VERSION = "2026-08-23-multi-provider-v1";

export const DEEPSEEK_INTEGRATION_PROFILE = Object.freeze({
  name: "deepseek",
  profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
  profileVersionId: "11111111-1111-4111-8111-111111111111",
  priceVersionIds: Object.freeze([
    "11111111-1111-4111-8111-111111111112",
    "11111111-1111-4111-8111-111111111113",
  ]),
  routeSchemaVersion: ROUTE_SCHEMA_VERSION,
  legalBundleVersion: LEGAL_BUNDLE_VERSION,
  runtimeContractId: "runtime.deepseek-v2.v1",
  runtimeContractSha256: "229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9",
  gatewayKind: "direct_deepseek",
  wireApiKind: "chat_completions_v1",
  endpointAlias: "deepseek_official",
  endpoint: "https://api.deepseek.com/chat/completions",
  modelId: "deepseek-v4-flash",
  billingCurrency: "CNY",
  displayDisclosure: Object.freeze({
    key: "deepseek-official-v1",
    providerName: "DeepSeek",
    modelName: "DeepSeek V4 Flash",
  }),
  credentialEnv: "DEEPSEEK_API_KEY",
});

export const MIMO_INTEGRATION_PROFILE = Object.freeze({
  name: "mimo",
  profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
  profileVersionId: "22222222-2222-4222-8222-222222222221",
  priceVersionIds: Object.freeze(["22222222-2222-4222-8222-222222222222"]),
  routeSchemaVersion: ROUTE_SCHEMA_VERSION,
  legalBundleVersion: LEGAL_BUNDLE_VERSION,
  runtimeContractId: "runtime.deepseek-v2-mimo-v2.5-pro.v2",
  runtimeContractSha256: "510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c",
  gatewayKind: "direct_mimo",
  wireApiKind: "responses_v1",
  endpointAlias: "mimo_cn_official",
  endpoint: "https://api.xiaomimimo.com/v1/responses",
  modelId: "mimo-v2.5-pro",
  billingCurrency: "CNY",
  displayDisclosure: Object.freeze({
    key: "mimo-cn-v1",
    providerName: "MiMo",
    modelName: "MiMo V2.5 Pro",
  }),
  credentialEnv: "MIMO_API_KEY",
});

const INTEGRATION_PROFILES = new Map([
  ["deepseek", DEEPSEEK_INTEGRATION_PROFILE],
  ["mimo", MIMO_INTEGRATION_PROFILE],
]);

const TERMINAL_ATTEMPT_STATUSES = new Set([
  "succeeded", "invalid_output", "failed_upstream", "timed_out", "canceled", "unknown",
]);

const PARENT_CHILD_ROUTE_FIELDS = [
  "route_schema_version", "config_generation", "routing_policy_version_id", "profile_version_id",
  "price_version_id", "legal_bundle_version", "runtime_contract_id", "runtime_contract_sha256",
  "gateway_kind", "model_id", "wire_api_kind", "display_disclosure_key",
];

/** Every attempt field consumed by evidence evaluation or aggregation. */
export const ATTEMPT_EVIDENCE_FIELDS = Object.freeze([
  "attempt_no", "status", "transmitted", "provider_billable", "usage_observation_kind",
  "usage_complete", "input_cache_read_tokens", "input_cache_write_tokens", "input_standard_tokens",
  "output_tokens", "reasoning_tokens", "route_schema_version", "config_generation",
  "routing_policy_version_id", "profile_version_id", "price_version_id", "legal_bundle_version",
  "runtime_contract_id", "runtime_contract_sha256", "gateway_kind", "model_id", "wire_api_kind",
  "display_disclosure_key", "endpoint_alias", "actual_upstream_endpoint", "actual_model_id",
  "billing_currency", "estimated_currency", "estimated_cost_nanos", "provider_reported_currency",
  "provider_reported_cost_nanos",
]);

const ROUTE_OBSERVATION_REQUIRED_STATUSES = new Set([
  "succeeded", "invalid_output", "failed_upstream", "timed_out",
]);

export function resolveIntegrationProfile(name = "deepseek") {
  const profile = INTEGRATION_PROFILES.get(name);
  if (profile !== undefined) return profile;
  throw new Error(`unsupported integration profile: ${name}`);
}

/** Exact endpoint check: no host, path, scheme, or cross-profile fallback. */
export function isOfficialIntegrationEndpoint(profile, endpoint) {
  return endpoint === profile.endpoint;
}

/** Legacy-named export retained for existing DeepSeek-only consumers. */
export function isOfficialDeepSeekChatCompletionsEndpoint(endpoint) {
  return isOfficialIntegrationEndpoint(DEEPSEEK_INTEGRATION_PROFILE, endpoint);
}

export function isWithinTransmissionBudget(transmissions) {
  return Number.isInteger(transmissions) && transmissions >= 0 && transmissions <= 4;
}

function same(left, right) {
  return left === right;
}

function isConfigGeneration(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    (value.length < 19 || value <= "9223372036854775807");
}

function sameDisclosure(actual, expected) {
  return actual !== null && typeof actual === "object" &&
    actual.key === expected.key && actual.providerName === expected.providerName &&
    actual.modelName === expected.modelName;
}

/**
 * Derives the only request assertion accepted by the V2 handler from an
 * authenticated availability candidate. The profile constants make a stale,
 * crossed, or differently-disclosed candidate a pre-transmission failure.
 */
export function buildExpectedRouteV1(availability, profile = DEEPSEEK_INTEGRATION_PROFILE) {
  if (availability?.enabled !== true) {
    throw new Error("selected integration profile is not available");
  }
  if (!isConfigGeneration(availability.configGeneration)) {
    throw new Error("availability config generation is invalid");
  }
  const expected = {
    profileVersionId: profile.profileVersionId,
    legalBundleVersion: profile.legalBundleVersion,
    runtimeContractId: profile.runtimeContractId,
    runtimeContractSha256: profile.runtimeContractSha256,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (availability[field] !== value) {
      throw new Error(`availability ${field} does not match selected ${profile.name} profile`);
    }
  }
  if (!sameDisclosure(availability.displayDisclosure, profile.displayDisclosure)) {
    throw new Error(`availability disclosure does not match selected ${profile.name} profile`);
  }
  return Object.freeze({
    schemaVersion: "expected_route_v1",
    configGeneration: availability.configGeneration,
    profileVersionId: availability.profileVersionId,
    legalBundleVersion: availability.legalBundleVersion,
    runtimeContractId: availability.runtimeContractId,
    runtimeContractSha256: availability.runtimeContractSha256,
  });
}

export function sameExpectedRouteV1(left, right) {
  return left?.schemaVersion === "expected_route_v1" &&
    right?.schemaVersion === "expected_route_v1" &&
    left.configGeneration === right.configGeneration &&
    left.profileVersionId === right.profileVersionId &&
    left.legalBundleVersion === right.legalBundleVersion &&
    left.runtimeContractId === right.runtimeContractId &&
    left.runtimeContractSha256 === right.runtimeContractSha256;
}

function sumKnown(rows, field) {
  const known = rows.filter((row) => Number.isSafeInteger(row[field]));
  return known.length === 0 ? null : known.reduce((sum, row) => sum + row[field], 0);
}

function deriveBillable(attempts) {
  if (attempts.some((attempt) => attempt.provider_billable === true)) return true;
  if (attempts.every((attempt) => attempt.provider_billable === false)) return false;
  return null;
}

export function deriveParentIncompleteFields(attempts) {
  const children = Array.isArray(attempts) ? attempts : [];
  const allUsageComplete = children.every(
    (attempt) => attempt.usage_observation_kind === "observed" && attempt.usage_complete === true,
  );
  const cacheWriteKnown = children.every(
    (attempt) => attempt.usage_observation_kind === "observed" && Number.isSafeInteger(attempt.input_cache_write_tokens),
  );
  const reasoningKnown = children.every(
    (attempt) => attempt.usage_observation_kind === "observed" && Number.isSafeInteger(attempt.reasoning_tokens),
  );
  const billable = deriveBillable(children);
  const estimatedIncomplete = children.some(
    (attempt) => attempt.provider_billable !== false && attempt.estimated_cost_nanos == null,
  );
  return Object.freeze([
    ...(allUsageComplete ? [] : ["attempt_usage"]),
    ...(cacheWriteKnown ? [] : ["input_cache_write"]),
    ...(reasoningKnown ? [] : ["reasoning"]),
    ...(billable === null ? ["provider_billable"] : []),
    ...(estimatedIncomplete ? ["estimated_cost"] : []),
  ]);
}

function hasExactStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    new Set(actual).size === actual.length && actual.every((value) => expected.includes(value));
}

function expectedCostReconciliation(attempts, estimatedIncomplete, estimated) {
  if (estimatedIncomplete) return "incomplete_usage";
  const applicable = attempts.filter((attempt) => attempt.provider_billable !== false);
  if (applicable.length === 0) return "not_available";
  const reported = applicable.filter((attempt) => Number.isSafeInteger(attempt.provider_reported_cost_nanos));
  if (reported.length === applicable.length) {
    const total = reported.reduce((sum, attempt) => sum + attempt.provider_reported_cost_nanos, 0);
    return total === estimated ? "matched" : "mismatch";
  }
  return reported.length > 0 ? "pending" : "not_available";
}

function push(issues, condition, code) {
  if (!condition) issues.push(code);
}

/** Validates one parent request and exactly its immutable child attempts. */
export function evaluateRequestLedgerEvidence(parent, attempts, profile = DEEPSEEK_INTEGRATION_PROFILE) {
  const issues = [];
  const children = Array.isArray(attempts) ? attempts : [];

  push(issues, parent?.state === "finalized", "parent_not_finalized");
  push(issues, parent?.route_schema_version === profile.routeSchemaVersion, "parent_route_schema_mismatch");
  push(issues, parent?.profile_version_id === profile.profileVersionId, "parent_profile_version_mismatch");
  push(issues, profile.priceVersionIds.includes(parent?.price_version_id), "parent_price_version_mismatch");
  push(issues, parent?.legal_bundle_version === profile.legalBundleVersion, "parent_legal_bundle_mismatch");
  push(issues, parent?.runtime_contract_id === profile.runtimeContractId, "parent_runtime_contract_mismatch");
  push(issues, parent?.runtime_contract_sha256 === profile.runtimeContractSha256, "parent_runtime_contract_hash_mismatch");
  push(issues, parent?.gateway_kind === profile.gatewayKind, "parent_gateway_mismatch");
  push(issues, parent?.wire_api_kind === profile.wireApiKind, "parent_wire_api_mismatch");
  push(issues, parent?.model_id === profile.modelId, "parent_model_mismatch");
  push(issues, parent?.display_disclosure_key === profile.displayDisclosure.key, "parent_disclosure_mismatch");
  push(issues, parent?.billing_currency === profile.billingCurrency, "parent_billing_currency_mismatch");
  push(issues, Number.isInteger(parent?.attempt_count), "parent_attempt_count_invalid");
  push(issues, children.length >= 1 && children.length <= 2, "child_count_out_of_range");
  push(issues, parent?.attempt_count === children.length, "parent_child_attempt_count_mismatch");

  const seenAttemptNos = new Set();
  children.forEach((attempt, index) => {
    const expectedAttemptNo = index + 1;
    push(issues, Number.isInteger(attempt.attempt_no), "attempt_no_invalid");
    push(issues, !seenAttemptNos.has(attempt.attempt_no), "attempt_no_duplicate");
    seenAttemptNos.add(attempt.attempt_no);
    push(issues, attempt.attempt_no === expectedAttemptNo, "attempt_no_gap_or_order");
    push(issues, TERMINAL_ATTEMPT_STATUSES.has(attempt.status), "attempt_not_terminal");
    push(issues, attempt.status === "unknown" ? attempt.transmitted === null : typeof attempt.transmitted === "boolean", "attempt_transmission_truth_invalid");
    push(issues, attempt.status !== "unknown" || attempt.provider_billable === null, "unknown_billability_not_preserved");
    push(issues, attempt.status !== "unknown" || (attempt.usage_observation_kind === "unavailable" && attempt.usage_complete === false), "unknown_usage_not_preserved");
    for (const field of PARENT_CHILD_ROUTE_FIELDS) {
      push(issues, same(attempt[field], parent?.[field]), `parent_child_${field}_mismatch`);
    }
    push(issues, attempt.profile_version_id === profile.profileVersionId, "attempt_profile_version_mismatch");
    push(issues, profile.priceVersionIds.includes(attempt.price_version_id), "attempt_price_version_mismatch");
    push(issues, attempt.gateway_kind === profile.gatewayKind, "attempt_gateway_mismatch");
    push(issues, attempt.wire_api_kind === profile.wireApiKind, "attempt_wire_api_mismatch");
    push(issues, attempt.model_id === profile.modelId, "attempt_model_mismatch");
    push(issues, attempt.endpoint_alias === profile.endpointAlias, "attempt_endpoint_alias_mismatch");
    push(issues, attempt.billing_currency === profile.billingCurrency, "attempt_billing_currency_mismatch");
    const routeObservationRequired = attempt.transmitted === true &&
      ROUTE_OBSERVATION_REQUIRED_STATUSES.has(attempt.status);
    if (routeObservationRequired) {
      const completeObservation = attempt.actual_upstream_endpoint !== null && attempt.actual_model_id !== null;
      push(issues, completeObservation, "attempt_route_observation_missing");
      push(issues, (attempt.actual_upstream_endpoint === null) === (attempt.actual_model_id === null), "attempt_route_observation_partial");
      if (completeObservation) {
        push(issues, isOfficialIntegrationEndpoint(profile, attempt.actual_upstream_endpoint), "attempt_endpoint_not_official");
        push(issues, attempt.actual_model_id === profile.modelId, "attempt_model_mismatch");
      }
    } else if (attempt.status === "unknown" || attempt.transmitted === false) {
      push(issues, attempt.actual_upstream_endpoint === null, "attempt_route_endpoint_not_cleared");
      push(issues, attempt.actual_model_id === null, "attempt_route_model_not_cleared");
    } else if (attempt.actual_upstream_endpoint !== null || attempt.actual_model_id !== null) {
      push(issues, attempt.actual_upstream_endpoint !== null && attempt.actual_model_id !== null, "attempt_route_observation_partial");
      push(issues, isOfficialIntegrationEndpoint(profile, attempt.actual_upstream_endpoint), "attempt_endpoint_not_official");
      push(issues, attempt.actual_model_id === profile.modelId, "attempt_model_mismatch");
    }
    push(issues, attempt.billing_currency === parent?.billing_currency, "billing_currency_mismatch");
    push(issues, attempt.estimated_currency == null || attempt.estimated_currency === parent?.billing_currency, "estimated_currency_mismatch");
    push(issues, attempt.provider_reported_currency == null || attempt.provider_reported_currency === parent?.billing_currency, "reported_currency_mismatch");
  });

  const derivedBillable = deriveBillable(children);
  push(issues, parent?.provider_billable === derivedBillable, "parent_billability_mismatch");
  const allUsageComplete = children.every(
    (attempt) => attempt.usage_observation_kind === "observed" && attempt.usage_complete === true,
  );
  push(issues, parent?.usage_complete === allUsageComplete, "parent_usage_complete_mismatch");
  const cached = children.reduce((sum, attempt) => sum + (Number.isSafeInteger(attempt.input_cache_read_tokens) ? attempt.input_cache_read_tokens : 0), 0);
  const uncached = children.reduce((sum, attempt) => sum + (Number.isSafeInteger(attempt.input_cache_write_tokens) ? attempt.input_cache_write_tokens : 0) + (Number.isSafeInteger(attempt.input_standard_tokens) ? attempt.input_standard_tokens : 0), 0);
  const output = children.reduce((sum, attempt) => sum + (Number.isSafeInteger(attempt.output_tokens) ? attempt.output_tokens : 0), 0);
  push(issues, parent?.input_cached_tokens === cached, "parent_cached_usage_mismatch");
  push(issues, parent?.input_uncached_tokens === uncached, "parent_uncached_usage_mismatch");
  push(issues, parent?.output_tokens === output, "parent_output_usage_mismatch");

  const knownEstimated = sumKnown(children, "estimated_cost_nanos");
  const estimatedIncomplete = children.some((attempt) => attempt.provider_billable !== false && attempt.estimated_cost_nanos == null);
  const expectedEstimated = estimatedIncomplete ? null : knownEstimated;
  push(issues, parent?.cost_basis === "frozen_price_version_v1", "parent_cost_basis_mismatch");
  push(issues, parent?.known_estimated_cost_nanos === knownEstimated, "parent_known_estimated_cost_mismatch");
  push(issues, parent?.estimated_cost_nanos === expectedEstimated, "parent_estimated_cost_mismatch");
  const applicable = children.filter((attempt) => attempt.provider_billable !== false);
  const reportedKnown = applicable.filter((attempt) => Number.isSafeInteger(attempt.provider_reported_cost_nanos));
  const expectedReported = applicable.length === 0 || reportedKnown.length !== applicable.length ? null : reportedKnown.reduce((sum, attempt) => sum + attempt.provider_reported_cost_nanos, 0);
  push(issues, parent?.provider_reported_cost_nanos === expectedReported, "parent_reported_cost_mismatch");
  push(issues, parent?.provider_reported_currency === (expectedReported == null ? null : parent?.billing_currency), "parent_reported_currency_mismatch");
  push(issues, parent?.cost_reconciliation_status === expectedCostReconciliation(children, estimatedIncomplete, expectedEstimated), "parent_cost_reconciliation_mismatch");
  const expectedIncomplete = deriveParentIncompleteFields(children);
  push(issues, hasExactStrings(parent?.incomplete_fields, expectedIncomplete), "parent_incomplete_fields_mismatch");

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze([...new Set(issues)]),
    transmissions: children.filter((attempt) => attempt.transmitted === true).length,
  });
}

export function evaluateRunLedgerEvidence(records, { profile = DEEPSEEK_INTEGRATION_PROFILE } = {}) {
  const result = (Array.isArray(records) ? records : []).map(({ parent, attempts }) =>
    evaluateRequestLedgerEvidence(parent, attempts, profile),
  );
  const transmissions = result.reduce((sum, entry) => sum + entry.transmissions, 0);
  return Object.freeze({
    ok: result.every((entry) => entry.ok) && isWithinTransmissionBudget(transmissions),
    transmissions,
    requestResults: Object.freeze(result),
  });
}
