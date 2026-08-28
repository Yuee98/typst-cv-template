/**
 * Pure evidence checks for the real-key integration harness.
 *
 * These helpers deliberately accept only bounded ledger metadata. Callers
 * must never pass provider bodies, credentials, prompt text, or polished text.
 */

export const DEEPSEEK_INTEGRATION_PROFILE = Object.freeze({
  name: "deepseek",
  profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
  profileVersionId: "11111111-1111-4111-8111-111111111111",
  routeSchemaVersion: "route_snapshot_v1",
  runtimeContractId: "runtime.deepseek-v2.v1",
  gatewayKind: "direct_deepseek",
  wireApiKind: "chat_completions_v1",
  endpointAlias: "deepseek_official",
  endpoint: "https://api.deepseek.com/chat/completions",
  modelId: "deepseek-v4-flash",
  credentialEnv: "DEEPSEEK_API_KEY",
});

const TERMINAL_ATTEMPT_STATUSES = new Set([
  "succeeded",
  "invalid_output",
  "failed_upstream",
  "timed_out",
  "canceled",
  "unknown",
]);

const PARENT_CHILD_ROUTE_FIELDS = [
  "route_schema_version",
  "config_generation",
  "routing_policy_version_id",
  "profile_version_id",
  "price_version_id",
  "legal_bundle_version",
  "runtime_contract_id",
  "runtime_contract_sha256",
  "gateway_kind",
  "model_id",
  "wire_api_kind",
  "display_disclosure_key",
];

/**
 * The public handler presently composes only the DeepSeek runtime-target
 * resolver. MiMo remains a dark draft until that composition authority is
 * widened and independently reviewed.
 */
export function resolveIntegrationProfile(name = "deepseek") {
  if (name === "deepseek") return DEEPSEEK_INTEGRATION_PROFILE;
  if (name === "mimo") {
    throw new Error(
      "MiMo integration smoke is fail-closed: handler runtime authority still admits only DeepSeek.",
    );
  }
  throw new Error(`unsupported integration profile: ${name}`);
}

/** Exact path check, intentionally stricter than an origin-only preflight. */
export function isOfficialDeepSeekChatCompletionsEndpoint(endpoint) {
  return endpoint === DEEPSEEK_INTEGRATION_PROFILE.endpoint;
}

export function isWithinTransmissionBudget(transmissions) {
  return Number.isInteger(transmissions) && transmissions >= 0 && transmissions <= 4;
}

function same(left, right) {
  return left === right;
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

/**
 * Validates one parent request and exactly its immutable child attempts.
 * The returned issue codes are safe to print because they contain no user or
 * provider payload values.
 */
export function evaluateRequestLedgerEvidence(
  parent,
  attempts,
  profile = DEEPSEEK_INTEGRATION_PROFILE,
  { requireOfficialEndpoint = true } = {},
) {
  const issues = [];
  const children = Array.isArray(attempts) ? attempts : [];
  const incomplete = new Set(Array.isArray(parent?.incomplete_fields) ? parent.incomplete_fields : []);

  push(issues, parent?.state === "finalized", "parent_not_finalized");
  push(issues, parent?.route_schema_version === profile.routeSchemaVersion, "parent_route_schema_mismatch");
  push(issues, parent?.profile_version_id === profile.profileVersionId, "parent_profile_version_mismatch");
  push(issues, parent?.runtime_contract_id === profile.runtimeContractId, "parent_runtime_contract_mismatch");
  push(issues, parent?.gateway_kind === profile.gatewayKind, "parent_gateway_mismatch");
  push(issues, parent?.wire_api_kind === profile.wireApiKind, "parent_wire_api_mismatch");
  push(issues, parent?.model_id === profile.modelId, "parent_model_mismatch");
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
    push(issues, attempt.gateway_kind === profile.gatewayKind, "attempt_gateway_mismatch");
    push(issues, attempt.wire_api_kind === profile.wireApiKind, "attempt_wire_api_mismatch");
    push(issues, attempt.model_id === profile.modelId && attempt.actual_model_id === profile.modelId, "attempt_model_mismatch");
    push(issues, attempt.endpoint_alias === profile.endpointAlias, "attempt_endpoint_alias_mismatch");
    push(
      issues,
      requireOfficialEndpoint
        ? isOfficialDeepSeekChatCompletionsEndpoint(attempt.actual_upstream_endpoint)
        : typeof attempt.actual_upstream_endpoint === "string" && attempt.actual_upstream_endpoint.length > 0,
      requireOfficialEndpoint ? "attempt_endpoint_not_official" : "attempt_endpoint_missing",
    );
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
  if (!allUsageComplete) push(issues, incomplete.has("attempt_usage"), "incomplete_attempt_usage_not_preserved");

  const cached = children.reduce(
    (sum, attempt) => sum + (Number.isSafeInteger(attempt.input_cache_read_tokens) ? attempt.input_cache_read_tokens : 0),
    0,
  );
  const uncached = children.reduce(
    (sum, attempt) => sum + (Number.isSafeInteger(attempt.input_cache_write_tokens) ? attempt.input_cache_write_tokens : 0) + (Number.isSafeInteger(attempt.input_standard_tokens) ? attempt.input_standard_tokens : 0),
    0,
  );
  const output = children.reduce(
    (sum, attempt) => sum + (Number.isSafeInteger(attempt.output_tokens) ? attempt.output_tokens : 0),
    0,
  );
  push(issues, parent?.input_cached_tokens === cached, "parent_cached_usage_mismatch");
  push(issues, parent?.input_uncached_tokens === uncached, "parent_uncached_usage_mismatch");
  push(issues, parent?.output_tokens === output, "parent_output_usage_mismatch");

  const knownEstimated = sumKnown(children, "estimated_cost_nanos");
  const estimatedIncomplete = children.some(
    (attempt) => attempt.provider_billable !== false && attempt.estimated_cost_nanos == null,
  );
  const expectedEstimated = estimatedIncomplete ? null : knownEstimated;
  push(issues, parent?.cost_basis === "frozen_price_version_v1", "parent_cost_basis_mismatch");
  push(issues, parent?.known_estimated_cost_nanos === knownEstimated, "parent_known_estimated_cost_mismatch");
  push(issues, parent?.estimated_cost_nanos === expectedEstimated, "parent_estimated_cost_mismatch");
  if (estimatedIncomplete) push(issues, incomplete.has("estimated_cost"), "incomplete_estimated_cost_not_preserved");

  const applicable = children.filter((attempt) => attempt.provider_billable !== false);
  const reportedKnown = applicable.filter((attempt) => Number.isSafeInteger(attempt.provider_reported_cost_nanos));
  const expectedReported =
    applicable.length === 0 || reportedKnown.length !== applicable.length
      ? null
      : reportedKnown.reduce((sum, attempt) => sum + attempt.provider_reported_cost_nanos, 0);
  push(issues, parent?.provider_reported_cost_nanos === expectedReported, "parent_reported_cost_mismatch");
  push(issues, parent?.provider_reported_currency === (expectedReported == null ? null : parent?.billing_currency), "parent_reported_currency_mismatch");
  push(
    issues,
    parent?.cost_reconciliation_status === expectedCostReconciliation(children, estimatedIncomplete, expectedEstimated),
    "parent_cost_reconciliation_mismatch",
  );

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze([...new Set(issues)]),
    transmissions: children.filter((attempt) => attempt.transmitted === true).length,
  });
}

export function evaluateRunLedgerEvidence(records, { profile = DEEPSEEK_INTEGRATION_PROFILE, officialProof = true } = {}) {
  const result = (Array.isArray(records) ? records : []).map(({ parent, attempts }) =>
    evaluateRequestLedgerEvidence(parent, attempts, profile, { requireOfficialEndpoint: officialProof }),
  );
  const transmissions = result.reduce((sum, entry) => sum + entry.transmissions, 0);
  return Object.freeze({
    ok: officialProof && result.every((entry) => entry.ok) && isWithinTransmissionBudget(transmissions),
    officialProof,
    transmissions,
    requestResults: Object.freeze(result),
  });
}
