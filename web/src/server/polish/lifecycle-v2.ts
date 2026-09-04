import {
  polishRequestSchema,
  type PolishRequest,
} from "@/lib/polish/contract";
import { createDeepSeekChatV1Adapter } from "./deepseek";
import { createMimoResponsesV1Adapter } from "./mimo";
import {
  parseExpectedRouteV1,
  type ExpectedRouteV1,
  type RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V2,
  type RuntimeTargetResolverV2,
} from "./execution-snapshot-v2";
import { isAbortError } from "./lifecycle-settlement";
import {
  aggregatePolishAttemptFactsV2,
  orchestratePolishV2,
  PolishAttemptPersistenceErrorV2,
  PolishOrchestrationErrorV2,
  POLISH_PROMPT_VERSION,
  POLISH_VALIDATOR_VERSION,
  type PolishAttemptCompletedFactV2,
  type PolishInferenceProviderV2,
  type RequestUsageAggregateV2,
} from "./orchestrator";
import {
  validateVersionedProfileExecutionConfig,
  type ProfileExecutionConfig,
} from "./profile-execution-v2";
import { deriveProviderSubjectIdV2 } from "./provider-subject-v2";
import {
  isPreparedProviderExecutionV2,
  readPreparedProviderExecutionV2,
  type PreparedProviderExecutionV2,
} from "./prepared-provider-execution-v2";
import type { RuntimeDeploymentAdmissionV2 } from "./runtime-deployment-v1";
import type { RuntimeExecutionTargetV2 } from "./execution-snapshot-v2";
import {
  getPolishExecutionSnapshotV2,
  PolishLifecycleV2RpcError,
  reservePolishRequestV2,
  type PolishFinalizeCallOptionsV2,
  type PolishFinalizeRequestV2,
  type PolishFinalizeResultV2,
  type ProviderAttemptStartV2,
  completePolishProviderAttemptV2,
  recordPolishRequestCancellationV2,
  startPolishProviderAttemptV2,
} from "./quota";

const CANONICAL_UUID_V2 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type PolishLifecycleV2FailureCode =
  | "INVALID_INPUT"
  | "AI_DISABLED"
  | "SERVICE_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "DUPLICATE_REQUEST"
  | "REQUEST_IN_PROGRESS"
  | "AI_ROUTE_CHANGED"
  | "AI_TERMS_REQUIRED"
  | "RESERVATION_UNKNOWN"
  | "EXECUTION_NOT_FOUND"
  | "EXECUTION_ALREADY_FINALIZED"
  | "EXECUTION_INVALID"
  | "PROFILE_UNAVAILABLE"
  | "ATTEMPT_START_DENIED"
  | "ATTEMPT_STATE_UNKNOWN"
  | "ATTEMPT_PERSISTENCE_ERROR"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "INVALID_MODEL_OUTPUT"
  | "CANCELED"
  | "SETTLEMENT_CONFLICT"
  | "SETTLEMENT_REJECTED"
  | "INTERNAL_ERROR";

const SAFE_RESERVE_DENIAL_CODES_V2: ReadonlySet<string> = new Set(
  [
    "AI_DISABLED",
    "SERVICE_UNAVAILABLE",
    "QUOTA_EXCEEDED",
    "RATE_LIMITED",
    "DUPLICATE_REQUEST",
    "REQUEST_IN_PROGRESS",
    "AI_ROUTE_CHANGED",
    "AI_TERMS_REQUIRED",
  ] as const satisfies readonly PolishLifecycleV2FailureCode[],
);

function isSafeReserveDenialCodeV2(
  value: string | undefined,
): value is PolishLifecycleV2FailureCode {
  return (
    value !== undefined &&
    SAFE_RESERVE_DENIAL_CODES_V2.has(value)
  );
}

export type PolishLifecycleV2Stage =
  | "input"
  | "reserve"
  | "execution_snapshot"
  | "profile_resolution"
  | "attempt_start"
  | "attempt_complete"
  | "provider"
  | "settlement"
  | "canceled";

export type PolishLifecycleV2SettlementDisposition =
  | "not_reserved"
  | "not_attempted"
  | "confirmed"
  | "unknown"
  | "conflict"
  | "rejected";

export interface PolishLifecycleV2LogEvent {
  readonly event:
    | "polish.v2.completed"
    | "polish.v2.failed"
    | "polish.v2.settlement_unknown";
  readonly requestId: string | null;
  readonly code?: PolishLifecycleV2FailureCode;
  readonly stage?: PolishLifecycleV2Stage;
  readonly attemptCount: number;
  readonly settlement: PolishLifecycleV2SettlementDisposition;
}

export interface PolishLifecycleV2Success {
  readonly ok: true;
  readonly requestId: string;
  readonly items: readonly Readonly<{ id: string; polished: string }>[];
  readonly quota: Readonly<{ limit: number; remaining: number; resetAt: string }>;
  readonly profileVersionId: string;
  readonly displayDisclosureKey: string;
  readonly attemptCount: number;
  readonly settlement: "confirmed" | "unknown";
}

export interface PolishLifecycleV2Failure {
  readonly ok: false;
  readonly requestId: string | null;
  readonly code: PolishLifecycleV2FailureCode;
  readonly stage: PolishLifecycleV2Stage;
  readonly attemptCount: number;
  readonly settlement: PolishLifecycleV2SettlementDisposition;
  readonly resetAt?: string;
  readonly retryAfterSeconds?: number;
  readonly remaining?: number;
}

export type PolishLifecycleV2Result =
  | PolishLifecycleV2Success
  | PolishLifecycleV2Failure;

export interface PolishLifecycleV2Input {
  readonly authenticatedUserId: string;
  readonly requestId: string;
  readonly clientRequestId: string;
  readonly request: PolishRequest;
  readonly expectedRoute: ExpectedRouteV1;
  readonly signal: AbortSignal;
}

export type PolishAdapterResolverV2 = (
  profile: Readonly<ProfileExecutionConfig>,
  target?: Readonly<RuntimeExecutionTargetV2>,
) => PolishInferenceProviderV2 | PreparedProviderExecutionV2;

export interface PolishRouteDepsV2 {
  readonly runtimeDeploymentIdentity?: Readonly<{
    environment: string;
    projectRef: string;
    runtimeBuildId: string;
    bindingManifestRevision: string;
    bindingManifestSha256: string;
  }>;
  readonly reserve: (
    params: Parameters<typeof reservePolishRequestV2>[1],
  ) => ReturnType<typeof reservePolishRequestV2>;
  readonly getExecutionSnapshot: (
    params: Parameters<typeof getPolishExecutionSnapshotV2>[1],
  ) => ReturnType<typeof getPolishExecutionSnapshotV2>;
  readonly startAttempt: (
    params: Parameters<typeof startPolishProviderAttemptV2>[1],
  ) => ReturnType<typeof startPolishProviderAttemptV2>;
  readonly completeAttempt: (
    params: Parameters<typeof completePolishProviderAttemptV2>[1],
  ) => ReturnType<typeof completePolishProviderAttemptV2>;
  readonly recordCancellation: (
    params: Parameters<typeof recordPolishRequestCancellationV2>[1],
  ) => ReturnType<typeof recordPolishRequestCancellationV2>;
  readonly finalize: (
    params: PolishFinalizeRequestV2,
    options?: PolishFinalizeCallOptionsV2,
  ) => Promise<PolishFinalizeResultV2>;
  readonly runtimeTargetResolver: RuntimeTargetResolverV1;
  readonly runtimeTargetResolverV2?: RuntimeTargetResolverV2;
  readonly resolveProvider: PolishAdapterResolverV2;
  readonly providerSubjectSecret: string;
  readonly routeObservationSecret: string;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly logger?: (event: PolishLifecycleV2LogEvent) => void;
}

export class PolishAdapterUnavailableV2Error extends Error {
  readonly code = "PROFILE_UNAVAILABLE" as const;

  constructor() {
    super("The frozen AI provider profile is not available in this runtime.");
    this.name = "PolishAdapterUnavailableV2Error";
  }
}

/** Code-owned resolver for the reviewed DeepSeek and MiMo adapter sources. */
export function createCodeOwnedPolishAdapterResolverV2(
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof fetch;
  } = {},
): PolishAdapterResolverV2 {
  return (profile, target) => {
    let registeredProfile: ProfileExecutionConfig;
    try {
      // Revalidate at the operational boundary so a crossed profile, adapter,
      // credential, endpoint, or other runtime tuple cannot select a provider.
      registeredProfile = validateVersionedProfileExecutionConfig(profile);
    } catch {
      throw new PolishAdapterUnavailableV2Error();
    }

    if (registeredProfile.schemaVersion === "profile_execution_config_v2" && target !== undefined) {
      throw new PolishAdapterUnavailableV2Error();
    }

    if (
      registeredProfile.schemaVersion === "profile_execution_config_v1" &&
      registeredProfile.profileKey ===
        "deepseek.official.deepseek-v4-flash.chat.v1" &&
      registeredProfile.adapterKind === "deepseek_chat_v1"
    ) {
      return createDeepSeekChatV1Adapter({
        env: options.env,
        fetch: options.fetch,
      });
    }
    if (
      registeredProfile.schemaVersion === "profile_execution_config_v1" &&
      registeredProfile.profileKey === "mimo.cn.mimo-v2.5-pro.responses.v1" &&
      registeredProfile.adapterKind === "mimo_responses_v1"
    ) {
      return createMimoResponsesV1Adapter({
        env: options.env,
        fetch: options.fetch,
      });
    }
    throw new PolishAdapterUnavailableV2Error();
  };
}

interface ParsedLifecycleInputV2 {
  readonly authenticatedUserId: string;
  readonly requestId: string;
  readonly clientRequestId: string;
  readonly request: PolishRequest;
  readonly expectedRoute: ExpectedRouteV1;
  readonly signal: AbortSignal;
}

interface SettlementObservationV2 {
  readonly disposition:
    | "confirmed"
    | "unknown"
    | "conflict"
    | "rejected";
  readonly result?: PolishFinalizeResultV2;
}

interface CancellationAwareSettlementObservationV2
  extends SettlementObservationV2 {
  readonly cancellationRequested: boolean;
}

type CancellationAuthorityObservationV2 =
  | "observed"
  | "finalized_first"
  | "unknown";

function safeRequestIdV2(value: unknown): string | null {
  return typeof value === "string" && CANONICAL_UUID_V2.test(value) ? value : null;
}

function parseLifecycleInputV2(input: PolishLifecycleV2Input): ParsedLifecycleInputV2 {
  if (
    typeof input !== "object" ||
    input === null ||
    !CANONICAL_UUID_V2.test(input.authenticatedUserId) ||
    !CANONICAL_UUID_V2.test(input.requestId) ||
    !CANONICAL_UUID_V2.test(input.clientRequestId) ||
    !(input.signal instanceof AbortSignal)
  ) {
    throw new Error("invalid lifecycle input");
  }
  const request = polishRequestSchema.safeParse(input.request);
  if (!request.success || request.data.clientRequestId !== input.clientRequestId) {
    throw new Error("invalid lifecycle request");
  }
  const expectedRoute = parseExpectedRouteV1(input.expectedRoute);
  return Object.freeze({
    authenticatedUserId: input.authenticatedUserId,
    requestId: input.requestId,
    clientRequestId: input.clientRequestId,
    request: request.data,
    expectedRoute,
    signal: input.signal,
  });
}

function safeLogV2(
  logger: PolishRouteDepsV2["logger"],
  event: PolishLifecycleV2LogEvent,
): void {
  try {
    logger?.(Object.freeze({ ...event }));
  } catch {
    // Observability is never lifecycle authority.
  }
}

function failureV2(
  logger: PolishRouteDepsV2["logger"],
  params: Omit<PolishLifecycleV2Failure, "ok">,
): PolishLifecycleV2Failure {
  const failure = Object.freeze({ ok: false as const, ...params });
  safeLogV2(logger, {
    event:
      params.settlement === "unknown"
        ? "polish.v2.settlement_unknown"
        : "polish.v2.failed",
    requestId: params.requestId,
    code: params.code,
    stage: params.stage,
    attemptCount: params.attemptCount,
    settlement: params.settlement,
  });
  return failure;
}

function requestMetadataV2(request: PolishRequest) {
  return Object.freeze({
    granularity: request.granularity,
    itemCount: request.items.length,
    contextLevel: request.context.level,
    language: request.language,
    promptVersion: POLISH_PROMPT_VERSION,
    validatorVersion: POLISH_VALIDATOR_VERSION,
  });
}

async function observeSettlementV2(
  deps: PolishRouteDepsV2,
  params: PolishFinalizeRequestV2,
  options: PolishFinalizeCallOptionsV2 = {},
): Promise<SettlementObservationV2> {
  try {
    return Object.freeze({
      disposition: "confirmed" as const,
      result: await deps.finalize(params, options),
    });
  } catch (error) {
    if (error instanceof PolishLifecycleV2RpcError) {
      if (error.kind === "FINALIZE_UNKNOWN") {
        return Object.freeze({ disposition: "unknown" as const });
      }
      if (error.kind === "FINALIZE_CONFLICT") {
        return Object.freeze({ disposition: "conflict" as const });
      }
    }
    return Object.freeze({ disposition: "rejected" as const });
  }
}

async function observeCancellationAuthorityV2(
  deps: PolishRouteDepsV2,
  reservationId: string,
): Promise<CancellationAuthorityObservationV2> {
  try {
    const result = await deps.recordCancellation({ reservationId });
    return result.state === "observed" ? "observed" : "unknown";
  } catch (error) {
    if (
      error instanceof PolishLifecycleV2RpcError &&
      error.kind === "CANCELLATION_REJECTED" &&
      error.reason === "ALREADY_FINALIZED"
    ) {
      return "finalized_first";
    }
    return "unknown";
  }
}

function cancellationSettlementParamsV2(
  params: PolishFinalizeRequestV2,
): PolishFinalizeRequestV2 {
  if (params.settlementKind === "zero_child_release") return params;
  return Object.freeze({ ...params, status: "canceled" as const });
}

function settlementResultMatchesParamsV2(
  result: PolishFinalizeResultV2,
  params: PolishFinalizeRequestV2,
): boolean {
  if (params.settlementKind === "zero_child_release") {
    return result.status === "released" && result.quotaCharged === false;
  }
  return (
    result.status === params.status &&
    result.quotaCharged ===
      (params.status === "succeeded" ||
        (params.status === "canceled" && params.transmitted))
  );
}

/**
 * Keeps cancellation observable for the complete unresolved settlement await.
 * The DB parent-row lock decides whether cancellation or finalization won.
 * Only a durable cancellation receipt permits a new canceled assertion; an
 * ALREADY_FINALIZED receipt permits an exact immutable readback replay.
 */
async function settleWithCancellationV2(
  deps: PolishRouteDepsV2,
  params: PolishFinalizeRequestV2,
  signal: AbortSignal,
  cancellationAlreadyRequested = false,
): Promise<CancellationAwareSettlementObservationV2> {
  let cancellationPromise:
    | Promise<CancellationAuthorityObservationV2>
    | undefined;
  let resolveCancellationStarted!: () => void;
  const cancellationStarted = new Promise<void>((resolve) => {
    resolveCancellationStarted = resolve;
  });
  const startCancellation = () => {
    if (cancellationPromise === undefined) {
      cancellationPromise = observeCancellationAuthorityV2(
        deps,
        params.reservationId,
      );
      resolveCancellationStarted();
    }
  };
  const onAbort = () => startCancellation();
  signal.addEventListener("abort", onAbort, { once: true });
  // Re-read after listener registration so an already-aborted signal and an
  // abort concurrent with setup both start the same durable observation.
  if (cancellationAlreadyRequested || signal.aborted) startCancellation();

  const resolveCancellationRace = async (
    cancellation: CancellationAuthorityObservationV2,
    original?: SettlementObservationV2,
  ): Promise<CancellationAwareSettlementObservationV2> => {
    if (cancellation === "observed") {
      const canceledParams = cancellationSettlementParamsV2(params);
      if (
        original?.disposition === "confirmed" &&
        original.result !== undefined &&
        settlementResultMatchesParamsV2(original.result, canceledParams)
      ) {
        return Object.freeze({
          ...original,
          cancellationRequested: true,
        });
      }
      const canceled = await observeSettlementV2(deps, canceledParams);
      return Object.freeze({
        ...canceled,
        cancellationRequested: true,
      });
    }

    if (cancellation === "finalized_first") {
      const finalized =
        original?.disposition === "confirmed"
          ? original
          : await observeSettlementV2(deps, params);
      return Object.freeze({
        ...finalized,
        cancellationRequested: true,
      });
    }

    return Object.freeze({
      ...(original?.disposition === "confirmed"
        ? original
        : { disposition: "unknown" as const }),
      cancellationRequested: true,
    });
  };

  try {
    if (cancellationPromise !== undefined) {
      return resolveCancellationRace(await cancellationPromise);
    }

    let originalObservation: SettlementObservationV2 | undefined;
    const originalPromise = observeSettlementV2(deps, params, { signal }).then(
      (observation) => {
        originalObservation = observation;
        return observation;
      },
    );
    const first = await Promise.race([
      originalPromise.then((observation) =>
        Object.freeze({ kind: "settlement" as const, observation }),
      ),
      cancellationStarted.then(() =>
        Object.freeze({ kind: "cancellation" as const }),
      ),
    ]);

    if (first.kind === "settlement" && cancellationPromise === undefined) {
      return Object.freeze({
        ...first.observation,
        cancellationRequested: false,
      });
    }

    return resolveCancellationRace(
      await cancellationPromise!,
      first.kind === "settlement" ? first.observation : originalObservation,
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function releaseZeroChildV2(
  deps: PolishRouteDepsV2,
  reservationId: string,
  request: PolishRequest,
  signal: AbortSignal,
  cancellationAlreadyRequested = false,
): Promise<CancellationAwareSettlementObservationV2> {
  return settleWithCancellationV2(
    deps,
    {
      settlementKind: "zero_child_release",
      reservationId,
      metadata: requestMetadataV2(request),
    },
    signal,
    cancellationAlreadyRequested,
  );
}

async function settleAttemptFactsV2(
  deps: PolishRouteDepsV2,
  reservationId: string,
  request: PolishRequest,
  status: "succeeded" | "canceled" | "failed_upstream" | "invalid_output",
  attemptFacts: readonly PolishAttemptCompletedFactV2[],
  aggregate: RequestUsageAggregateV2,
  signal: AbortSignal,
  cancellationAlreadyRequested = false,
): Promise<CancellationAwareSettlementObservationV2> {
  // This any-transmitted value is only a consistency assertion. Durable
  // attempt rows are the settlement authority inside the DB transaction.
  return settleWithCancellationV2(
    deps,
    {
      settlementKind: "attempt_v2",
      reservationId,
      status,
      transmitted: attemptFacts.some((fact) => fact.transmitted),
      providerBillable: aggregate.providerBillable,
      metadata: requestMetadataV2(request),
    },
    signal,
    cancellationAlreadyRequested,
  );
}

function snapshotFailureCodeV2(error: PolishLifecycleV2RpcError): PolishLifecycleV2FailureCode {
  if (error.kind === "SNAPSHOT_DENIED" && error.reason === "NOT_FOUND") {
    return "EXECUTION_NOT_FOUND";
  }
  if (error.kind === "SNAPSHOT_DENIED" && error.reason === "ALREADY_FINALIZED") {
    return "EXECUTION_ALREADY_FINALIZED";
  }
  if (error.kind === "SNAPSHOT_INVALID") return "EXECUTION_INVALID";
  return "SERVICE_UNAVAILABLE";
}

function reserveFailureV2(
  logger: PolishRouteDepsV2["logger"],
  requestId: string,
  error: unknown,
): PolishLifecycleV2Failure {
  if (
    error instanceof PolishLifecycleV2RpcError &&
    error.kind === "RESERVE_DENIED" &&
    isSafeReserveDenialCodeV2(error.reason)
  ) {
    return failureV2(logger, {
      requestId,
      code: error.reason,
      stage: "reserve",
      attemptCount: 0,
      settlement: "not_reserved",
      resetAt: error.resetAt,
      retryAfterSeconds: error.retryAfterSeconds,
      remaining: error.remaining,
    });
  }
  return failureV2(logger, {
    requestId,
    code: "RESERVATION_UNKNOWN",
    stage: "reserve",
    attemptCount: 0,
    settlement: "not_reserved",
  });
}

function aggregatePersistedFactsV2(
  facts: readonly PolishAttemptCompletedFactV2[],
): RequestUsageAggregateV2 | null {
  try {
    return aggregatePolishAttemptFactsV2(facts);
  } catch {
    return null;
  }
}

function outcomeSettlementV2(
  observation: SettlementObservationV2,
): PolishLifecycleV2SettlementDisposition {
  return observation.disposition;
}

/**
 * Authenticated, non-HTTP V2 lifecycle. The public route binds this only
 * after bearer/body validation; this layer never parses transport input or
 * projects public response bodies.
 */
export async function executePolishLifecycleV2(
  rawInput: PolishLifecycleV2Input,
  deps: PolishRouteDepsV2,
): Promise<PolishLifecycleV2Result> {
  const inputRequestId = safeRequestIdV2(rawInput?.requestId);
  let input: ParsedLifecycleInputV2;
  try {
    input = parseLifecycleInputV2(rawInput);
  } catch {
    return failureV2(deps.logger, {
      requestId: inputRequestId,
      code: "INVALID_INPUT",
      stage: "input",
      attemptCount: 0,
      settlement: "not_reserved",
    });
  }

  if (input.signal.aborted) {
    return failureV2(deps.logger, {
      requestId: input.requestId,
      code: "CANCELED",
      stage: "canceled",
      attemptCount: 0,
      settlement: "not_reserved",
    });
  }

  let reservation: Awaited<ReturnType<typeof reservePolishRequestV2>>;
  try {
    reservation = await deps.reserve({
      userId: input.authenticatedUserId,
      requestId: input.requestId,
      clientRequestId: input.clientRequestId,
      expectedRoute: input.expectedRoute,
    });
  } catch (error) {
    return reserveFailureV2(deps.logger, input.requestId, error);
  }

  const observeUnsettledCancellation = async (): Promise<
    "not_attempted" | "unknown"
  > =>
    (await observeCancellationAuthorityV2(
      deps,
      reservation.reservationId,
    )) === "unknown"
      ? "unknown"
      : "not_attempted";

  const failAfterZeroChild = async (
    code: PolishLifecycleV2FailureCode,
    stage: PolishLifecycleV2Stage,
  ): Promise<PolishLifecycleV2Failure> => {
    const settlement = await releaseZeroChildV2(
      deps,
      reservation.reservationId,
      input.request,
      input.signal,
    );
    return failureV2(deps.logger, {
      requestId: input.requestId,
      code: settlement.cancellationRequested ? "CANCELED" : code,
      stage: settlement.cancellationRequested ? "canceled" : stage,
      attemptCount: 0,
      settlement: outcomeSettlementV2(settlement),
    });
  };

  const cancelAfterReservation = async (): Promise<PolishLifecycleV2Failure> => {
    const settlement = await releaseZeroChildV2(
      deps,
      reservation.reservationId,
      input.request,
      input.signal,
      true,
    );
    return failureV2(deps.logger, {
      requestId: input.requestId,
      code: "CANCELED",
      stage: "canceled",
      attemptCount: 0,
      settlement: outcomeSettlementV2(settlement),
    });
  };

  if (input.signal.aborted) {
    return cancelAfterReservation();
  }

  let execution: Awaited<ReturnType<typeof getPolishExecutionSnapshotV2>>;
  try {
    execution = await deps.getExecutionSnapshot({
      reservationId: reservation.reservationId,
      userId: input.authenticatedUserId,
      reserveRoute: reservation.routeSnapshot,
      runtimeTargetResolver: deps.runtimeTargetResolver,
      runtimeTargetResolverV2:
        deps.runtimeTargetResolverV2 ?? EMPTY_RUNTIME_TARGET_RESOLVER_V2,
      ...(deps.runtimeDeploymentIdentity
        ? { runtimeIdentity: deps.runtimeDeploymentIdentity }
        : {}),
    });
  } catch (error) {
    if (input.signal.aborted) {
      return cancelAfterReservation();
    }
    if (
      error instanceof PolishLifecycleV2RpcError &&
      error.kind === "SNAPSHOT_DENIED" &&
      (error.reason === "NOT_FOUND" || error.reason === "ALREADY_FINALIZED")
    ) {
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: snapshotFailureCodeV2(error),
        stage: "execution_snapshot",
        attemptCount: 0,
        settlement: "not_attempted",
      });
    }
    return failAfterZeroChild(
      error instanceof PolishLifecycleV2RpcError
        ? snapshotFailureCodeV2(error)
        : "SERVICE_UNAVAILABLE",
      "execution_snapshot",
    );
  }

  let provider: PolishInferenceProviderV2;
  let runtimeProvenance:
    | Readonly<{
        runtimeBuildId: string;
        bindingManifestRevision: string;
      }>
    | undefined;
  let runtimeAdmission: Readonly<RuntimeDeploymentAdmissionV2> | undefined;
  let providerSubjectId: string;
  try {
    const resolution = deps.resolveProvider(
      execution.profileExecutionConfig,
      execution.schemaVersion === "ai_polish_execution_snapshot_v2"
        ? {
            schemaVersion: "runtime_execution_target_v2",
            runtimeContractId: execution.runtimeEvidence.runtimeContractId,
            legalBundleVersion: execution.routeSnapshot.legalBundleVersion,
            profileVersionId: execution.routeSnapshot.profileVersionId,
            profile: execution.profileExecutionConfig,
            evidence: execution.runtimeEvidence,
            deploymentValidation: execution.deploymentValidation,
          }
        : undefined,
    );
    if (
      execution.profileExecutionConfig.schemaVersion ===
      "profile_execution_config_v2"
    ) {
      const prepared = readPreparedProviderExecutionV2(
        resolution,
        execution.profileExecutionConfig,
      );
      provider = prepared.provider;
      runtimeProvenance = prepared.runtimeProvenance;
      if (
        execution.schemaVersion !== "ai_polish_execution_snapshot_v2" ||
        execution.deploymentValidation.schemaVersion !==
          "runtime_deployment_admission_v2"
      ) {
        throw new PolishAdapterUnavailableV2Error();
      }
      runtimeAdmission = execution.deploymentValidation;
    } else {
      if (isPreparedProviderExecutionV2(resolution)) {
        throw new PolishAdapterUnavailableV2Error();
      }
      provider = resolution;
    }
    providerSubjectId = deriveProviderSubjectIdV2({
      profileVersionId: execution.routeSnapshot.profileVersionId,
      authenticatedUserId: input.authenticatedUserId,
      secret: deps.providerSubjectSecret,
    });
  } catch {
    return failAfterZeroChild("PROFILE_UNAVAILABLE", "profile_resolution");
  }

  if (input.signal.aborted) {
    return cancelAfterReservation();
  }

  const persistedFacts: PolishAttemptCompletedFactV2[] = [];
  let admittedAttempts = 0;
  try {
    const result = await orchestratePolishV2(provider, input.request, {
      signal: input.signal,
      providerSubjectId,
      frozenPrice: execution.priceSnapshot,
      now: deps.now,
      sleep: deps.sleep,
      onAttemptStarted: async (started): Promise<ProviderAttemptStartV2> => {
        if (
          execution.profileExecutionConfig.schemaVersion ===
            "profile_execution_config_v2" &&
          runtimeProvenance === undefined
        ) {
          throw new PolishAdapterUnavailableV2Error();
        }
        const receipt = await deps.startAttempt({
          reservationId: reservation.reservationId,
          attemptNo: started.attemptNo as 1 | 2,
          expectedRoute: execution.routeSnapshot,
          runtimeProvenance,
          runtimeAdmission,
        });
        admittedAttempts += 1;
        return receipt;
      },
      onAttemptCompleted: async (event) => {
        if (event.startResult === undefined) {
          throw new Error("missing V2 attempt admission receipt");
        }
        await deps.completeAttempt({
          attempt: event.startResult,
          fact: event.completed,
          profileExecutionConfig: execution.profileExecutionConfig,
          billingCurrency: execution.priceSnapshot.currency,
          routeObservationSecret: deps.routeObservationSecret,
        });
        persistedFacts.push(event.completed);
        if (input.signal.aborted) {
          throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
      },
    });

    if (
      admittedAttempts !== result.attemptFacts.length ||
      persistedFacts.length !== result.attemptFacts.length
    ) {
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "ATTEMPT_STATE_UNKNOWN",
        stage: "attempt_complete",
        attemptCount: admittedAttempts,
        settlement: "not_attempted",
      });
    }

    const settlement = await settleAttemptFactsV2(
      deps,
      reservation.reservationId,
      input.request,
      "succeeded",
      persistedFacts,
      result.aggregate,
      input.signal,
    );
    if (settlement.cancellationRequested) {
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "CANCELED",
        stage: "canceled",
        attemptCount: persistedFacts.length,
        settlement: outcomeSettlementV2(settlement),
      });
    }
    if (settlement.disposition === "conflict") {
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "SETTLEMENT_CONFLICT",
        stage: "settlement",
        attemptCount: persistedFacts.length,
        settlement: "conflict",
      });
    }
    if (settlement.disposition === "rejected") {
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "SETTLEMENT_REJECTED",
        stage: "settlement",
        attemptCount: persistedFacts.length,
        settlement: "rejected",
      });
    }

    const quota =
      settlement.result?.quota ?? {
        limit: reservation.limit,
        remaining: reservation.remaining,
        resetAt: reservation.resetAt,
      };
    const success: PolishLifecycleV2Success = Object.freeze({
      ok: true,
      requestId: input.requestId,
      items: Object.freeze(
        result.items.map((item) => Object.freeze({ ...item })),
      ),
      quota: Object.freeze({ ...quota }),
      profileVersionId: execution.routeSnapshot.profileVersionId,
      displayDisclosureKey: execution.routeSnapshot.displayDisclosureKey,
      attemptCount: persistedFacts.length,
      settlement: settlement.disposition,
    });
    safeLogV2(deps.logger, {
      event:
        settlement.disposition === "unknown"
          ? "polish.v2.settlement_unknown"
          : "polish.v2.completed",
      requestId: input.requestId,
      attemptCount: persistedFacts.length,
      settlement: settlement.disposition,
    });
    return success;
  } catch (error) {
    const cancellationRequested = input.signal.aborted || isAbortError(error);
    if (error instanceof PolishAttemptPersistenceErrorV2 && !cancellationRequested) {
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "ATTEMPT_PERSISTENCE_ERROR",
        stage: "attempt_complete",
        attemptCount: admittedAttempts,
        settlement: "not_attempted",
      });
    }

    const uncompletedAdmission = admittedAttempts > persistedFacts.length;
    if (
      error instanceof PolishLifecycleV2RpcError &&
      (error.kind === "ATTEMPT_START_REPLAY" ||
        error.kind === "ATTEMPT_START_UNKNOWN")
    ) {
      if (cancellationRequested) {
        await observeUnsettledCancellation();
        return failureV2(deps.logger, {
          requestId: input.requestId,
          code: "CANCELED",
          stage: "canceled",
          attemptCount: admittedAttempts,
          settlement: "unknown",
        });
      }
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "ATTEMPT_STATE_UNKNOWN",
        stage: "attempt_start",
        attemptCount: admittedAttempts,
        settlement: "not_attempted",
      });
    }

    if (
      error instanceof PolishLifecycleV2RpcError &&
      error.kind === "ATTEMPT_START_DENIED" &&
      (error.reason === "NOT_FOUND" || error.reason === "ALREADY_FINALIZED")
    ) {
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "ATTEMPT_START_DENIED",
        stage: "attempt_start",
        attemptCount: persistedFacts.length,
        settlement: "not_attempted",
      });
    }

    if (uncompletedAdmission) {
      if (cancellationRequested) {
        await observeUnsettledCancellation();
        return failureV2(deps.logger, {
          requestId: input.requestId,
          code: "CANCELED",
          stage: "canceled",
          attemptCount: admittedAttempts,
          settlement: "unknown",
        });
      }
      return failureV2(deps.logger, {
        requestId: input.requestId,
        code: "ATTEMPT_STATE_UNKNOWN",
        stage: "attempt_complete",
        attemptCount: admittedAttempts,
        settlement: "not_attempted",
      });
    }

    let primaryCode: PolishLifecycleV2FailureCode = "INTERNAL_ERROR";
    let primaryStage: PolishLifecycleV2Stage = "provider";
    let requestStatus:
      | "canceled"
      | "failed_upstream"
      | "invalid_output" = "failed_upstream";
    let aggregate: RequestUsageAggregateV2 | null = null;

    if (cancellationRequested) {
      primaryCode = "CANCELED";
      primaryStage = "canceled";
      requestStatus = "canceled";
      aggregate = aggregatePersistedFactsV2(persistedFacts);
    } else if (error instanceof PolishOrchestrationErrorV2) {
      primaryCode = error.code;
      primaryStage = "provider";
      requestStatus =
        error.code === "INVALID_MODEL_OUTPUT"
          ? "invalid_output"
          : "failed_upstream";
      aggregate = error.aggregate;
    } else if (
      error instanceof PolishLifecycleV2RpcError &&
      error.kind === "ATTEMPT_START_DENIED"
    ) {
      primaryCode =
        error.reason === "AI_DISABLED" || error.reason === "SERVICE_UNAVAILABLE"
          ? error.reason
          : "ATTEMPT_START_DENIED";
      primaryStage = "attempt_start";
      aggregate = aggregatePersistedFactsV2(persistedFacts);
    } else {
      aggregate = aggregatePersistedFactsV2(persistedFacts);
    }

    let settlement: CancellationAwareSettlementObservationV2;
    if (persistedFacts.length === 0) {
      settlement = await releaseZeroChildV2(
        deps,
        reservation.reservationId,
        input.request,
        input.signal,
        cancellationRequested,
      );
    } else if (aggregate !== null) {
      settlement = await settleAttemptFactsV2(
        deps,
        reservation.reservationId,
        input.request,
        requestStatus,
        persistedFacts,
        aggregate,
        input.signal,
        cancellationRequested,
      );
    } else {
      const cancellationDisposition = cancellationRequested
        ? await observeUnsettledCancellation()
        : null;
      settlement = Object.freeze({
        disposition:
          cancellationDisposition === "unknown"
            ? ("unknown" as const)
            : ("rejected" as const),
        cancellationRequested,
      });
    }

    if (settlement.cancellationRequested) {
      primaryCode = "CANCELED";
      primaryStage = "canceled";
    }

    return failureV2(deps.logger, {
      requestId: input.requestId,
      code: primaryCode,
      stage: primaryStage,
      attemptCount: persistedFacts.length,
      settlement: outcomeSettlementV2(settlement),
    });
  }
}
