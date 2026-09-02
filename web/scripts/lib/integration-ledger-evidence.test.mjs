import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  ATTEMPT_EVIDENCE_FIELDS,
  buildExpectedRouteV1,
  DEEPSEEK_INTEGRATION_PROFILE,
  deriveParentIncompleteFields,
  evaluateRequestLedgerEvidence,
  evaluateRunLedgerEvidence,
  isOfficialIntegrationEndpoint,
  isWithinTransmissionBudget,
  MIMO_INTEGRATION_PROFILE,
  resolveIntegrationProfile,
  sameExpectedRouteV1,
} from "./integration-ledger-evidence.mjs";

function availability(profile, overrides = {}) {
  return {
    enabled: true,
    configGeneration: "7",
    routingPolicyVersionId: "33333333-3333-4333-8333-333333333333",
    profileVersionId: profile.profileVersionId,
    legalBundleVersion: profile.legalBundleVersion,
    runtimeContractId: profile.runtimeContractId,
    displayDisclosure: { ...profile.displayDisclosure },
    termsAccepted: false,
    ...overrides,
  };
}

function attempt(profile = DEEPSEEK_INTEGRATION_PROFILE, overrides = {}) {
  return {
    attempt_no: 1,
    route_schema_version: profile.routeSchemaVersion,
    config_generation: 7,
    routing_policy_version_id: "policy-1",
    profile_version_id: profile.profileVersionId,
    price_version_id: profile.priceVersionIds[0],
    legal_bundle_version: profile.legalBundleVersion,
    runtime_contract_id: profile.runtimeContractId,
    gateway_kind: profile.gatewayKind,
    model_id: profile.modelId,
    wire_api_kind: profile.wireApiKind,
    display_disclosure_key: profile.displayDisclosure.key,
    endpoint_alias: profile.endpointAlias,
    actual_upstream_endpoint: profile.endpoint,
    actual_model_id: profile.modelId,
    status: "succeeded",
    failure_stage: null,
    transmitted: true,
    provider_billable: true,
    usage_observation_kind: "observed",
    usage_complete: true,
    input_cache_read_tokens: 2,
    input_cache_write_tokens: 3,
    input_standard_tokens: 5,
    output_tokens: 7,
    reasoning_tokens: 0,
    billing_currency: profile.billingCurrency,
    estimated_currency: profile.billingCurrency,
    estimated_cost_nanos: 17,
    provider_reported_currency: profile.billingCurrency,
    provider_reported_cost_nanos: 17,
    ...overrides,
  };
}

function parent(profile, rows, overrides = {}) {
  const knownEstimatedRows = rows.filter((row) => Number.isSafeInteger(row.estimated_cost_nanos));
  const knownEstimated = knownEstimatedRows.length === 0
    ? null
    : knownEstimatedRows.reduce((sum, row) => sum + row.estimated_cost_nanos, 0);
  const estimatedIncomplete = rows.some(
    (row) => row.provider_billable !== false && row.estimated_cost_nanos == null,
  );
  const billable = rows.some((row) => row.provider_billable === true)
    ? true
    : rows.every((row) => row.provider_billable === false)
      ? false
      : null;
  const applicable = rows.filter((row) => row.provider_billable !== false);
  const reported = applicable.length > 0 && applicable.every((row) => row.provider_reported_cost_nanos != null)
    ? applicable.reduce((sum, row) => sum + row.provider_reported_cost_nanos, 0)
    : null;
  return {
    state: "finalized",
    attempt_count: rows.length,
    route_schema_version: profile.routeSchemaVersion,
    config_generation: 7,
    routing_policy_version_id: "policy-1",
    profile_version_id: profile.profileVersionId,
    price_version_id: profile.priceVersionIds[0],
    legal_bundle_version: profile.legalBundleVersion,
    runtime_contract_id: profile.runtimeContractId,
    gateway_kind: profile.gatewayKind,
    model_id: profile.modelId,
    wire_api_kind: profile.wireApiKind,
    display_disclosure_key: profile.displayDisclosure.key,
    provider_billable: billable,
    usage_complete: rows.every((row) => row.usage_observation_kind === "observed" && row.usage_complete === true),
    input_cached_tokens: rows.reduce((sum, row) => sum + (row.input_cache_read_tokens ?? 0), 0),
    input_uncached_tokens: rows.reduce((sum, row) => sum + (row.input_cache_write_tokens ?? 0) + (row.input_standard_tokens ?? 0), 0),
    output_tokens: rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
    failure_stage: rows.at(-1)?.failure_stage ?? null,
    incomplete_fields: deriveParentIncompleteFields(rows),
    billing_currency: profile.billingCurrency,
    cost_basis: "frozen_price_version_v1",
    known_estimated_cost_nanos: knownEstimated,
    estimated_cost_nanos: estimatedIncomplete ? null : knownEstimated,
    provider_reported_currency: reported == null ? null : profile.billingCurrency,
    provider_reported_cost_nanos: reported,
    cost_reconciliation_status: estimatedIncomplete ? "incomplete_usage" : reported == null ? "not_available" : reported === knownEstimated ? "matched" : "mismatch",
    ...overrides,
  };
}

describe("integration ledger evidence", () => {
  it("resolves exactly the two supported profiles without fallback", () => {
    expect(resolveIntegrationProfile("deepseek")).toBe(DEEPSEEK_INTEGRATION_PROFILE);
    expect(resolveIntegrationProfile("mimo")).toBe(MIMO_INTEGRATION_PROFILE);
    expect(() => resolveIntegrationProfile("openrouter")).toThrow(/unsupported/i);
    for (const inheritedName of ["__proto__", "toString", "constructor"]) {
      expect(() => resolveIntegrationProfile(inheritedName)).toThrow(/unsupported/i);
    }
  });

  it("accepts only each profile's exact official endpoint", () => {
    for (const profile of [DEEPSEEK_INTEGRATION_PROFILE, MIMO_INTEGRATION_PROFILE]) {
      expect(isOfficialIntegrationEndpoint(profile, profile.endpoint)).toBe(true);
      expect(isOfficialIntegrationEndpoint(profile, `${profile.endpoint}/`)).toBe(false);
      expect(isOfficialIntegrationEndpoint(profile, "https://diagnostic.internal/v1/responses")).toBe(false);
    }
    expect(isOfficialIntegrationEndpoint(DEEPSEEK_INTEGRATION_PROFILE, MIMO_INTEGRATION_PROFILE.endpoint)).toBe(false);
    expect(isOfficialIntegrationEndpoint(MIMO_INTEGRATION_PROFILE, DEEPSEEK_INTEGRATION_PROFILE.endpoint)).toBe(false);
  });

  it("derives a strict expected_route_v1 only from the selected availability candidate", () => {
    const candidate = availability(MIMO_INTEGRATION_PROFILE);
    const expected = buildExpectedRouteV1(candidate, MIMO_INTEGRATION_PROFILE);
    expect(expected).toEqual({
      schemaVersion: "expected_route_v1",
      configGeneration: "7",
      profileVersionId: MIMO_INTEGRATION_PROFILE.profileVersionId,
      legalBundleVersion: MIMO_INTEGRATION_PROFILE.legalBundleVersion,
      runtimeContractId: MIMO_INTEGRATION_PROFILE.runtimeContractId,
    });
    expect(Object.isFrozen(expected)).toBe(true);
    expect(sameExpectedRouteV1(expected, buildExpectedRouteV1(candidate, MIMO_INTEGRATION_PROFILE))).toBe(true);
    expect(sameExpectedRouteV1(expected, { ...expected, configGeneration: "8" })).toBe(false);
  });

  it("rejects disabled, malformed, crossed, and differently-disclosed availability", () => {
    const profile = MIMO_INTEGRATION_PROFILE;
    const cases = [
      availability(profile, { enabled: false }),
      availability(profile, { configGeneration: "07" }),
      availability(profile, { profileVersionId: DEEPSEEK_INTEGRATION_PROFILE.profileVersionId }),
      availability(profile, { runtimeContractId: DEEPSEEK_INTEGRATION_PROFILE.runtimeContractId }),
      availability(profile, { displayDisclosure: DEEPSEEK_INTEGRATION_PROFILE.displayDisclosure }),
    ];
    for (const candidate of cases) {
      expect(() => buildExpectedRouteV1(candidate, profile)).toThrow();
    }
  });

  it("enforces the 0..4 transmitted-run budget and rejects 5", () => {
    expect([0, 1, 2, 3, 4].every(isWithinTransmissionBudget)).toBe(true);
    expect(isWithinTransmissionBudget(5)).toBe(false);
    expect(evaluateRequestLedgerEvidence(parent(DEEPSEEK_INTEGRATION_PROFILE, []), []).issues).toContain("child_count_out_of_range");
  });

  it("accepts the complete frozen identity for either selected profile", () => {
    for (const profile of [DEEPSEEK_INTEGRATION_PROFILE, MIMO_INTEGRATION_PROFILE]) {
      const row = attempt(profile);
      expect(evaluateRequestLedgerEvidence(parent(profile, [row]), [row], profile)).toEqual(
        expect.objectContaining({ ok: true, transmissions: 1 }),
      );
    }
  });

  it("rejects gaps and duplicates while accepting a false pre-entry transmission", () => {
    const profile = DEEPSEEK_INTEGRATION_PROFILE;
    const preEntry = attempt(profile, {
      status: "failed_upstream", transmitted: false, provider_billable: false,
      usage_observation_kind: "unavailable", usage_complete: false,
      input_cache_read_tokens: null, input_cache_write_tokens: null, input_standard_tokens: null,
      output_tokens: null, reasoning_tokens: null, actual_upstream_endpoint: null, actual_model_id: null,
      estimated_cost_nanos: null, estimated_currency: null, provider_reported_cost_nanos: null,
      provider_reported_currency: null,
    });
    expect(evaluateRequestLedgerEvidence(parent(profile, [preEntry]), [preEntry], profile).ok).toBe(true);
    const gap = attempt(profile, { attempt_no: 2 });
    expect(evaluateRequestLedgerEvidence(parent(profile, [gap]), [gap], profile).issues).toContain("attempt_no_gap_or_order");
    const duplicate = [attempt(profile), attempt(profile, { attempt_no: 1, status: "failed_upstream", transmitted: false, provider_billable: false, usage_observation_kind: "unavailable", usage_complete: false, input_cache_read_tokens: null, input_cache_write_tokens: null, input_standard_tokens: null, output_tokens: null, reasoning_tokens: null, actual_upstream_endpoint: null, actual_model_id: null, estimated_cost_nanos: null, estimated_currency: null, provider_reported_cost_nanos: null, provider_reported_currency: null })];
    expect(evaluateRequestLedgerEvidence(parent(profile, duplicate), duplicate, profile).issues).toContain("attempt_no_duplicate");
  });

  it("rejects null transmission on known terminal outcomes while preserving unknown cancellation facts", () => {
    const profile = DEEPSEEK_INTEGRATION_PROFILE;
    const nullTransmission = attempt(profile, { transmitted: null });
    expect(evaluateRequestLedgerEvidence(parent(profile, [nullTransmission]), [nullTransmission], profile).issues).toContain("attempt_transmission_truth_invalid");
    const unknown = attempt(profile, {
      status: "unknown", transmitted: null, provider_billable: null,
      usage_observation_kind: "unavailable", usage_complete: false,
      input_cache_read_tokens: null, input_cache_write_tokens: null, input_standard_tokens: null,
      output_tokens: null, reasoning_tokens: null, actual_upstream_endpoint: null, actual_model_id: null,
      estimated_currency: null, estimated_cost_nanos: null, provider_reported_currency: null,
      provider_reported_cost_nanos: null,
    });
    expect(evaluateRequestLedgerEvidence(parent(profile, [unknown]), [unknown], profile).ok).toBe(true);
    expect(deriveParentIncompleteFields([unknown])).toEqual([
      "attempt_usage", "input_cache_write", "reasoning", "provider_billable", "estimated_cost",
    ]);
    for (const marker of deriveParentIncompleteFields([unknown])) {
      const missing = parent(profile, [unknown], {
        incomplete_fields: deriveParentIncompleteFields([unknown]).filter((value) => value !== marker),
      });
      expect(evaluateRequestLedgerEvidence(missing, [unknown], profile).issues).toContain("parent_incomplete_fields_mismatch");
    }
  });

  it("rejects crossed profile, price, runtime, gateway, wire, model, currency and endpoint facts", () => {
    const profile = MIMO_INTEGRATION_PROFILE;
    const checks = [
      ["profile", { profile_version_id: DEEPSEEK_INTEGRATION_PROFILE.profileVersionId }, "attempt_profile_version_mismatch"],
      ["price", { price_version_id: DEEPSEEK_INTEGRATION_PROFILE.priceVersionIds[0] }, "attempt_price_version_mismatch"],
      ["runtime", { runtime_contract_id: DEEPSEEK_INTEGRATION_PROFILE.runtimeContractId }, "parent_child_runtime_contract_id_mismatch"],
      ["gateway", { gateway_kind: DEEPSEEK_INTEGRATION_PROFILE.gatewayKind }, "attempt_gateway_mismatch"],
      ["wire", { wire_api_kind: DEEPSEEK_INTEGRATION_PROFILE.wireApiKind }, "attempt_wire_api_mismatch"],
      ["model", { model_id: DEEPSEEK_INTEGRATION_PROFILE.modelId, actual_model_id: DEEPSEEK_INTEGRATION_PROFILE.modelId }, "attempt_model_mismatch"],
      ["currency", { billing_currency: "USD", estimated_currency: "USD", provider_reported_currency: "USD" }, "attempt_billing_currency_mismatch"],
      ["endpoint", { actual_upstream_endpoint: DEEPSEEK_INTEGRATION_PROFILE.endpoint }, "attempt_endpoint_not_official"],
    ];
    for (const [, overrides, expectedIssue] of checks) {
      const child = attempt(profile, overrides);
      const result = evaluateRequestLedgerEvidence(parent(profile, [child]), [child], profile);
      expect(result.issues).toContain(expectedIssue);
    }
    const partialRoute = attempt(profile, { actual_model_id: null });
    expect(evaluateRequestLedgerEvidence(parent(profile, [partialRoute]), [partialRoute], profile).issues).toContain("attempt_route_observation_partial");
    const wrongParentPrice = parent(profile, [attempt(profile)], { price_version_id: DEEPSEEK_INTEGRATION_PROFILE.priceVersionIds[0] });
    expect(evaluateRequestLedgerEvidence(wrongParentPrice, [attempt(profile)], profile).issues).toContain("parent_price_version_mismatch");
  });

  it("preserves cancellation unknowns and clears stale route observations", () => {
    const profile = DEEPSEEK_INTEGRATION_PROFILE;
    const canceled = attempt(profile, {
      status: "canceled", transmitted: true, actual_upstream_endpoint: null, actual_model_id: null,
      failure_stage: "transport",
      provider_billable: null, usage_observation_kind: "unavailable", usage_complete: false,
      input_cache_read_tokens: null, input_cache_write_tokens: null, input_standard_tokens: null,
      output_tokens: null, reasoning_tokens: null, estimated_currency: null, estimated_cost_nanos: null,
      provider_reported_currency: null, provider_reported_cost_nanos: null,
    });
    expect(evaluateRequestLedgerEvidence(parent(profile, [canceled]), [canceled], profile).ok).toBe(true);
    expect(
      evaluateRequestLedgerEvidence(
        parent(profile, [canceled], { failure_stage: "canceled" }),
        [canceled],
        profile,
      ).issues,
    ).toContain("parent_failure_stage_mismatch");
    const unknown = { ...canceled, status: "unknown", transmitted: null, actual_upstream_endpoint: profile.endpoint, actual_model_id: profile.modelId };
    expect(evaluateRequestLedgerEvidence(parent(profile, [unknown]), [unknown], profile).issues).toEqual(
      expect.arrayContaining(["attempt_route_endpoint_not_cleared", "attempt_route_model_not_cleared"]),
    );
  });

  it("uses the final ordered attempt as the parent failure-stage authority", () => {
    const profile = DEEPSEEK_INTEGRATION_PROFILE;
    const first = attempt(profile, {
      status: "failed_upstream", failure_stage: "transport", transmitted: false,
      provider_billable: false, usage_observation_kind: "unavailable", usage_complete: false,
      input_cache_read_tokens: null, input_cache_write_tokens: null, input_standard_tokens: null,
      output_tokens: null, reasoning_tokens: null, actual_upstream_endpoint: null, actual_model_id: null,
      estimated_currency: null, estimated_cost_nanos: null, provider_reported_currency: null,
      provider_reported_cost_nanos: null,
    });
    const second = attempt(profile, { attempt_no: 2, failure_stage: null });
    const rows = [first, second];
    const canonicalParent = parent(profile, rows);

    expect(evaluateRequestLedgerEvidence(canonicalParent, rows, profile).ok).toBe(true);
    expect(
      evaluateRequestLedgerEvidence(
        { ...canonicalParent, failure_stage: first.failure_stage },
        rows,
        profile,
      ).issues,
    ).toContain("parent_failure_stage_mismatch");
    expect(evaluateRequestLedgerEvidence(canonicalParent, [...rows].reverse(), profile).issues).toEqual(
      expect.arrayContaining(["attempt_no_gap_or_order", "parent_failure_stage_mismatch"]),
    );
  });

  it("requires complete route observations for transmitted terminal provider outcomes", () => {
    const profile = MIMO_INTEGRATION_PROFILE;
    for (const status of ["succeeded", "invalid_output", "failed_upstream", "timed_out"]) {
      const bothNull = attempt(profile, {
        status, actual_upstream_endpoint: null, actual_model_id: null,
      });
      const issues = evaluateRequestLedgerEvidence(parent(profile, [bothNull]), [bothNull], profile).issues;
      expect(issues).toContain("attempt_route_observation_missing");
      expect(issues).not.toContain("attempt_route_observation_partial");
    }
    const partial = attempt(profile, { actual_upstream_endpoint: null });
    expect(evaluateRequestLedgerEvidence(parent(profile, [partial]), [partial], profile).issues).toEqual(
      expect.arrayContaining(["attempt_route_observation_missing", "attempt_route_observation_partial"]),
    );
    const crossed = attempt(profile, {
      actual_upstream_endpoint: DEEPSEEK_INTEGRATION_PROFILE.endpoint,
      actual_model_id: DEEPSEEK_INTEGRATION_PROFILE.modelId,
    });
    expect(evaluateRequestLedgerEvidence(parent(profile, [crossed]), [crossed], profile).issues).toEqual(
      expect.arrayContaining(["attempt_endpoint_not_official", "attempt_model_mismatch"]),
    );
  });

  it("requires every derived incomplete marker and rejects contradictory currency aggregation", () => {
    const profile = DEEPSEEK_INTEGRATION_PROFILE;
    const incomplete = attempt(profile, {
      estimated_cost_nanos: null, estimated_currency: null,
      provider_reported_cost_nanos: null, provider_reported_currency: null,
    });
    const expected = deriveParentIncompleteFields([incomplete]);
    expect(expected).toEqual(["estimated_cost"]);
    for (const marker of expected) {
      const missing = parent(profile, [incomplete], {
        incomplete_fields: expected.filter((value) => value !== marker),
      });
      expect(evaluateRequestLedgerEvidence(missing, [incomplete], profile).issues).toContain("parent_incomplete_fields_mismatch");
    }
    const contradictory = parent(profile, [attempt(profile)], { incomplete_fields: ["attempt_usage"] });
    expect(evaluateRequestLedgerEvidence(contradictory, [attempt(profile)], profile).issues).toContain("parent_incomplete_fields_mismatch");
    const mixedCurrency = attempt(profile, { estimated_currency: "USD" });
    expect(evaluateRequestLedgerEvidence(parent(profile, [mixedCurrency]), [mixedCurrency], profile).issues).toContain("estimated_currency_mismatch");
  });

  it("rejects custom upstreams in the run verdict", () => {
    const row = attempt(MIMO_INTEGRATION_PROFILE, { actual_upstream_endpoint: "https://proxy.example/v1/responses" });
    const result = evaluateRunLedgerEvidence([{ parent: parent(MIMO_INTEGRATION_PROFILE, [row]), attempts: [row] }], { profile: MIMO_INTEGRATION_PROFILE });
    expect(result.ok).toBe(false);
    expect(result.requestResults[0].issues).toContain("attempt_endpoint_not_official");
  });

  it("keeps the harness route assertion on every real request and never prints buffered server output", () => {
    const source = readFileSync(new URL("../run-integration-tests.mjs", import.meta.url), "utf8");
    expect(source).toContain("expectedRoute,");
    expect(source.match(/makePolishBody\(/g)).toHaveLength(4);
    expect(source).toContain("getAuthenticatedAvailability(accessToken, expectedRoute)");
    expect(source).toContain("makeCancellationPolishBody(cancelClientRequestId, expectedRoute)");
    expect(source).toContain('granularity: "section"');
    expect(source).toContain("const CANCELLATION_ABORT_DELAY_MS = 750;");
    expect(source).not.toContain("serverOutput.join");
    expect(source).not.toContain("featureConfigRestore");
    expect(source).not.toContain(".update({ ai_polish_enabled: true })");
    expect(source).not.toContain("flips runtime config");
  });

  it("keeps every evidence-consumed attempt field in the harness query and clears ambient upstream URLs", () => {
    const source = readFileSync(new URL("../run-integration-tests.mjs", import.meta.url), "utf8");
    const selection = /const ATTEMPT_LEDGER_SELECT = \[([\s\S]*?)\]\.join\(/.exec(source)?.[1] ?? "";
    const selected = new Set([...selection.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
    expect(ATTEMPT_EVIDENCE_FIELDS.filter((field) => !selected.has(field))).toEqual([]);
    expect(source).toContain('"reasoning_tokens"');
    expect(source).toContain('.order("attempt_no", { ascending: true })');
    expect(source).toContain("UPSTREAM_URL_ENV_NAMES");
    expect(source).toContain("for (const name of UPSTREAM_URL_ENV_NAMES) env[name] = \"\";");
    expect(source).toContain('integrationProfile.name !== "deepseek" && deepseekBaseUrl');
  });

  it("runs installed build and Supabase tools directly without invoking a package manager", () => {
    const source = readFileSync(new URL("../run-integration-tests.mjs", import.meta.url), "utf8");
    expect(source).toContain('const supabaseCli = path.join(repoRoot, "node_modules", "supabase", "dist", "supabase.js");');
    expect(source).toContain('spawnSync(process.execPath, [supabaseCli, "status", "-o", "env"]');
    expect(source).toContain("spawnSync(process.execPath, [syncTypstAssetsScript]");
    expect(source).toContain('spawnSync(process.execPath, [runNextModeScript, "build", "server"]');
    expect(source).not.toContain('spawnSync("pnpm');
    expect(source).not.toContain("shell: true");
    const syncIndex = source.indexOf("const syncAssets = spawnSync");
    const buildIndex = source.indexOf("const build = spawnSync");
    expect(syncIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(syncIndex);
    expect(source).toContain("syncAssets.error || syncAssets.status !== 0");
    expect(source).toContain("build.error || build.status !== 0");
    expect(source).toContain("reuseBuild && existsSync(buildId) && existsSync(polishRoute)");
  });

  it("bounds ordinary availability and polish HTTP calls while preserving caller cancellation", () => {
    const source = readFileSync(new URL("../run-integration-tests.mjs", import.meta.url), "utf8");
    expect(source).toContain("const AVAILABILITY_TIMEOUT_MS = 10_000;");
    expect(source).toContain("const POLISH_REQUEST_TIMEOUT_MS = 75_000;");
    expect(source).toContain("const availabilitySignal = AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS)");
    expect(source).toContain("const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline");
    expect(source).toContain("readJsonOrNull(response, requestSignal)");
    expect(source).toContain("readJsonOrNull(response, availabilitySignal)");
    expect(source).not.toContain("response.json().catch(() => null)");
  });

  it("preserves cancellation attribution and stops uncertain work before user cleanup", () => {
    const source = readFileSync(new URL("../run-integration-tests.mjs", import.meta.url), "utf8");
    expect(source).toContain("const CANCELLATION_SETTLEMENT_TIMEOUT_MS = 60_000;");
    expect(source).toContain("observeAbortableRequest(");
    expect(source).toContain('cancelOutcome.kind === "aborted" && cancelOutcome.error === cancellationReason');
    expect(source).toContain('"cancel ledger: failure_stage=transport"');
    expect(source).toContain('cancelRow.failure_stage === "transport"');
    expect(source).not.toContain('"cancel ledger: failure_stage=canceled"');
    expect(source).not.toContain('.catch(() => ({ aborted: true }))');

    const guardedStop = source.indexOf("if (stopServerBeforeUserCleanup && server !== null)");
    const userDeletion = source.indexOf("service.auth.admin.deleteUser(userId)");
    expect(guardedStop).toBeGreaterThan(-1);
    expect(userDeletion).toBeGreaterThan(guardedStop);
  });
});
