import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import fixture from "../../../test/fixtures/ai-runtime-execution-contract-v1.json";
import profileV2Fixture from "../../../test/fixtures/profile-execution-v2.json";
import { resolveEndpoint } from "./adapter-registry";
import { parseRouteSnapshotV1, type ExpectedRouteV1 } from "./lifecycle-v2-contract";
import type { PolishAttemptCompletedFactV2 } from "./orchestrator";
import { resolveProfile } from "./profile-registry";
import { validateProfileExecutionConfigV2 } from "./profile-execution-v2";
import {
  completePolishProviderAttemptV2,
  finalizePolishRequestV2,
  getPolishExecutionSnapshotV1,
  getPolishExecutionSnapshotV2,
  POLISH_ATTEMPT_FAILURE_STAGES_V2,
  PolishLifecycleV2RpcError,
  recordPolishRequestCancellationV2,
  reservePolishRequestV2,
  serializePolishAttemptCompletionV2,
  serializePolishFinalizeV2,
  startPolishProviderAttemptV2,
  type PolishFinalizeMetadataV2,
  type ProviderAttemptStartV2,
} from "./quota";
import { POLISH_VALIDATION_FAILURE_STAGES } from "./validate";

type RpcReply = Readonly<{
  data: unknown;
  error?: Readonly<{ message: string }> | null;
}>;
type RpcStep = RpcReply | Error;

function sequenceClient(...initialSteps: RpcStep[]) {
  const steps = [...initialSteps];
  const rpc = vi.fn(async (functionName: string, args: unknown) => {
    void functionName;
    void args;
    const step = steps.shift();
    if (step === undefined) throw new Error("unexpected extra RPC call");
    if (step instanceof Error) throw step;
    return { error: null, ...step };
  });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

async function capturedError(promise: Promise<unknown>): Promise<PolishLifecycleV2RpcError> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PolishLifecycleV2RpcError);
  return error as PolishLifecycleV2RpcError;
}

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const CLIENT_REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const ATTEMPT_ID = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const executionSuccess = structuredClone(fixture.executionSnapshot.successes[0].value);
const RESERVATION_ID = executionSuccess.reservationId;
const ROUTE = parseRouteSnapshotV1(executionSuccess.routeSnapshot);
const PROFILE = resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1");
const PROFILE_V2 = validateProfileExecutionConfigV2({
  ...profileV2Fixture.deepseek,
  legalManifestId: PROFILE.legalManifestId,
  displayDisclosureKey: ROUTE.displayDisclosureKey,
});
const ROUTE_V2 = parseRouteSnapshotV1({
  ...ROUTE,
  modelId: PROFILE_V2.modelId,
});
const RUNTIME_EVIDENCE_V2 = Object.freeze({
  schemaVersion: "runtime_execution_evidence_v2",
  runtimeContractId: ROUTE_V2.runtimeContractId,
  runtimeTargetId: "runtime-target.deepseek-v2.test",
  runtimeTargetSha256:
    "1000000000000000000000000000000000000000000000000000000000000000",
  routeDescriptorId: "route-descriptor.deepseek-v2.test",
  routeDescriptorSha256:
    "2000000000000000000000000000000000000000000000000000000000000000",
  profileVersionId: ROUTE_V2.profileVersionId,
  priceVersionId: ROUTE_V2.priceVersionId,
  providerId: PROFILE_V2.providerId,
  recipientKey: "deepseek",
  codeCapabilityId: "runtime-capability.deepseek-chat-v1.2026-09-04",
  codeCapabilitySha256:
    "4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2",
  gatewayKind: PROFILE_V2.gatewayKind,
  adapterKind: PROFILE_V2.adapterKind,
  wireApiKind: PROFILE_V2.wireApiKind,
  endpointUrl: PROFILE_V2.endpointUrl,
  credentialEnvName: PROFILE_V2.credentialEnvName,
  modelId: PROFILE_V2.modelId,
  capabilityContractId: PROFILE_V2.capabilityContractId,
  cachePolicyId: PROFILE_V2.cachePolicyId,
  calculatorKind: PROFILE_V2.calculatorKind,
  legalBundleVersion: ROUTE_V2.legalBundleVersion,
  legalManifestId: PROFILE_V2.legalManifestId,
  legalManifestSha256:
    "3000000000000000000000000000000000000000000000000000000000000000",
  displayDisclosureKey: ROUTE_V2.displayDisclosureKey,
  externalEvidenceIds: ["evidence.deepseek-v2.test"],
});
const validationCheckedAt = new Date();
const RUNTIME_DEPLOYMENT_VALIDATION_V1 = Object.freeze({
  schemaVersion: "runtime_deployment_validation_v1",
  reportId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
  reviewedDeploymentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
  environment: "local",
  projectRef: "local",
  runtimeBuildId: "local-test-build",
  bindingManifestRevision: "local-test-manifest",
  bindingManifestSha256: "4".repeat(64),
  runtimeContractId: RUNTIME_EVIDENCE_V2.runtimeContractId,
  runtimeTargetId: RUNTIME_EVIDENCE_V2.runtimeTargetId,
  runtimeTargetSha256: RUNTIME_EVIDENCE_V2.runtimeTargetSha256,
  profileVersionId: RUNTIME_EVIDENCE_V2.profileVersionId,
  priceVersionId: RUNTIME_EVIDENCE_V2.priceVersionId,
  providerId: RUNTIME_EVIDENCE_V2.providerId,
  codeCapabilityId: RUNTIME_EVIDENCE_V2.codeCapabilityId,
  codeCapabilitySha256: RUNTIME_EVIDENCE_V2.codeCapabilitySha256,
  legalBundleVersion: RUNTIME_EVIDENCE_V2.legalBundleVersion,
  legalManifestId: RUNTIME_EVIDENCE_V2.legalManifestId,
  displayDisclosureKey: RUNTIME_EVIDENCE_V2.displayDisclosureKey,
  checkedAt: validationCheckedAt.toISOString(),
  expiresAt: new Date(
    validationCheckedAt.getTime() + 10 * 60_000,
  ).toISOString(),
  reportSha256: "5".repeat(64),
});
const executionSuccessV2 = Object.freeze({
  ...executionSuccess,
  schemaVersion: "ai_polish_execution_snapshot_v2",
  routeSnapshot: ROUTE_V2,
  profileExecutionConfig: PROFILE_V2,
  runtimeEvidence: RUNTIME_EVIDENCE_V2,
  deploymentValidation: RUNTIME_DEPLOYMENT_VALIDATION_V1,
});
const MIMO_PROFILE = resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1");
const DEEPSEEK_ENDPOINT = resolveEndpoint(PROFILE.endpointAlias).url;
const EXPECTED_ROUTE: ExpectedRouteV1 = Object.freeze({
  schemaVersion: "expected_route_v1",
  configGeneration: ROUTE.configGeneration,
  profileVersionId: ROUTE.profileVersionId,
  legalBundleVersion: ROUTE.legalBundleVersion,
  runtimeContractId: ROUTE.runtimeContractId,
});
const FINALIZE_METADATA: PolishFinalizeMetadataV2 = Object.freeze({
  granularity: "group",
  itemCount: 2,
  contextLevel: 1,
  language: "zh",
  promptVersion: "2026-08-prompt-v1",
  validatorVersion: "2026-08-validator-v1",
});

const FAILURE_STAGE_CONSTRAINT_MIGRATION_URL = new URL(
  "../../../../supabase/migrations/20260824009000_expand_ai_request_failure_stage_v2.sql",
  import.meta.url,
);

const LEGACY_REQUEST_FAILURE_STAGES = Object.freeze([
  "terms",
  "quota",
  "request_validation",
  "provider_http",
  "provider_timeout",
  "json_parse",
  "schema_validation",
  "semantic_validation",
  "canceled",
]);

function requestLedgerFailureStagesFromMigration(): readonly string[] {
  const source = readFileSync(FAILURE_STAGE_CONSTRAINT_MIGRATION_URL, "utf8");
  const check = source.match(
    /add\s+constraint\s+ai_request_ledger_failure_stage_check\s+check\s*\(\s*failure_stage\s+in\s*\(([\s\S]*?)\)\s*\)\s*;/iu,
  );
  if (!check?.[1]) throw new Error("missing ai_request_ledger failure-stage check");
  return [...check[1].matchAll(/'([^']+)'/gu)].map((match) => match[1] ?? "");
}

function reserveSuccess() {
  return {
    allowed: true,
    reservationId: RESERVATION_ID,
    limit: 20,
    remaining: 19,
    resetAt: "2026-08-25T16:00:00.000Z",
    routeSnapshot: ROUTE,
  };
}

function attemptStart(
  overrides: Partial<ProviderAttemptStartV2> = {},
): ProviderAttemptStartV2 {
  return {
    ok: true,
    attemptId: ATTEMPT_ID,
    attemptNo: 1,
    alreadyStarted: false,
    status: "started",
    routeSnapshot: ROUTE,
    ...overrides,
  };
}

function completedFact(
  overrides: Partial<PolishAttemptCompletedFactV2> = {},
): PolishAttemptCompletedFactV2 {
  return {
    schemaVersion: "polish_attempt_completed_v2",
    started: {
      schemaVersion: "polish_attempt_started_v2",
      attemptNo: 1,
      startedAtMs: 1_000,
      deadlineAtMs: 31_000,
    },
    status: "succeeded",
    transmitted: true,
    providerBillable: true,
    usageObservation: {
      kind: "observed",
      usage: {
        schemaVersion: "normalized_usage_v2",
        inputTotalTokens: 15,
        inputCacheReadTokens: 5,
        inputCacheWriteTokens: null,
        inputStandardTokens: 10,
        outputTokens: 4,
        reasoningTokens: null,
        cacheUsageReporting: "unavailable",
        usageComplete: true,
      },
    },
    route: {
      schemaVersion: "route_observation_v1",
      gatewayRequestId: "req_ABC12345",
      providerRequestId: "provider_12345678",
      actualUpstreamEndpoint: DEEPSEEK_ENDPOINT,
      actualModelId: ROUTE.modelId,
      routerAttemptCount: 1,
    },
    cost: {
      schemaVersion: "cost_observation_v1",
      estimatedCost: { currency: "CNY", nanos: "17" },
      estimationStatus: "complete",
      incompleteReasons: [],
      providerReportedCost: { currency: "CNY", nanos: "17" },
    },
    finishReason: "stop",
    failureStage: null,
    error: null,
    transportStartedAtMs: 1_100,
    completedAtMs: 1_250,
    latencyMs: 150,
    ...overrides,
    retryEligible: overrides.retryEligible ?? false,
  };
}

describe("RT-009 V2 reserve and execution snapshot wrappers", () => {
  it("serializes the exact reserve assertion and returns only an equal frozen route", async () => {
    const { client, rpc } = sequenceClient({ data: reserveSuccess() });

    await expect(
      reservePolishRequestV2(client, {
        userId: USER_ID,
        requestId: REQUEST_ID,
        clientRequestId: CLIENT_REQUEST_ID,
        expectedRoute: EXPECTED_ROUTE,
      }),
    ).resolves.toEqual(reserveSuccess());
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("reserve_ai_polish_request_v2", {
      p_user_id: USER_ID,
      p_request_id: REQUEST_ID,
      p_client_request_id: CLIENT_REQUEST_ID,
      p_expected_route: {
        schema_version: "expected_route_v1",
        config_generation: ROUTE.configGeneration,
        profile_version_id: ROUTE.profileVersionId,
        legal_bundle_version: ROUTE.legalBundleVersion,
        runtime_contract_id: ROUTE.runtimeContractId,
      },
    });
  });

  it("does not retry either a definite denial or an ambiguous reserve response", async () => {
    const denied = sequenceClient({
      data: {
        allowed: false,
        reason: "QUOTA_EXCEEDED",
        message: "untrusted DB prose",
        remaining: 0,
        resetAt: "2026-08-25T16:00:00.000Z",
      },
    });
    const denial = await capturedError(
      reservePolishRequestV2(denied.client, {
        userId: USER_ID,
        requestId: REQUEST_ID,
        clientRequestId: CLIENT_REQUEST_ID,
        expectedRoute: EXPECTED_ROUTE,
      }),
    );
    expect(denial).toMatchObject({
      kind: "RESERVE_DENIED",
      reason: "QUOTA_EXCEEDED",
      remaining: 0,
      resetAt: "2026-08-25T16:00:00.000Z",
    });
    expect(denial.message).not.toContain("untrusted");
    expect(denied.rpc).toHaveBeenCalledTimes(1);

    const ambiguous = sequenceClient({
      data: null,
      error: { message: "raw PostgREST connection text" },
    });
    const unknown = await capturedError(
      reservePolishRequestV2(ambiguous.client, {
        userId: USER_ID,
        requestId: REQUEST_ID,
        clientRequestId: CLIENT_REQUEST_ID,
        expectedRoute: EXPECTED_ROUTE,
      }),
    );
    expect(unknown.kind).toBe("RESERVE_UNKNOWN");
    expect(unknown.message).not.toContain("PostgREST");
    expect(ambiguous.rpc).toHaveBeenCalledTimes(1);
  });

  it("fails a route-drifted reserve response as unknown after possible admission", async () => {
    const { client } = sequenceClient({
      data: {
        ...reserveSuccess(),
        routeSnapshot: { ...ROUTE, configGeneration: "1" },
      },
    });
    const error = await capturedError(
      reservePolishRequestV2(client, {
        userId: USER_ID,
        requestId: REQUEST_ID,
        clientRequestId: CLIENT_REQUEST_ID,
        expectedRoute: EXPECTED_ROUTE,
      }),
    );
    expect(error).toMatchObject({ kind: "RESERVE_UNKNOWN", reason: "ROUTE_MISMATCH" });
  });

  it("validates the execution snapshot and exact runtime target before returning", async () => {
    const { client, rpc } = sequenceClient({ data: executionSuccess });
    let resolverCalls = 0;
    await expect(
      getPolishExecutionSnapshotV1(client, {
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        reserveRoute: ROUTE,
        runtimeTargetResolver: (target) => {
          resolverCalls += 1;
          return target.profileVersionId === ROUTE.profileVersionId;
        },
      }),
    ).resolves.toEqual(executionSuccess);
    expect(resolverCalls).toBe(1);
    expect(rpc).toHaveBeenCalledWith("get_ai_polish_execution_snapshot_v1", {
      p_reservation_id: RESERVATION_ID,
      p_user_id: USER_ID,
    });
  });

  it("distinguishes a safe snapshot denial from unavailable runtime authority", async () => {
    const denied = sequenceClient({
      data: {
        schemaVersion: "ai_polish_execution_snapshot_v1",
        ok: false,
        reason: "NOT_FOUND",
      },
    });
    const denial = await capturedError(
      getPolishExecutionSnapshotV1(denied.client, {
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        reserveRoute: ROUTE,
        runtimeTargetResolver: () => true,
      }),
    );
    expect(denial).toMatchObject({ kind: "SNAPSHOT_DENIED", reason: "NOT_FOUND" });

    const unavailable = sequenceClient({ data: executionSuccess });
    const authority = await capturedError(
      getPolishExecutionSnapshotV1(unavailable.client, {
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        reserveRoute: ROUTE,
        runtimeTargetResolver: () => false,
      }),
    );
    expect(authority).toMatchObject({
      kind: "SNAPSHOT_UNAVAILABLE",
      reason: "RUNTIME_TARGET_UNAVAILABLE",
    });
  });

  it("reads a v2 snapshot through the versioned RPC and exact target resolver", async () => {
    const { client, rpc } = sequenceClient({ data: executionSuccessV2 });
    await expect(
      getPolishExecutionSnapshotV2(client, {
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        reserveRoute: ROUTE_V2,
        runtimeTargetResolver: () => true,
        runtimeTargetResolverV2: (target) =>
          target.profile.endpointUrl === PROFILE_V2.endpointUrl,
      }),
    ).resolves.toEqual(executionSuccessV2);
    expect(rpc).toHaveBeenCalledWith("get_ai_polish_execution_snapshot_v3", {
      p_reservation_id: RESERVATION_ID,
      p_user_id: USER_ID,
    });
  });

  it("reports a rejected v2 runtime target as unavailable authority", async () => {
    const { client } = sequenceClient({ data: executionSuccessV2 });
    const error = await capturedError(
      getPolishExecutionSnapshotV2(client, {
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        reserveRoute: ROUTE_V2,
        runtimeTargetResolver: () => true,
        runtimeTargetResolverV2: () => false,
      }),
    );
    expect(error).toMatchObject({
      kind: "SNAPSHOT_UNAVAILABLE",
      reason: "RUNTIME_TARGET_UNAVAILABLE",
    });
  });
});

describe("RT-009 V2 attempt admission", () => {
  it("freezes runtime provenance through the v2 start RPC", async () => {
    const { client, rpc } = sequenceClient({ data: attemptStart() });
    await expect(
      startPolishProviderAttemptV2(client, {
        reservationId: RESERVATION_ID,
        attemptNo: 1,
        expectedRoute: ROUTE,
        runtimeProvenance: {
          runtimeBuildId: "preview-build:abc123",
          bindingManifestRevision: "binding-v1",
        },
      }),
    ).resolves.toEqual(attemptStart());
    expect(rpc).toHaveBeenCalledWith("start_ai_polish_provider_attempt_v2", {
      p_reservation_id: RESERVATION_ID,
      p_attempt_no: 1,
      p_runtime_build_id: "preview-build:abc123",
      p_binding_manifest_revision: "binding-v1",
    });
  });

  it("returns a fresh exact start receipt without replay", async () => {
    const { client, rpc } = sequenceClient({ data: attemptStart() });
    await expect(
      startPolishProviderAttemptV2(client, {
        reservationId: RESERVATION_ID,
        attemptNo: 1,
        expectedRoute: ROUTE,
      }),
    ).resolves.toEqual(attemptStart());
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a first-observation replay and never retries or authorizes transmission", async () => {
    const { client, rpc } = sequenceClient({
      data: attemptStart({ alreadyStarted: true }),
    });
    const error = await capturedError(
      startPolishProviderAttemptV2(client, {
        reservationId: RESERVATION_ID,
        attemptNo: 1,
        expectedRoute: ROUTE,
      }),
    );
    expect(error.kind).toBe("ATTEMPT_START_REPLAY");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("retries identical arguments once after response loss and accepts its replay", async () => {
    const { client, rpc } = sequenceClient(
      { data: null, error: { message: "response lost" } },
      { data: attemptStart({ alreadyStarted: true }) },
    );
    await expect(
      startPolishProviderAttemptV2(client, {
        reservationId: RESERVATION_ID,
        attemptNo: 1,
        expectedRoute: ROUTE,
      }),
    ).resolves.toMatchObject({ alreadyStarted: true, status: "started" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toBe(rpc.mock.calls[1][1]);
  });

  it("never retries a definite start denial and marks two ambiguous observations unknown", async () => {
    const denied = sequenceClient({ data: { ok: false, reason: "AI_DISABLED" } });
    const denial = await capturedError(
      startPolishProviderAttemptV2(denied.client, {
        reservationId: RESERVATION_ID,
        attemptNo: 1,
        expectedRoute: ROUTE,
      }),
    );
    expect(denial).toMatchObject({ kind: "ATTEMPT_START_DENIED", reason: "AI_DISABLED" });
    expect(denied.rpc).toHaveBeenCalledTimes(1);

    const unknown = sequenceClient(new Error("first raw error"), new Error("second raw error"));
    const ambiguity = await capturedError(
      startPolishProviderAttemptV2(unknown.client, {
        reservationId: RESERVATION_ID,
        attemptNo: 1,
        expectedRoute: ROUTE,
      }),
    );
    expect(ambiguity.kind).toBe("ATTEMPT_START_UNKNOWN");
    expect(ambiguity.message).not.toContain("raw error");
    expect(unknown.rpc).toHaveBeenCalledTimes(2);
  });
});

describe("RT-009 V2 durable cancellation observation", () => {
  const observed = {
    ok: true,
    reservationId: RESERVATION_ID,
    state: "observed",
  } as const;

  it("replays an ambiguous write and accepts only exact identity readback", async () => {
    const { client, rpc } = sequenceClient(new Error("lost"), { data: observed });
    await expect(
      recordPolishRequestCancellationV2(client, {
        reservationId: RESERVATION_ID,
      }),
    ).resolves.toEqual(observed);
    expect(rpc).toHaveBeenNthCalledWith(2, "record_ai_polish_request_cancellation", {
      p_reservation_id: RESERVATION_ID,
      p_observation: "observed",
    });
  });

  it("accepts a third-call observed proof but holds an ambiguous marker", async () => {
    const proved = sequenceClient(
      new Error("lost-1"),
      new Error("lost-2"),
      { data: observed },
    );
    await expect(
      recordPolishRequestCancellationV2(proved.client, {
        reservationId: RESERVATION_ID,
      }),
    ).resolves.toEqual(observed);

    const held = sequenceClient(
      new Error("lost-1"),
      new Error("lost-2"),
      {
        data: {
          ok: true,
          reservationId: RESERVATION_ID,
          state: "ambiguous",
        },
      },
    );
    const error = await capturedError(
      recordPolishRequestCancellationV2(held.client, {
        reservationId: RESERVATION_ID,
      }),
    );
    expect(error.kind).toBe("CANCELLATION_UNKNOWN");
  });

  it.each([
    { ...observed, reservationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { ...observed, extra: true },
    { ok: true, reservationId: RESERVATION_ID, state: "unknown" },
  ])("rejects malformed or swapped authority readback", async (data) => {
    const { client } = sequenceClient({ data });
    const error = await capturedError(
      recordPolishRequestCancellationV2(client, {
        reservationId: RESERVATION_ID,
      }),
    );
    expect(error.kind).toBe("CANCELLATION_UNKNOWN");
  });

  it("surfaces only an exact closed denial as cancellation rejected", async () => {
    const { client, rpc } = sequenceClient({
      data: { ok: false, reason: "ALREADY_FINALIZED" },
    });
    const error = await capturedError(
      recordPolishRequestCancellationV2(client, {
        reservationId: RESERVATION_ID,
      }),
    );
    expect(error).toMatchObject({
      kind: "CANCELLATION_REJECTED",
      reason: "ALREADY_FINALIZED",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("RT-009 V2 terminal attempt persistence", () => {
  it("validates the frozen v2 endpoint without duplicating it into legacy observation", () => {
    const payload = serializePolishAttemptCompletionV2({
      attempt: attemptStart({ routeSnapshot: ROUTE_V2 }),
      fact: completedFact({
        route: {
          ...completedFact().route,
          actualUpstreamEndpoint: PROFILE_V2.endpointUrl,
          actualModelId: PROFILE_V2.modelId,
        },
      }),
      profileExecutionConfig: PROFILE_V2,
      billingCurrency: "CNY",
      routeObservationSecret: "route-secret",
    });
    expect(payload.p_route.actual_upstream_endpoint).toBeNull();
    expect(payload.p_route.actual_model_id).toBe(PROFILE_V2.modelId);
  });

  it("serializes exact usage, tagged route, cost reconciliation, and metadata", () => {
    const payload = serializePolishAttemptCompletionV2({
      attempt: attemptStart(),
      fact: completedFact(),
      profileExecutionConfig: PROFILE,
      billingCurrency: "CNY",
      routeObservationSecret: "  route-secret  ",
    });
    expect(payload).toEqual({
      p_attempt_id: ATTEMPT_ID,
      p_status: "succeeded",
      p_transmitted: true,
      p_retry_eligible: false,
      p_provider_billable: true,
      p_usage: {
        schema_version: "normalized_usage_v2",
        input_total_tokens: 15,
        input_cache_read_tokens: 5,
        input_cache_write_tokens: null,
        input_standard_tokens: 10,
        output_tokens: 4,
        reasoning_tokens: null,
        cache_usage_reporting: "unavailable",
        usage_complete: true,
      },
      p_route: {
        schema_version: "route_observation_v1",
        gateway_request_id:
          "hmac-sha256:57affe2f016deb43b71a8d95eee3c9b5ae5cb701e8d42fbac164bf555c0b9ff1",
        provider_request_id: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64}$/u),
        actual_upstream_endpoint: "https://api.deepseek.com/chat/completions",
        actual_model_id: ROUTE.modelId,
        router_attempt_count: 1,
      },
      p_cost: {
        schema_version: "cost_observation_v1",
        estimated_currency: "CNY",
        estimated_cost_nanos: "17",
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: "17",
        reconciliation_status: "matched",
      },
      p_metadata: {
        schema_version: "attempt_metadata_v1",
        finish_reason: "stop",
        failure_stage: null,
        latency_ms: 150,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("req_ABC12345");
    expect(JSON.stringify(payload)).not.toContain("provider_12345678");
    expect(Object.isFrozen(payload.p_route)).toBe(true);
  });

  it("preserves unavailable usage and drops unsafe raw route IDs without needing their text", () => {
    const fact = completedFact({
      status: "failed_upstream",
      providerBillable: null,
      usageObservation: { kind: "unavailable", usage: null, usageComplete: false },
      route: {
        ...completedFact().route,
        gatewayRequestId: "Bearer_ABC12345",
        providerRequestId: "/v1/responses/raw-secret",
        actualUpstreamEndpoint: null,
        actualModelId: null,
        routerAttemptCount: null,
      },
      cost: {
        schemaVersion: "cost_observation_v1",
        estimatedCost: null,
        estimationStatus: "incomplete_usage",
        incompleteReasons: ["usage_incomplete"],
        providerReportedCost: null,
      },
      finishReason: null,
      failureStage: "transport",
    });
    const payload = serializePolishAttemptCompletionV2({
      attempt: attemptStart(),
      fact,
      profileExecutionConfig: PROFILE,
      billingCurrency: "CNY",
      routeObservationSecret: null,
    });
    expect(payload.p_usage).toBeNull();
    expect(payload.p_route.gateway_request_id).toBeNull();
    expect(payload.p_route.provider_request_id).toBeNull();
    expect(payload.p_cost).toMatchObject({
      estimated_cost_nanos: null,
      provider_reported_cost_nanos: null,
      reconciliation_status: "incomplete_usage",
    });
  });

  it.each([
    ["currency drift", { billingCurrency: "USD" }],
    ["model drift", { fact: completedFact({ route: { ...completedFact().route, actualModelId: "other" } }) }],
    [
      "non-billable nonzero report",
      {
        fact: completedFact({
          providerBillable: false,
          cost: {
            ...completedFact().cost,
            providerReportedCost: { currency: "CNY", nanos: "1" },
          },
        }),
      },
    ],
    ["latency overflow", { fact: completedFact({ latencyMs: 2_147_483_648 }) }],
  ] as const)("rejects %s before any persistence call", (_name, override) => {
    expect(() =>
      serializePolishAttemptCompletionV2({
        attempt: attemptStart(),
        fact: "fact" in override ? override.fact : completedFact(),
        profileExecutionConfig: PROFILE,
        billingCurrency: "billingCurrency" in override ? override.billingCurrency : "CNY",
        routeObservationSecret: "route-secret",
      }),
    ).toThrow(PolishLifecycleV2RpcError);
  });

  it.each(POLISH_VALIDATION_FAILURE_STAGES)(
    "persists the complete current validation-stage domain: %s",
    async (failureStage) => {
      const { client, rpc } = sequenceClient({
        data: {
          ok: true,
          alreadyCompleted: false,
          status: "invalid_output",
          usageComplete: true,
        },
      });
      const fact = completedFact({
        status: "invalid_output",
        failureStage,
        error: {
          code: "INVALID_MODEL_OUTPUT",
          upstreamStatus: null,
          retryable: true,
          retryAfterMs: 0,
        },
      });

      await expect(
        completePolishProviderAttemptV2(client, {
          attempt: attemptStart(),
          fact,
          profileExecutionConfig: PROFILE,
          billingCurrency: "CNY",
          routeObservationSecret: "route-secret",
        }),
      ).resolves.toMatchObject({ status: "invalid_output", usageComplete: true });

      expect(rpc).toHaveBeenCalledTimes(1);
      const payload = rpc.mock.calls[0]?.[1];
      expect(payload).toMatchObject({
        p_status: "invalid_output",
        p_usage: {
          input_total_tokens: 15,
          input_cache_read_tokens: 5,
          input_standard_tokens: 10,
          output_tokens: 4,
          usage_complete: true,
        },
        p_cost: {
          estimated_currency: "CNY",
          estimated_cost_nanos: "17",
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: "17",
          reconciliation_status: "matched",
        },
        p_metadata: {
          schema_version: "attempt_metadata_v1",
          finish_reason: "stop",
          failure_stage: failureStage,
          latency_ms: 150,
        },
      });
      expect(Object.keys((payload as { p_metadata: object }).p_metadata)).toEqual([
        "schema_version",
        "finish_reason",
        "failure_stage",
        "latency_ms",
      ]);
      expect(JSON.stringify(payload)).not.toContain("INVALID_MODEL_OUTPUT");
    },
  );

  it("keeps the parent-ledger constraint equal to legacy values plus V2 serializer output", () => {
    // Exercise the production serializer rather than treating this test's
    // candidate list as the source of truth.  Parent finalization copies the
    // child fact, so every accepted V2 child stage must be admitted by SQL.
    const emittedV2Stages = POLISH_ATTEMPT_FAILURE_STAGES_V2.map((failureStage) =>
      serializePolishAttemptCompletionV2({
        attempt: attemptStart(),
        fact: completedFact({ failureStage }),
        profileExecutionConfig: PROFILE,
        billingCurrency: "CNY",
        routeObservationSecret: "route-secret",
      }).p_metadata.failure_stage,
    );

    expect(emittedV2Stages).toEqual(POLISH_ATTEMPT_FAILURE_STAGES_V2);
    expect([...new Set(requestLedgerFailureStagesFromMigration())].sort()).toEqual(
      [...new Set([...LEGACY_REQUEST_FAILURE_STAGES, ...emittedV2Stages])].sort(),
    );
  });

  it.each([
    ["unrelated HTTPS origin", "https://unregistered.example/v1/responses"],
    ["MiMo endpoint under a DeepSeek route", resolveEndpoint(MIMO_PROFILE.endpointAlias).url],
    ["userinfo variant", "https://user@api.deepseek.com/chat/completions"],
    ["query variant", `${DEEPSEEK_ENDPOINT}?request_id=req_ABC12345`],
    ["fragment variant", `${DEEPSEEK_ENDPOINT}#req_ABC12345`],
    ["unregistered path", `${DEEPSEEK_ENDPOINT}/req_ABC12345`],
    ["overlength endpoint", `https://api.deepseek.com/${"a".repeat(500)}`],
    ["whitespace-bearing endpoint", ` ${DEEPSEEK_ENDPOINT}`],
  ] as const)("rejects %s before the completion RPC", async (_name, endpoint) => {
    const { client, rpc } = sequenceClient();
    const fact = completedFact({
      route: { ...completedFact().route, actualUpstreamEndpoint: endpoint },
    });

    const error = await capturedError(
      completePolishProviderAttemptV2(client, {
        attempt: attemptStart(),
        fact,
        profileExecutionConfig: PROFILE,
        billingCurrency: "CNY",
        routeObservationSecret: "route-secret",
      }),
    );

    expect(error.kind).toBe("LOCAL_CONTRACT_REJECTED");
    expect(rpc).toHaveBeenCalledTimes(0);
  });

  it("rejects a code-owned profile that does not match the frozen attempt route", async () => {
    const { client, rpc } = sequenceClient();
    const error = await capturedError(
      completePolishProviderAttemptV2(client, {
        attempt: attemptStart(),
        fact: completedFact(),
        profileExecutionConfig: MIMO_PROFILE,
        billingCurrency: "CNY",
        routeObservationSecret: "route-secret",
      }),
    );

    expect(error.kind).toBe("LOCAL_CONTRACT_REJECTED");
    expect(rpc).toHaveBeenCalledTimes(0);
  });

  it("retries an identical completion payload once and accepts exact idempotent readback", async () => {
    const { client, rpc } = sequenceClient(
      { data: null, error: { message: "lost after commit" } },
      {
        data: {
          ok: true,
          alreadyCompleted: true,
          status: "succeeded",
          usageComplete: true,
        },
      },
    );
    await expect(
      completePolishProviderAttemptV2(client, {
        attempt: attemptStart(),
        fact: completedFact(),
        profileExecutionConfig: PROFILE,
        billingCurrency: "CNY",
        routeObservationSecret: "route-secret",
      }),
    ).resolves.toMatchObject({ alreadyCompleted: true, status: "succeeded" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toBe(rpc.mock.calls[1][1]);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_route: { actual_upstream_endpoint: DEEPSEEK_ENDPOINT },
    });
  });

  it("does not retry a definite completion rejection or accept conflicting readback", async () => {
    const rejected = sequenceClient({ data: { ok: false, reason: "INTERNAL_ERROR" } });
    const rejection = await capturedError(
      completePolishProviderAttemptV2(rejected.client, {
        attempt: attemptStart(),
        fact: completedFact(),
        profileExecutionConfig: PROFILE,
        billingCurrency: "CNY",
        routeObservationSecret: "route-secret",
      }),
    );
    expect(rejection.kind).toBe("ATTEMPT_COMPLETE_REJECTED");
    expect(rejected.rpc).toHaveBeenCalledTimes(1);

    const conflict = sequenceClient({
      data: {
        ok: true,
        alreadyCompleted: true,
        status: "failed_upstream",
        usageComplete: false,
      },
    });
    const mismatch = await capturedError(
      completePolishProviderAttemptV2(conflict.client, {
        attempt: attemptStart(),
        fact: completedFact(),
        profileExecutionConfig: PROFILE,
        billingCurrency: "CNY",
        routeObservationSecret: "route-secret",
      }),
    );
    expect(mismatch).toMatchObject({
      kind: "ATTEMPT_COMPLETE_REJECTED",
      reason: "READBACK_MISMATCH",
    });
  });

  it("keeps completion unknown when a response-loss retry is then rejected", async () => {
    const { client, rpc } = sequenceClient(
      { data: null, error: { message: "first response lost" } },
      { data: { ok: false, reason: "REQUEST_ALREADY_FINALIZED" } },
    );
    const error = await capturedError(
      completePolishProviderAttemptV2(client, {
        attempt: attemptStart(),
        fact: completedFact(),
        profileExecutionConfig: PROFILE,
        billingCurrency: "CNY",
        routeObservationSecret: "route-secret",
      }),
    );
    expect(error).toMatchObject({
      kind: "ATTEMPT_COMPLETE_UNKNOWN",
      reason: "REQUEST_ALREADY_FINALIZED",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("RT-009 V2 request settlement", () => {
  it("selects child aggregation with null request usage and derives quota charging", () => {
    expect(
      serializePolishFinalizeV2({
        settlementKind: "attempt_v2",
        reservationId: RESERVATION_ID,
        status: "succeeded",
        transmitted: true,
        providerBillable: true,
        metadata: FINALIZE_METADATA,
      }),
    ).toEqual({
      p_reservation_id: RESERVATION_ID,
      p_status: "succeeded",
      p_quota_charged: true,
      p_provider_billable: true,
      p_usage: null,
      p_metadata: {
        usage_schema_version: "attempt_v2",
        granularity: "group",
        item_count: 2,
        context_level: 1,
        language: "zh",
        prompt_version: "2026-08-prompt-v1",
        validator_version: "2026-08-validator-v1",
      },
      p_settlement_contract: "durable_cancellation_sequence_v1",
    });
    expect(
      serializePolishFinalizeV2({
        settlementKind: "attempt_v2",
        reservationId: RESERVATION_ID,
        status: "failed_upstream",
        transmitted: true,
        providerBillable: null,
        metadata: FINALIZE_METADATA,
      }).p_quota_charged,
    ).toBe(false);

    expect(
      serializePolishFinalizeV2({
        settlementKind: "attempt_v2",
        reservationId: RESERVATION_ID,
        status: "canceled",
        transmitted: true,
        providerBillable: null,
        metadata: FINALIZE_METADATA,
      }).p_quota_charged,
    ).toBe(true);
    expect(
      serializePolishFinalizeV2({
        settlementKind: "attempt_v2",
        reservationId: RESERVATION_ID,
        status: "canceled",
        transmitted: false,
        providerBillable: false,
        metadata: FINALIZE_METADATA,
      }).p_quota_charged,
    ).toBe(false);
  });

  it("uses the exact zero-child release shape without the attempt selector", () => {
    const withMetadata = serializePolishFinalizeV2({
      settlementKind: "zero_child_release",
      reservationId: RESERVATION_ID,
      metadata: FINALIZE_METADATA,
    });
    expect(withMetadata).toMatchObject({
      p_status: "released",
      p_quota_charged: false,
      p_provider_billable: false,
      p_usage: null,
    });
    expect(withMetadata.p_metadata).not.toHaveProperty("usage_schema_version");
    expect(
      serializePolishFinalizeV2({
        settlementKind: "zero_child_release",
        reservationId: RESERVATION_ID,
      }).p_metadata,
    ).toBeNull();
  });

  it("retries identical finalize arguments once after response loss", async () => {
    const { client, rpc } = sequenceClient(
      new Error("lost response"),
      {
        data: {
          ok: true,
          alreadyFinalized: true,
          status: "succeeded",
          quotaCharged: true,
          quota: { limit: 20, remaining: 19, resetAt: "2026-08-25T16:00:00.000Z" },
        },
      },
    );
    await expect(
      finalizePolishRequestV2(client, {
        settlementKind: "attempt_v2",
        reservationId: RESERVATION_ID,
        status: "succeeded",
        transmitted: true,
        providerBillable: true,
        metadata: FINALIZE_METADATA,
      }),
    ).resolves.toMatchObject({ alreadyFinalized: true, status: "succeeded" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toBe(rpc.mock.calls[1][1]);
  });

  it("does not launch a second finalize write after cancellation becomes observable", async () => {
    const controller = new AbortController();
    const rpc = vi.fn(async () => {
      controller.abort(new DOMException("caller disconnected", "AbortError"));
      throw new Error("lost response after the first write");
    });
    const client = { rpc } as unknown as SupabaseClient;
    const error = await capturedError(
      finalizePolishRequestV2(
        client,
        {
          settlementKind: "zero_child_release",
          reservationId: RESERVATION_ID,
        },
        { signal: controller.signal },
      ),
    );
    expect(error).toMatchObject({
      kind: "FINALIZE_UNKNOWN",
      reason: "CANCELED_BEFORE_RETRY",
    });
    expect(error.message).not.toContain("lost response");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("withholds success on conflicting settlement and leaves double ambiguity unknown", async () => {
    const conflict = sequenceClient({
      data: {
        ok: true,
        alreadyFinalized: true,
        status: "released",
        quotaCharged: false,
        quota: { limit: 20, remaining: 20, resetAt: "2026-08-25T16:00:00.000Z" },
      },
    });
    const mismatch = await capturedError(
      finalizePolishRequestV2(conflict.client, {
        settlementKind: "attempt_v2",
        reservationId: RESERVATION_ID,
        status: "succeeded",
        transmitted: true,
        providerBillable: true,
        metadata: FINALIZE_METADATA,
      }),
    );
    expect(mismatch.kind).toBe("FINALIZE_CONFLICT");

    const unknown = sequenceClient(
      { data: null, error: { message: "first DB text" } },
      { data: null, error: { message: "second DB text" } },
    );
    const ambiguity = await capturedError(
      finalizePolishRequestV2(unknown.client, {
        settlementKind: "zero_child_release",
        reservationId: RESERVATION_ID,
      }),
    );
    expect(ambiguity.kind).toBe("FINALIZE_UNKNOWN");
    expect(ambiguity.message).not.toContain("DB text");
    expect(unknown.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not retry a definite finalize rejection", async () => {
    const { client, rpc } = sequenceClient({
      data: { ok: false, reason: "ATTEMPT_IN_PROGRESS" },
    });
    const error = await capturedError(
      finalizePolishRequestV2(client, {
        settlementKind: "attempt_v2",
        reservationId: RESERVATION_ID,
        status: "failed_upstream",
        transmitted: true,
        providerBillable: null,
        metadata: FINALIZE_METADATA,
      }),
    );
    expect(error).toMatchObject({
      kind: "FINALIZE_REJECTED",
      reason: "ATTEMPT_IN_PROGRESS",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
