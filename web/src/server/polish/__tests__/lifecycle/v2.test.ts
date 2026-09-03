import { describe, expect, it, vi } from "vitest";

import type { PolishRequest } from "@/lib/polish/contract";
import executionFixture from "../../../../../test/fixtures/ai-runtime-execution-contract-v1.json";
import profileV2Fixtures from "../../../../../test/fixtures/profile-execution-v2.json";
import {
  createCodeOwnedPolishAdapterResolverV2,
  executePolishLifecycleV2,
  PolishAdapterUnavailableV2Error,
  type PolishLifecycleV2Input,
  type PolishLifecycleV2LogEvent,
  type PolishRouteDepsV2,
} from "../../lifecycle-v2";
import { createFakePolishV2RouteDeps } from "../../backend-fake";
import {
  parseExecutionSnapshotV1,
  parsePriceSnapshotV1,
  parseRouteSnapshotV1,
  type ExpectedRouteV1,
} from "../../lifecycle-v2-contract";
import { DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1 } from "../../service-runtime-contract-v1";
import type { PolishInferenceRequestV2, PolishInferenceResultV2 } from "../../inference-v2";
import type { PolishInferenceProviderV2 } from "../../orchestrator";
import {
  createPreparedProviderExecutionV2,
  type PreparedProviderExecutionV2,
} from "../../prepared-provider-execution-v2";
import { prepareProviderTransportV2 } from "../../provider-binding-v2";
import { validateProfileExecutionConfigV2 } from "../../profile-execution-v2";
import {
  resolveProfile,
  type ProfileExecutionConfigV1,
} from "../../profile-registry";
import {
  createFakePolishInferenceProvider,
  createFakePolishProvider,
} from "../../provider-fake";
import {
  PolishLifecycleV2RpcError,
  serializePolishAttemptCompletionV2,
  serializePolishFinalizeV2,
  type PolishAttemptCompletionRpcPayloadV2,
  type PolishFinalizeCallOptionsV2,
  type PolishFinalizeRequestV2,
  type PolishFinalizeRpcPayloadV2,
  type ProviderAttemptStartV2,
} from "../../quota";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const CLIENT_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const ROUTE_SECRET = "test-route-observation-secret";
const SUBJECT_SECRET = "test-provider-subject-secret";
const deepseekExecution = structuredClone(
  executionFixture.executionSnapshot.successes[0].value,
);
const RESERVATION_ID = deepseekExecution.reservationId;
const ROUTE = parseRouteSnapshotV1(deepseekExecution.routeSnapshot);
const EXPECTED_ROUTE: ExpectedRouteV1 = Object.freeze({
  schemaVersion: "expected_route_v1",
  configGeneration: ROUTE.configGeneration,
  profileVersionId: ROUTE.profileVersionId,
  legalBundleVersion: ROUTE.legalBundleVersion,
  runtimeContractId: ROUTE.runtimeContractId,
});
const PROFILE_V2 = validateProfileExecutionConfigV2(
  profileV2Fixtures.deepseek,
);
const PRICE_V1 = parsePriceSnapshotV1(deepseekExecution.priceSnapshot);
const ROUTE_V2 = Object.freeze({
  ...ROUTE,
  modelId: PROFILE_V2.modelId,
  displayDisclosureKey: PROFILE_V2.displayDisclosureKey,
});
const EXECUTION_V2 = Object.freeze({
  schemaVersion: "ai_polish_execution_snapshot_v2" as const,
  ok: true as const,
  reservationId: RESERVATION_ID,
  routeSnapshot: ROUTE_V2,
  profileExecutionConfig: PROFILE_V2,
  priceSnapshot: PRICE_V1,
  runtimeEvidence: Object.freeze({
    schemaVersion: "runtime_execution_evidence_v2" as const,
    runtimeContractId: ROUTE_V2.runtimeContractId,
    runtimeTargetId: "runtime-target.synthetic.deepseek.v2",
    runtimeTargetSha256: "1".repeat(64),
    routeDescriptorId: "route-descriptor.synthetic.deepseek.v2",
    routeDescriptorSha256: "2".repeat(64),
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
    legalManifestSha256: "3".repeat(64),
    displayDisclosureKey: PROFILE_V2.displayDisclosureKey,
    externalEvidenceIds: Object.freeze(["evidence.synthetic-lifecycle"]),
  }),
});
const REQUEST: PolishRequest = {
  clientRequestId: CLIENT_REQUEST_ID,
  granularity: "item",
  sectionId: "experience",
  language: "zh",
  items: [
    {
      id: "i0",
      kind: "experience_bullet",
      text: "负责后端服务开发，将 P99 延迟降低 40%。",
    },
  ],
  context: { level: 0, references: [] },
};
const COMPLETE_USAGE = {
  schemaVersion: "normalized_usage_v2",
  inputTotalTokens: 15,
  inputCacheReadTokens: 5,
  inputCacheWriteTokens: null,
  inputStandardTokens: 10,
  outputTokens: 4,
  reasoningTokens: null,
  cacheUsageReporting: "unavailable",
  usageComplete: true,
} as const;

interface ProviderCall {
  readonly request: PolishInferenceRequestV2;
  readonly options: { signal: AbortSignal; timeoutMs: number };
}

type ProviderBehavior = (
  call: ProviderCall,
) => Promise<PolishInferenceResultV2>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface HarnessState {
  readonly calls: string[];
  readonly providerCalls: ProviderCall[];
  readonly completionPayloads: PolishAttemptCompletionRpcPayloadV2[];
  readonly finalizeRequests: PolishFinalizeRequestV2[];
  readonly finalizeCallOptions: PolishFinalizeCallOptionsV2[];
  readonly finalizePayloads: PolishFinalizeRpcPayloadV2[];
  readonly logs: PolishLifecycleV2LogEvent[];
}

interface HarnessOptions {
  readonly controller?: AbortController;
  readonly providerBehaviors?: readonly ProviderBehavior[];
  readonly runtimeTargetResolver?: PolishRouteDepsV2["runtimeTargetResolver"];
  readonly reserve?: PolishRouteDepsV2["reserve"];
  readonly getExecutionSnapshot?: PolishRouteDepsV2["getExecutionSnapshot"];
  readonly startAttempt?: PolishRouteDepsV2["startAttempt"];
  readonly completeAttempt?: PolishRouteDepsV2["completeAttempt"];
  readonly recordCancellation?: PolishRouteDepsV2["recordCancellation"];
  readonly finalize?: PolishRouteDepsV2["finalize"];
  readonly resolveProvider?: PolishRouteDepsV2["resolveProvider"];
  readonly sleep?: PolishRouteDepsV2["sleep"];
}

function successfulProviderResult(
  text = JSON.stringify({
    items: [{ id: "i0", polished: "负责后端服务开发，将 P99 延迟降低 40%。" }],
  }),
): PolishInferenceResultV2 {
  return {
    schemaVersion: "polish_inference_result_v2",
    text,
    finishReason: "stop",
    usage: { ...COMPLETE_USAGE },
    route: {
      gatewayRequestId: "req_GATEWAY1234",
      providerRequestId: "req_PROVIDER1234",
      actualUpstreamEndpoint: "https://api.deepseek.com/chat/completions",
      actualModelId: ROUTE.modelId,
      routerAttemptCount: 1,
    },
  };
}

function successfulFinalizeResult(
  params: PolishFinalizeRequestV2,
  alreadyFinalized = false,
) {
  const payload = serializePolishFinalizeV2(params);
  return {
    ok: true as const,
    alreadyFinalized,
    status: payload.p_status,
    quotaCharged: payload.p_quota_charged,
    quota: {
      limit: 20,
      remaining: payload.p_quota_charged ? 19 : 20,
      resetAt: "2026-08-25T16:00:00.000Z",
    },
  };
}

function attemptId(attemptNo: 1 | 2): string {
  return attemptNo === 1
    ? "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"
    : "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
}

function attemptReceipt(attemptNo: 1 | 2): ProviderAttemptStartV2 {
  return {
    ok: true,
    attemptId: attemptId(attemptNo),
    attemptNo,
    alreadyStarted: false,
    status: "started",
    routeSnapshot: ROUTE,
  };
}

function input(controller = new AbortController()): PolishLifecycleV2Input {
  return {
    authenticatedUserId: USER_ID,
    requestId: REQUEST_ID,
    clientRequestId: CLIENT_REQUEST_ID,
    request: structuredClone(REQUEST),
    expectedRoute: EXPECTED_ROUTE,
    signal: controller.signal,
  };
}

function preparedExecution(
  fetchImpl: typeof fetch,
  runtimeBuildId = "preview-build:lifecycle-v2",
  bindingManifestRevision = "binding-lifecycle-v2",
): PreparedProviderExecutionV2 {
  const prepared = prepareProviderTransportV2({
    profile: PROFILE_V2,
    recipient: {
      providerId: PROFILE_V2.providerId,
      recipientKey: "deepseek",
    },
    manifest: {
      schemaVersion: "ai_provider_bindings_v1",
      revision: bindingManifestRevision,
      bindings: [
        {
          credentialEnvName: PROFILE_V2.credentialEnvName,
          providerId: PROFILE_V2.providerId,
          recipientKey: "deepseek",
          origin: "https://api.deepseek.com",
        },
      ],
    },
    expectedManifestRevision: bindingManifestRevision,
    runtimeBuildId,
    resolveSecret: () => "fake-provider-key",
  });
  return createPreparedProviderExecutionV2(prepared, fetchImpl);
}

function createHarness(options: HarnessOptions = {}) {
  const controller = options.controller ?? new AbortController();
  const state: HarnessState = {
    calls: [],
    providerCalls: [],
    completionPayloads: [],
    finalizeRequests: [],
    finalizeCallOptions: [],
    finalizePayloads: [],
    logs: [],
  };
  const behaviors = [
    ...(options.providerBehaviors ?? [async () => successfulProviderResult()]),
  ];
  const provider: PolishInferenceProviderV2 = {
    async complete(request, callOptions) {
      state.calls.push(`provider:${state.providerCalls.length + 1}`);
      const call = { request, options: callOptions };
      state.providerCalls.push(call);
      const behavior = behaviors[state.providerCalls.length - 1];
      if (behavior === undefined) throw new Error("unexpected provider transmission");
      return behavior(call);
    },
  };

  const runtimeTargetResolver = options.runtimeTargetResolver ?? (() => true);
  const baseDeps: PolishRouteDepsV2 = {
    async reserve(params) {
      state.calls.push("reserve");
      expect(params).toEqual({
        userId: USER_ID,
        requestId: REQUEST_ID,
        clientRequestId: CLIENT_REQUEST_ID,
        expectedRoute: EXPECTED_ROUTE,
      });
      return {
        allowed: true,
        reservationId: RESERVATION_ID,
        limit: 20,
        remaining: 19,
        resetAt: "2026-08-25T16:00:00.000Z",
        routeSnapshot: ROUTE,
      };
    },
    async getExecutionSnapshot(params) {
      state.calls.push("snapshot");
      expect(params).toMatchObject({
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        reserveRoute: ROUTE,
      });
      expect(params.runtimeTargetResolver).toBe(runtimeTargetResolver);
      const parsed = parseExecutionSnapshotV1(deepseekExecution, {
        reservationId: RESERVATION_ID,
        reserveRoute: ROUTE,
        runtimeTargetResolver: params.runtimeTargetResolver,
      });
      if (!parsed.ok) throw new Error("unexpected execution failure fixture");
      return parsed;
    },
    async startAttempt(params) {
      state.calls.push(`start:${params.attemptNo}`);
      expect(params.reservationId).toBe(RESERVATION_ID);
      expect(params.expectedRoute).toEqual(ROUTE);
      return attemptReceipt(params.attemptNo);
    },
    async completeAttempt(params) {
      state.calls.push(`complete:${params.fact.started.attemptNo}`);
      const payload = serializePolishAttemptCompletionV2(params);
      state.completionPayloads.push(payload);
      return {
        ok: true,
        alreadyCompleted: false,
        status: params.fact.status,
        usageComplete:
          params.fact.usageObservation.kind === "observed"
            ? params.fact.usageObservation.usage.usageComplete
            : false,
      };
    },
    async recordCancellation(params) {
      state.calls.push("record_cancellation");
      return {
        ok: true,
        reservationId: params.reservationId,
        state: "observed",
      };
    },
    async finalize(params, callOptions = {}) {
      state.calls.push("finalize");
      state.finalizeRequests.push(params);
      state.finalizeCallOptions.push(callOptions);
      const payload = serializePolishFinalizeV2(params);
      state.finalizePayloads.push(payload);
      if (options.finalize) return options.finalize(params, callOptions);
      return {
        ok: true,
        alreadyFinalized: false,
        status: payload.p_status,
        quotaCharged: payload.p_quota_charged,
        quota: {
          limit: 20,
          remaining: payload.p_quota_charged ? 19 : 20,
          resetAt: "2026-08-25T16:00:00.000Z",
        },
      };
    },
    runtimeTargetResolver,
    resolveProvider(profile) {
      state.calls.push("resolve_provider");
      expect(profile.profileKey).toBe(
        "deepseek.official.deepseek-v4-flash.chat.v1",
      );
      return provider;
    },
    providerSubjectSecret: SUBJECT_SECRET,
    routeObservationSecret: ROUTE_SECRET,
    now: () => 1_000,
    sleep: options.sleep ?? (async () => undefined),
    logger: (event) => state.logs.push(event),
  };
  const deps: PolishRouteDepsV2 = {
    ...baseDeps,
    ...(options.reserve ? { reserve: options.reserve } : {}),
    ...(options.getExecutionSnapshot
      ? { getExecutionSnapshot: options.getExecutionSnapshot }
      : {}),
    ...(options.startAttempt ? { startAttempt: options.startAttempt } : {}),
    ...(options.completeAttempt
      ? { completeAttempt: options.completeAttempt }
      : {}),
    ...(options.recordCancellation
      ? { recordCancellation: options.recordCancellation }
      : {}),
    ...(options.resolveProvider
      ? { resolveProvider: options.resolveProvider }
      : {}),
  };
  return { controller, deps, state, provider };
}

describe("executePolishLifecycleV2 — dormant pre-network authority", () => {
  it("keeps the existing DeepSeek profile bound to deepseek_chat_v1", () => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolver = createCodeOwnedPolishAdapterResolverV2({
      env: { DEEPSEEK_API_KEY: "test-only-key" },
      fetch: fetchMock,
    });
    expect(
      resolver(resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1")),
    ).toMatchObject({ kind: "deepseek_chat_v1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves only the registered MiMo profile to mimo_responses_v1", () => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolver = createCodeOwnedPolishAdapterResolverV2({
      env: { MIMO_API_KEY: "test-only-mimo-key" },
      fetch: fetchMock,
    });

    expect(
      resolver(resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1")),
    ).toMatchObject({ kind: "mimo_responses_v1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
  ])("fails closed for a %s MiMo credential before transmission", (_label, key) => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolver = createCodeOwnedPolishAdapterResolverV2({
      env: key === undefined ? {} : { MIMO_API_KEY: key },
      fetch: fetchMock,
    });

    expect(() =>
      resolver(resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1")),
    ).toThrow(/credential mimo_api_key is unavailable/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not substitute DeepSeek when the MiMo credential is unavailable", () => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolver = createCodeOwnedPolishAdapterResolverV2({
      env: { DEEPSEEK_API_KEY: "deepseek-must-not-be-used" },
      fetch: fetchMock,
    });

    expect(() =>
      resolver(resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1")),
    ).toThrow(/credential mimo_api_key is unavailable/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown profile", "profileKey", "unknown.profile.v1"],
    ["MiMo profile with DeepSeek adapter", "adapterKind", "deepseek_chat_v1"],
    ["MiMo profile with DeepSeek credential alias", "credentialAlias", "deepseek_api_key"],
    ["MiMo profile with DeepSeek endpoint alias", "endpointAlias", "deepseek_official"],
  ])("rejects %s without provider substitution or transmission", (_label, field, value) => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolver = createCodeOwnedPolishAdapterResolverV2({
      env: {
        DEEPSEEK_API_KEY: "deepseek-must-not-be-used",
        MIMO_API_KEY: "mimo-must-not-be-used",
      },
      fetch: fetchMock,
    });
    const crossed = structuredClone(
      resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1"),
    ) as unknown as Record<string, unknown>;
    crossed[field] = value;

    expect(() => resolver(crossed as unknown as ProfileExecutionConfigV1)).toThrow(
      PolishAdapterUnavailableV2Error,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["adapter", "adapterKind", "mimo_responses_v1"],
    ["credential alias", "credentialAlias", "mimo_api_key"],
    ["endpoint alias", "endpointAlias", "mimo_cn_official"],
  ])("rejects a DeepSeek profile crossed with the MiMo %s", (_label, field, value) => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolver = createCodeOwnedPolishAdapterResolverV2({
      env: {
        DEEPSEEK_API_KEY: "deepseek-must-not-be-used",
        MIMO_API_KEY: "mimo-must-not-be-used",
      },
      fetch: fetchMock,
    });
    const crossed = structuredClone(
      resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1"),
    ) as unknown as Record<string, unknown>;
    crossed[field] = value;

    expect(() => resolver(crossed as unknown as ProfileExecutionConfigV1)).toThrow(
      PolishAdapterUnavailableV2Error,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists provenance from the exact prepared transport used to send", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "chat-prepared-lifecycle",
        model: PROFILE_V2.modelId,
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    id: "i0",
                    polished: "负责后端服务开发，将 P99 延迟降低 40%。",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 4,
          prompt_cache_hit_tokens: 5,
          prompt_cache_miss_tokens: 10,
        },
      }),
    );
    const resolution = preparedExecution(fetchMock);
    const startAttempt = vi.fn<PolishRouteDepsV2["startAttempt"]>(
      async (params) => ({
        ...attemptReceipt(params.attemptNo),
        routeSnapshot: ROUTE_V2,
      }),
    );
    const { deps, controller } = createHarness({
      reserve: async () => ({
        allowed: true,
        reservationId: RESERVATION_ID,
        limit: 20,
        remaining: 19,
        resetAt: "2026-08-25T16:00:00.000Z",
        routeSnapshot: ROUTE_V2,
      }),
      getExecutionSnapshot: async () => EXECUTION_V2,
      resolveProvider: () => resolution,
      startAttempt,
    });

    const result = await executePolishLifecycleV2(input(controller), deps);

    expect(result).toMatchObject({ ok: true, attemptCount: 1 });
    expect(startAttempt).toHaveBeenCalledTimes(1);
    expect(startAttempt.mock.calls[0][0].runtimeProvenance).toEqual({
      runtimeBuildId: "preview-build:lifecycle-v2",
      bindingManifestRevision: "binding-lifecycle-v2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects copied prepared execution objects before DB start or fetch", async () => {
    const fetchA = vi.fn<typeof fetch>();
    const fetchB = vi.fn<typeof fetch>();
    const executionA = preparedExecution(
      fetchA,
      "preview-build:a",
      "binding-a",
    );
    preparedExecution(
      fetchB,
      "preview-build:b",
      "binding-b",
    );
    const crossed = Object.freeze({
      ...executionA,
      provider: { complete: vi.fn() },
    }) as PreparedProviderExecutionV2;
    const startAttempt = vi.fn<PolishRouteDepsV2["startAttempt"]>();
    const { deps, controller } = createHarness({
      reserve: async () => ({
        allowed: true,
        reservationId: RESERVATION_ID,
        limit: 20,
        remaining: 19,
        resetAt: "2026-08-25T16:00:00.000Z",
        routeSnapshot: ROUTE_V2,
      }),
      getExecutionSnapshot: async () => EXECUTION_V2,
      resolveProvider: () => crossed,
      startAttempt,
    });

    const result = await executePolishLifecycleV2(input(controller), deps);

    expect(result).toMatchObject({
      ok: false,
      code: "PROFILE_UNAVAILABLE",
      stage: "profile_resolution",
      attemptCount: 0,
    });
    expect(startAttempt).not.toHaveBeenCalled();
    expect(fetchA).not.toHaveBeenCalled();
    expect(fetchB).not.toHaveBeenCalled();
  });

  it("runs reserve → strict snapshot → profile → start → transmit → complete → finalize", async () => {
    const { deps, state, controller } = createHarness();

    const result = await executePolishLifecycleV2(input(controller), deps);

    expect(result).toMatchObject({
      ok: true,
      requestId: REQUEST_ID,
      attemptCount: 1,
      settlement: "confirmed",
      profileVersionId: ROUTE.profileVersionId,
      displayDisclosureKey: ROUTE.displayDisclosureKey,
      quota: { limit: 20, remaining: 19 },
    });
    expect(state.calls).toEqual([
      "reserve",
      "snapshot",
      "resolve_provider",
      "start:1",
      "provider:1",
      "complete:1",
      "finalize",
    ]);
    expect(state.finalizePayloads[0]).toMatchObject({
      p_status: "succeeded",
      p_quota_charged: true,
      p_provider_billable: true,
      p_usage: null,
      p_metadata: { usage_schema_version: "attempt_v2" },
    });
    expect(state.providerCalls[0].request.providerSubjectId).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(state.providerCalls[0].request.providerSubjectId).not.toContain(USER_ID);
    expect(JSON.stringify(state.providerCalls[0].request)).not.toContain(
      CLIENT_REQUEST_ID,
    );
    expect(JSON.stringify(state.completionPayloads[0])).not.toContain(
      "req_PROVIDER1234",
    );
    expect(JSON.stringify(state.completionPayloads[0])).not.toContain(ROUTE_SECRET);
    expect(JSON.stringify(state.logs)).not.toContain(USER_ID);
    expect(JSON.stringify(state.logs)).not.toContain("req_PROVIDER1234");
  });

  it("projects only allowlisted reserve denial codes", async () => {
    const denied = createHarness({
      reserve: async () => {
        throw new PolishLifecycleV2RpcError("RESERVE_DENIED", {
          reason: "SENSITIVE_INTERNAL_DENIAL",
        });
      },
    });

    const result = await executePolishLifecycleV2(
      input(denied.controller),
      denied.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "RESERVATION_UNKNOWN",
      stage: "reserve",
      settlement: "not_reserved",
    });
    expect(JSON.stringify(result)).not.toContain("SENSITIVE_INTERNAL_DENIAL");
    expect(denied.state.providerCalls).toHaveLength(0);

    const routeChanged = createHarness({
      reserve: async () => {
        throw new PolishLifecycleV2RpcError("RESERVE_DENIED", {
          reason: "AI_ROUTE_CHANGED",
        });
      },
    });
    await expect(
      executePolishLifecycleV2(input(routeChanged.controller), routeChanged.deps),
    ).resolves.toMatchObject({
      ok: false,
      code: "AI_ROUTE_CHANGED",
      stage: "reserve",
      settlement: "not_reserved",
    });
  });

  it("releases the reservation and performs zero starts/transmissions on snapshot failure", async () => {
    const snapshotCalls: string[] = [];
    const harness = createHarness({
      getExecutionSnapshot: async () => {
        snapshotCalls.push("snapshot");
        throw new PolishLifecycleV2RpcError("SNAPSHOT_INVALID", {
          reason: "EXECUTION_AUTHORITY_MISMATCH",
        });
      },
    });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_INVALID",
      stage: "execution_snapshot",
      attemptCount: 0,
      settlement: "confirmed",
    });
    expect(harness.state.providerCalls).toHaveLength(0);
    expect(snapshotCalls).toEqual(["snapshot"]);
    expect(harness.state.calls).toEqual(["reserve", "finalize"]);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "released",
      p_quota_charged: false,
      p_provider_billable: false,
      p_usage: null,
    });
    expect(harness.state.finalizePayloads[0].p_metadata).not.toHaveProperty(
      "usage_schema_version",
    );
  });

  it.each([
    ["NOT_FOUND", "EXECUTION_NOT_FOUND"],
    ["ALREADY_FINALIZED", "EXECUTION_ALREADY_FINALIZED"],
  ] as const)(
    "does not invent settlement authority for a %s execution snapshot",
    async (reason, code) => {
      const harness = createHarness({
        getExecutionSnapshot: async () => {
          throw new PolishLifecycleV2RpcError("SNAPSHOT_DENIED", { reason });
        },
      });

      const result = await executePolishLifecycleV2(
        input(harness.controller),
        harness.deps,
      );

      expect(result).toMatchObject({
        ok: false,
        code,
        stage: "execution_snapshot",
        attemptCount: 0,
        settlement: "not_attempted",
      });
      expect(harness.state.providerCalls).toHaveLength(0);
      expect(harness.state.finalizeRequests).toHaveLength(0);
    },
  );

  it("releases a confirmed reservation when snapshot availability fails pre-start", async () => {
    const harness = createHarness({
      getExecutionSnapshot: async () => {
        throw new PolishLifecycleV2RpcError("SNAPSHOT_UNAVAILABLE", {
          reason: "RPC_ERROR",
        });
      },
    });

    const result = await executePolishLifecycleV2(
      input(harness.controller),
      harness.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      stage: "execution_snapshot",
      attemptCount: 0,
      settlement: "confirmed",
    });
    expect(harness.state.providerCalls).toHaveLength(0);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "released",
      p_quota_charged: false,
    });
  });

  it("zero-child releases a route bound to a different reviewed runtime ID", async () => {
    const harness = createHarness({
      runtimeTargetResolver: DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1,
    });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      stage: "execution_snapshot",
      attemptCount: 0,
      settlement: "confirmed",
    });
    expect(harness.state.calls).toEqual(["reserve", "snapshot", "finalize"]);
    expect(harness.state.providerCalls).toHaveLength(0);
    expect(harness.state.completionPayloads).toHaveLength(0);
    expect(harness.state.finalizeRequests).toEqual([
      expect.objectContaining({
        settlementKind: "zero_child_release",
      }),
    ]);
  });

  it("releases before start when adapter or subject resolution is unavailable", async () => {
    const resolverCalls: string[] = [];
    const harness = createHarness({
      resolveProvider: () => {
        resolverCalls.push("resolve_provider");
        throw new Error("credential detail that must stay internal");
      },
    });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "PROFILE_UNAVAILABLE",
      stage: "profile_resolution",
      settlement: "confirmed",
    });
    expect(harness.state.calls).toEqual([
      "reserve",
      "snapshot",
      "finalize",
    ]);
    expect(resolverCalls).toEqual(["resolve_provider"]);
    expect(JSON.stringify(result)).not.toContain("credential detail");
    expect(harness.state.providerCalls).toHaveLength(0);
  });

  it("does not transmit or finalize a first-observation start replay", async () => {
    const startCalls: string[] = [];
    const harness = createHarness({
      startAttempt: async () => {
        startCalls.push("start:1");
        throw new PolishLifecycleV2RpcError("ATTEMPT_START_REPLAY", {
          reason: "FIRST_OBSERVATION_REPLAY",
        });
      },
    });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "ATTEMPT_STATE_UNKNOWN",
      stage: "attempt_start",
      settlement: "not_attempted",
    });
    expect(startCalls).toEqual(["start:1"]);
    expect(harness.state.providerCalls).toHaveLength(0);
    expect(harness.state.finalizeRequests).toHaveLength(0);
  });

  it("zero-child releases a definite first-attempt operational denial", async () => {
    const harness = createHarness({
      startAttempt: async () => {
        throw new PolishLifecycleV2RpcError("ATTEMPT_START_DENIED", {
          reason: "AI_DISABLED",
        });
      },
    });

    const result = await executePolishLifecycleV2(
      input(harness.controller),
      harness.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "AI_DISABLED",
      stage: "attempt_start",
      attemptCount: 0,
      settlement: "confirmed",
    });
    expect(harness.state.providerCalls).toHaveLength(0);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "released",
      p_quota_charged: false,
      p_usage: null,
    });
    expect(harness.state.finalizePayloads[0].p_metadata).not.toHaveProperty(
      "usage_schema_version",
    );
  });

  it("provides a distinct, safety-gated V2 fake backend without widening V1 deps", async () => {
    const providerV2 = createFakePolishInferenceProvider({
      delayMs: 0,
      route: {
        actualUpstreamEndpoint: "https://api.deepseek.com/chat/completions",
        actualModelId: ROUTE.modelId,
      },
    });
    const deps = createFakePolishV2RouteDeps({
      provider: createFakePolishProvider({ delayMs: 0 }),
      providerV2,
      env: {
        POLISH_FAKE_LLM: "true",
        POLISH_FAKE_BACKEND: "true",
        AI_POLISH_ENABLED: "true",
      },
    });

    const result = await executePolishLifecycleV2(input(), deps);

    expect(result).toMatchObject({ ok: true, attemptCount: 1, settlement: "confirmed" });
    expect(deps.providerV2).toBe(providerV2);
    expect(deps.legacyV1.aiPolishEnabled).toBe(true);
    const disabledDeps = createFakePolishV2RouteDeps({
      provider: createFakePolishProvider({ delayMs: 0 }),
      providerV2,
      env: {
        POLISH_FAKE_LLM: "true",
        POLISH_FAKE_BACKEND: "true",
        AI_POLISH_ENABLED: "false",
      },
    });
    await expect(executePolishLifecycleV2(input(), disabledDeps)).resolves.toMatchObject({
      ok: false,
      code: "AI_DISABLED",
      stage: "reserve",
      attemptCount: 0,
      settlement: "not_reserved",
    });
    expect(() =>
      createFakePolishV2RouteDeps({
        provider: createFakePolishProvider({ delayMs: 0 }),
        providerV2,
        env: { POLISH_FAKE_LLM: "true", POLISH_FAKE_BACKEND: "false" },
      }),
    ).toThrow("both fake safety gates");
    expect(() =>
      createFakePolishV2RouteDeps({
        provider: createFakePolishProvider({ delayMs: 0 }),
        providerV2,
        env: {
          POLISH_FAKE_LLM: "true",
          POLISH_FAKE_BACKEND: "true",
          NODE_ENV: "production",
        },
      }),
    ).toThrow("forbidden outside the production CI smoke");
  });
});

describe("executePolishLifecycleV2 — terminal facts and settlement", () => {
  it("persists both retry attempts before one child-backed upstream-failure settlement", async () => {
    const rawProviderError = () =>
      Promise.reject(
        Object.assign(new Error("sensitive upstream response body"), {
          code: "UPSTREAM_ERROR",
          upstreamStatus: 503,
          providerRequestId: "req_FAILURE1234",
        }),
      );
    const harness = createHarness({
      providerBehaviors: [rawProviderError, rawProviderError],
    });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "UPSTREAM_ERROR",
      attemptCount: 2,
      settlement: "confirmed",
    });
    expect(harness.state.calls).toEqual([
      "reserve",
      "snapshot",
      "resolve_provider",
      "start:1",
      "provider:1",
      "complete:1",
      "start:2",
      "provider:2",
      "complete:2",
      "finalize",
    ]);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "failed_upstream",
      p_quota_charged: false,
      p_provider_billable: null,
      p_usage: null,
      p_metadata: { usage_schema_version: "attempt_v2" },
    });
    expect(JSON.stringify(harness.state.logs)).not.toContain("sensitive upstream");
    expect(JSON.stringify(harness.state.completionPayloads)).not.toContain(
      "req_FAILURE1234",
    );
  });

  it("persists invalid output for both attempts and refunds through child aggregation", async () => {
    const invalid = async () => successfulProviderResult("not-json");
    const harness = createHarness({ providerBehaviors: [invalid, invalid] });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_MODEL_OUTPUT",
      attemptCount: 2,
      settlement: "confirmed",
    });
    expect(harness.state.completionPayloads.map((payload) => payload.p_status)).toEqual([
      "invalid_output",
      "invalid_output",
    ]);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "invalid_output",
      p_quota_charged: false,
      p_provider_billable: true,
    });
  });

  it("stops after one transmission when terminal fact persistence is unknown", async () => {
    const completionCalls: string[] = [];
    const harness = createHarness({
      providerBehaviors: [async () => successfulProviderResult()],
      completeAttempt: async (params) => {
        completionCalls.push("complete:1");
        serializePolishAttemptCompletionV2(params);
        throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_UNKNOWN", {
          reason: "RPC_ERROR",
        });
      },
    });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "ATTEMPT_PERSISTENCE_ERROR",
      stage: "attempt_complete",
      attemptCount: 1,
      settlement: "not_attempted",
    });
    expect(completionCalls).toEqual(["complete:1"]);
    expect(harness.state.providerCalls).toHaveLength(1);
    expect(harness.state.finalizeRequests).toHaveLength(0);
  });

  it("uses attempt_v2 for cancellation after admission and zero-child release before admission", async () => {
    const afterStartController = new AbortController();
    const abort = new DOMException("caller disconnected", "AbortError");
    const afterStart = createHarness({
      controller: afterStartController,
      providerBehaviors: [async () => {
        afterStartController.abort(abort);
        throw abort;
      }],
    });

    const afterStartResult = await executePolishLifecycleV2(
      input(afterStartController),
      afterStart.deps,
    );
    expect(afterStartResult).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(afterStart.state.completionPayloads[0]).toMatchObject({
      p_status: "canceled",
      p_provider_billable: null,
    });
    expect(afterStart.state.finalizePayloads[0]).toMatchObject({
      p_status: "canceled",
      p_quota_charged: true,
      p_metadata: { usage_schema_version: "attempt_v2" },
    });

    const beforeStartController = new AbortController();
    const resolverCalls: string[] = [];
    const neverProvider: PolishInferenceProviderV2 = {
      async complete() {
        throw new Error("provider must not be called after pre-start cancellation");
      },
    };
    const beforeStart = createHarness({
      controller: beforeStartController,
      resolveProvider: () => {
        resolverCalls.push("resolve_provider");
        beforeStartController.abort(abort);
        return neverProvider;
      },
    });

    const beforeStartResult = await executePolishLifecycleV2(
      input(beforeStartController),
      beforeStart.deps,
    );
    expect(beforeStartResult).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 0,
      settlement: "confirmed",
    });
    expect(beforeStart.state.providerCalls).toHaveLength(0);
    expect(resolverCalls).toEqual(["resolve_provider"]);
    expect(beforeStart.state.finalizePayloads[0]).toMatchObject({
      p_status: "released",
      p_quota_charged: false,
    });
    expect(beforeStart.state.finalizePayloads[0].p_metadata).not.toHaveProperty(
      "usage_schema_version",
    );
  });

  it("records cancellation before returning when completion response is lost", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      controller,
      completeAttempt: async (params) => {
        serializePolishAttemptCompletionV2(params);
        controller.abort(new DOMException("caller disconnected", "AbortError"));
        throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_UNKNOWN", {
          reason: "RPC_ERROR",
        });
      },
    });

    const result = await executePolishLifecycleV2(input(controller), harness.deps);
    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 1,
      settlement: "unknown",
    });
    expect(harness.state.calls).toContain("record_cancellation");
    expect(harness.state.finalizeRequests).toHaveLength(0);
  });

  it("records cancellation before returning from ambiguous attempt admission", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      controller,
      startAttempt: async () => {
        controller.abort(new DOMException("caller disconnected", "AbortError"));
        throw new PolishLifecycleV2RpcError("ATTEMPT_START_UNKNOWN", {
          reason: "RPC_ERROR",
        });
      },
    });
    const result = await executePolishLifecycleV2(input(controller), harness.deps);
    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      settlement: "unknown",
    });
    expect(harness.state.calls).toContain("record_cancellation");
    expect(harness.state.finalizeRequests).toHaveLength(0);
  });

  it("durably marks cancellation during a nonzero retry delay before settlement", async () => {
    const controller = new AbortController();
    const abort = new DOMException("caller disconnected", "AbortError");
    const harness = createHarness({
      controller,
      providerBehaviors: [async () =>
        Promise.reject(
          Object.assign(new Error("retry later"), {
            code: "UPSTREAM_ERROR",
            upstreamStatus: 429,
            retryable: true,
            retryAfterMs: 1_000,
          }),
        )],
      sleep: async (delayMs) => {
        expect(delayMs).toBe(1_000);
        controller.abort(abort);
        throw abort;
      },
    });

    const result = await executePolishLifecycleV2(input(controller), harness.deps);
    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(harness.state.calls).toContain("record_cancellation");
    expect(harness.state.calls.indexOf("record_cancellation")).toBeLessThan(
      harness.state.calls.indexOf("finalize"),
    );
    expect(harness.state.providerCalls).toHaveLength(1);
  });

  it("observes abort while terminal completion persistence is awaited", async () => {
    const controller = new AbortController();
    const abort = new DOMException("caller disconnected", "AbortError");
    const harness = createHarness({
      controller,
      completeAttempt: async (params) => {
        serializePolishAttemptCompletionV2(params);
        controller.abort(abort);
        return {
          ok: true,
          alreadyCompleted: false,
          status: params.fact.status,
          usageComplete: true,
        };
      },
    });

    const result = await executePolishLifecycleV2(input(controller), harness.deps);
    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(harness.state.calls).toContain("record_cancellation");
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "canceled",
      p_quota_charged: true,
    });
  });

  it("cancels after invalid output and before attempt 2 without losing the charged child", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      controller,
      providerBehaviors: [async () => successfulProviderResult("not-json")],
      completeAttempt: async (params) => {
        const payload = serializePolishAttemptCompletionV2(params);
        expect(payload).toMatchObject({
          p_status: "invalid_output",
          p_transmitted: true,
          p_retry_eligible: true,
        });
        controller.abort(new DOMException("caller disconnected", "AbortError"));
        return {
          ok: true,
          alreadyCompleted: false,
          status: params.fact.status,
          usageComplete: true,
        };
      },
    });
    const result = await executePolishLifecycleV2(input(controller), harness.deps);
    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(harness.state.providerCalls).toHaveLength(1);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "canceled",
      p_quota_charged: true,
    });
  });

  it("refunds durable cancellation proved before adapter entry", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      controller,
      startAttempt: async (params) => {
        controller.abort(new DOMException("caller disconnected", "AbortError"));
        return attemptReceipt(params.attemptNo);
      },
    });
    const result = await executePolishLifecycleV2(input(controller), harness.deps);
    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(harness.state.providerCalls).toHaveLength(0);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "canceled",
      p_quota_charged: false,
    });
  });

  it("reports ambiguous cancellation authority as unknown and never finalizes", async () => {
    const controller = new AbortController();
    const abort = new DOMException("caller disconnected", "AbortError");
    const harness = createHarness({
      controller,
      providerBehaviors: [async () => {
        controller.abort(abort);
        throw abort;
      }],
      recordCancellation: async () => {
        throw new PolishLifecycleV2RpcError("CANCELLATION_UNKNOWN", {
          reason: "RPC_ERROR",
        });
      },
    });

    const result = await executePolishLifecycleV2(input(controller), harness.deps);
    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      attemptCount: 1,
      settlement: "unknown",
    });
    expect(harness.state.finalizeRequests).toHaveLength(0);
  });

  it("lets durable cancellation win without waiting for a stranded finalize call", async () => {
    const controller = new AbortController();
    const firstFinalizeStarted = deferred();
    const strandedFinalize = deferred();
    let finalizeCall = 0;
    const harness = createHarness({
      controller,
      finalize: async (params) => {
        finalizeCall += 1;
        if (finalizeCall === 1) {
          firstFinalizeStarted.resolve(undefined);
          await strandedFinalize.promise;
          throw new PolishLifecycleV2RpcError("FINALIZE_REJECTED", {
            reason: "SETTLEMENT_ASSERTION_CONFLICT",
          });
        }
        return successfulFinalizeResult(params);
      },
    });

    const pending = executePolishLifecycleV2(input(controller), harness.deps);
    await firstFinalizeStarted.promise;
    controller.abort(new DOMException("caller disconnected", "AbortError"));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "CANCELED",
      stage: "canceled",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(harness.state.calls.indexOf("record_cancellation")).toBeGreaterThan(
      harness.state.calls.indexOf("finalize"),
    );
    expect(harness.state.finalizePayloads.map((payload) => payload.p_status)).toEqual([
      "succeeded",
      "canceled",
    ]);
    expect(harness.state.finalizeCallOptions[0].signal).toBe(controller.signal);
    expect(harness.state.finalizeCallOptions[1].signal).toBeUndefined();
  });

  it("rechecks an abort that lands immediately before settlement listener registration", async () => {
    const controller = new AbortController();
    let abortBeforeNextListener = false;
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === "addEventListener") {
          return (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: boolean | AddEventListenerOptions,
          ) => {
            if (abortBeforeNextListener) {
              abortBeforeNextListener = false;
              controller.abort(
                new DOMException("caller disconnected", "AbortError"),
              );
            }
            if (listener !== null) {
              target.addEventListener(type, listener, options);
            }
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const harness = createHarness({
      controller,
      providerBehaviors: [async () => {
        abortBeforeNextListener = true;
        return successfulProviderResult();
      }],
    });

    const result = await executePolishLifecycleV2(
      Object.freeze({ ...input(controller), signal }),
      harness.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "CANCELED",
      stage: "canceled",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(harness.state.calls).toContain("record_cancellation");
    expect(harness.state.finalizePayloads).toHaveLength(1);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "canceled",
      p_quota_charged: true,
    });
  });

  it.each([
    {
      name: "failed upstream",
      behaviors: () => {
        const fail = async () =>
          Promise.reject(
            Object.assign(new Error("upstream unavailable"), {
              code: "UPSTREAM_ERROR",
              upstreamStatus: 503,
            }),
          );
        return [fail, fail] as const;
      },
      childStatus: "failed_upstream",
      requestedStatus: "failed_upstream",
    },
    {
      name: "timed out",
      behaviors: () => {
        const timeout = async () =>
          Promise.reject(
            Object.assign(new Error("provider timeout"), {
              code: "UPSTREAM_TIMEOUT",
            }),
          );
        return [timeout, timeout] as const;
      },
      childStatus: "timed_out",
      requestedStatus: "failed_upstream",
    },
    {
      name: "invalid output",
      behaviors: () => {
        const invalid = async () => successfulProviderResult("not-json");
        return [invalid, invalid] as const;
      },
      childStatus: "invalid_output",
      requestedStatus: "invalid_output",
    },
  ])(
    "keeps transmitted $name attempts charged when cancellation wins settlement",
    async ({ behaviors, childStatus, requestedStatus }) => {
      const controller = new AbortController();
      const firstFinalizeStarted = deferred();
      const releaseFirstFinalize = deferred();
      let finalizeCall = 0;
      const harness = createHarness({
        controller,
        providerBehaviors: behaviors(),
        finalize: async (params) => {
          finalizeCall += 1;
          if (finalizeCall === 1) {
            firstFinalizeStarted.resolve(undefined);
            await releaseFirstFinalize.promise;
            throw new PolishLifecycleV2RpcError("FINALIZE_REJECTED", {
              reason: "SETTLEMENT_ASSERTION_CONFLICT",
            });
          }
          return successfulFinalizeResult(params);
        },
      });

      const pending = executePolishLifecycleV2(input(controller), harness.deps);
      await firstFinalizeStarted.promise;
      controller.abort(new DOMException("caller disconnected", "AbortError"));
      releaseFirstFinalize.resolve(undefined);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "CANCELED",
        attemptCount: 2,
        settlement: "confirmed",
      });
      expect(
        harness.state.completionPayloads.map((payload) => payload.p_status),
      ).toEqual([childStatus, childStatus]);
      expect(harness.state.finalizePayloads).toHaveLength(2);
      expect(harness.state.finalizePayloads[0].p_status).toBe(requestedStatus);
      expect(harness.state.finalizePayloads[1]).toMatchObject({
        p_status: "canceled",
        p_quota_charged: true,
      });
    },
  );

  it("preserves finalize-first exact replay after committed response loss", async () => {
    const controller = new AbortController();
    const firstFinalizeStarted = deferred();
    const strandedFinalize = deferred();
    let finalizeCall = 0;
    const harness = createHarness({
      controller,
      recordCancellation: async () => {
        throw new PolishLifecycleV2RpcError("CANCELLATION_REJECTED", {
          reason: "ALREADY_FINALIZED",
        });
      },
      finalize: async (params) => {
        finalizeCall += 1;
        if (finalizeCall === 1) {
          firstFinalizeStarted.resolve(undefined);
          await strandedFinalize.promise;
          throw new PolishLifecycleV2RpcError("FINALIZE_UNKNOWN", {
            reason: "CANCELED_BEFORE_RETRY",
          });
        }
        return successfulFinalizeResult(params, true);
      },
    });

    const pending = executePolishLifecycleV2(input(controller), harness.deps);
    await firstFinalizeStarted.promise;
    controller.abort(new DOMException("caller disconnected", "AbortError"));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "CANCELED",
      settlement: "confirmed",
    });
    expect(harness.state.finalizePayloads).toHaveLength(2);
    expect(harness.state.finalizePayloads[0]).toEqual(
      harness.state.finalizePayloads[1],
    );
    expect(harness.state.finalizePayloads[1].p_status).toBe("succeeded");
    expect(harness.state.finalizeCallOptions[1].signal).toBeUndefined();
  });

  it("holds unknown when cancellation persistence is ambiguous during settlement", async () => {
    const controller = new AbortController();
    const firstFinalizeStarted = deferred();
    const strandedFinalize = deferred();
    const harness = createHarness({
      controller,
      recordCancellation: async () => {
        throw new PolishLifecycleV2RpcError("CANCELLATION_UNKNOWN", {
          reason: "RPC_ERROR",
        });
      },
      finalize: async () => {
        firstFinalizeStarted.resolve(undefined);
        await strandedFinalize.promise;
        throw new PolishLifecycleV2RpcError("FINALIZE_UNKNOWN", {
          reason: "CANCELED_BEFORE_RETRY",
        });
      },
    });

    const pending = executePolishLifecycleV2(input(controller), harness.deps);
    await firstFinalizeStarted.promise;
    controller.abort(new DOMException("caller disconnected", "AbortError"));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "CANCELED",
      settlement: "unknown",
    });
    expect(harness.state.finalizeRequests).toHaveLength(1);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "succeeded",
      p_quota_charged: true,
    });
  });

  it("releases a zero-child reservation when cancellation wins during finalization", async () => {
    const controller = new AbortController();
    const firstFinalizeStarted = deferred();
    const releaseFirstFinalize = deferred();
    const harness = createHarness({
      controller,
      resolveProvider: () => {
        throw new PolishAdapterUnavailableV2Error();
      },
      finalize: async (params) => {
        firstFinalizeStarted.resolve(undefined);
        await releaseFirstFinalize.promise;
        return successfulFinalizeResult(params);
      },
    });

    const pending = executePolishLifecycleV2(input(controller), harness.deps);
    await firstFinalizeStarted.promise;
    controller.abort(new DOMException("caller disconnected", "AbortError"));
    releaseFirstFinalize.resolve(undefined);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "CANCELED",
      stage: "canceled",
      attemptCount: 0,
      settlement: "confirmed",
    });
    expect(harness.state.finalizePayloads).toHaveLength(2);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "released",
      p_quota_charged: false,
    });
    expect(harness.state.finalizePayloads[1]).toEqual(
      harness.state.finalizePayloads[0],
    );
  });

  it("retains the first terminal child when the second start is denied", async () => {
    const startCalls: string[] = [];
    const firstFailure = async () =>
      Promise.reject(
        Object.assign(new Error("upstream unavailable"), {
          code: "UPSTREAM_ERROR",
          upstreamStatus: 503,
        }),
      );
    const harness = createHarness({
      providerBehaviors: [firstFailure],
      startAttempt: async (params) => {
        startCalls.push(`start:${params.attemptNo}`);
        if (params.attemptNo === 2) {
          throw new PolishLifecycleV2RpcError("ATTEMPT_START_DENIED", {
            reason: "AI_DISABLED",
          });
        }
        return attemptReceipt(1);
      },
    });

    const result = await executePolishLifecycleV2(input(harness.controller), harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "AI_DISABLED",
      attemptCount: 1,
      settlement: "confirmed",
    });
    expect(harness.state.providerCalls).toHaveLength(1);
    expect(startCalls).toEqual(["start:1", "start:2"]);
    expect(harness.state.completionPayloads).toHaveLength(1);
    expect(harness.state.finalizePayloads[0]).toMatchObject({
      p_status: "failed_upstream",
      p_metadata: { usage_schema_version: "attempt_v2" },
    });
  });

  it("serves verified success on unknown settlement but withholds on conflict", async () => {
    const unknown = createHarness({
      finalize: async () => {
        throw new PolishLifecycleV2RpcError("FINALIZE_UNKNOWN", {
          reason: "RPC_ERROR",
        });
      },
    });
    const unknownResult = await executePolishLifecycleV2(
      input(unknown.controller),
      unknown.deps,
    );
    expect(unknownResult).toMatchObject({
      ok: true,
      settlement: "unknown",
      quota: { limit: 20, remaining: 19 },
    });

    const conflict = createHarness({
      finalize: async () => {
        throw new PolishLifecycleV2RpcError("FINALIZE_CONFLICT", {
          reason: "READBACK_MISMATCH",
        });
      },
    });
    const conflictResult = await executePolishLifecycleV2(
      input(conflict.controller),
      conflict.deps,
    );
    expect(conflictResult).toMatchObject({
      ok: false,
      code: "SETTLEMENT_CONFLICT",
      settlement: "conflict",
    });
  });
});
