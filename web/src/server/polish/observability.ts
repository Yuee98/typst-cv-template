/**
 * Content-free observability projections for the V2 polish lifecycle.
 *
 * This module intentionally has no lifecycle, database, provider, or metrics
 * backend dependency.  A future composition point may give it facts only
 * after the lifecycle has validated and persisted them.  In particular, it
 * never accepts a prompt, output, provider response body, credential, raw
 * upstream identifier, endpoint, or provider subject.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CODE_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const HMAC_TAG = /^hmac-sha256:[0-9a-f]{64}$/u;
const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");
const AUTHORIZED_FACT = Symbol("polish-observability-authorized-fact");

const ATTEMPT_STATUSES = [
  "succeeded",
  "invalid_output",
  "failed_upstream",
  "timed_out",
  "canceled",
] as const;
const REQUEST_STATUSES = [
  "succeeded",
  "invalid_output",
  "failed_upstream",
  "canceled",
  "released",
  "abandoned",
] as const;
const CACHE_WRITE_STATES = ["reported", "unavailable", "not_applicable"] as const;
const RECONCILIATION_STATES = [
  "incomplete_usage",
  "not_available",
  "matched",
  "mismatch",
] as const;
const REQUEST_RETRY_STATES = ["not_attempted", "not_needed", "succeeded", "exhausted"] as const;

type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
type RequestStatus = (typeof REQUEST_STATUSES)[number];
type CacheWriteState = (typeof CACHE_WRITE_STATES)[number];
type ReconciliationState = (typeof RECONCILIATION_STATES)[number];
type RequestRetryState = (typeof REQUEST_RETRY_STATES)[number];

export class PolishObservabilityProjectionError extends Error {
  readonly code = "INVALID_OBSERVABILITY_FACT" as const;

  constructor() {
    super("Invalid content-free observability fact.");
    this.name = "PolishObservabilityProjectionError";
  }
}

export interface PolishObservabilityProfileV1 {
  readonly profileKey: string;
  readonly profileVersionId: string;
  readonly gatewayKind: string;
  readonly modelId: string;
}

export interface PolishObservabilityPolicyV1 {
  readonly configGeneration: string;
  readonly routingPolicyVersionId: string;
  readonly priceVersionId: string;
  readonly legalBundleVersion: string;
  readonly runtimeContractId: string;
  readonly runtimeContractSha256: string;
}

export interface PolishObservabilityUsageV1 {
  readonly availability: "observed" | "unavailable";
  readonly complete: boolean;
  readonly cacheWrite: CacheWriteState;
  readonly inputTotalTokens: string | null;
  readonly inputCacheReadTokens: string | null;
  readonly inputCacheWriteTokens: string | null;
  readonly inputStandardTokens: string | null;
  readonly outputTokens: string | null;
  readonly reasoningTokens: string | null;
}

export interface PolishObservabilityCostV1 {
  readonly currency: string;
  readonly estimatedNanos: string | null;
  readonly providerReportedNanos: string | null;
  readonly reconciliation: ReconciliationState;
}

export interface PolishAttemptUpstreamObservationV1 {
  readonly status: AttemptStatus;
  readonly transmitted: boolean;
  readonly httpStatus: number | null;
  /** Only a pre-HMACed route-observation tag; never a raw request id. */
  readonly gatewayRequestTag: string | null;
  /** Only a pre-HMACed route-observation tag; never a raw request id. */
  readonly providerRequestTag: string | null;
}

export interface PolishRequestUpstreamObservationV1 {
  readonly transmittedAttemptCount: number;
  readonly successfulAttemptCount: number;
  readonly latestHttpStatus: number | null;
}

export interface PolishAttemptObservabilityEventV1 {
  readonly schemaVersion: "polish_observability_event_v1";
  readonly event: "ai_polish_attempt";
  /** Metrics must aggregate this family per provider attempt only. */
  readonly aggregation: "attempt";
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptNo: 1 | 2;
  readonly retry: boolean;
  readonly success: boolean;
  readonly profile: PolishObservabilityProfileV1;
  readonly policy: PolishObservabilityPolicyV1;
  readonly upstream: PolishAttemptUpstreamObservationV1;
  readonly usage: PolishObservabilityUsageV1;
  readonly cost: PolishObservabilityCostV1;
}

export interface PolishRequestObservabilityEventV1 {
  readonly schemaVersion: "polish_observability_event_v1";
  readonly event: "ai_polish_request";
  /** Metrics must aggregate this family per user-visible request only. */
  readonly aggregation: "request";
  /** Preserves the canonical legacy/current request correlation id unchanged. */
  readonly requestId: string;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly retry: RequestRetryState;
  readonly success: boolean;
  readonly outcome: RequestStatus;
  readonly profile: PolishObservabilityProfileV1;
  readonly policy: PolishObservabilityPolicyV1;
  readonly upstream: PolishRequestUpstreamObservationV1;
  readonly usage: PolishObservabilityUsageV1;
  readonly cost: PolishObservabilityCostV1;
}

export type PolishObservabilityEventV1 =
  | PolishAttemptObservabilityEventV1
  | PolishRequestObservabilityEventV1;

export type PolishObservabilitySinkV1 = (event: PolishObservabilityEventV1) => void;

export interface PolishObservabilityProjectorV1 {
  readonly emitAttempt: (
    fact: PolishAuthoritativeAttemptObservabilityFactV1,
  ) => PolishAttemptObservabilityEventV1;
  readonly emitRequest: (
    fact: PolishAuthoritativeRequestObservabilityFactV1,
  ) => PolishRequestObservabilityEventV1;
}

/**
 * This is an API boundary marker, not a database provenance proof.  The
 * caller must mint it only from an already persisted/authoritative fact.
 * The private runtime symbol prevents accidentally passing an arbitrary
 * object to the projector.  HMAC tags are likewise consumed as already
 * authorized correlation observations; this module does not verify them.
 */
export interface PolishAuthoritativeAttemptObservabilityFactV1 {
  readonly kind: "polish_authoritative_attempt_fact_v1";
}

export interface PolishAuthoritativeRequestObservabilityFactV1 {
  readonly kind: "polish_authoritative_request_fact_v1";
}

type InternalAttemptFact = PolishAuthoritativeAttemptObservabilityFactV1 & {
  readonly [AUTHORIZED_FACT]: "attempt";
  readonly fact: ParsedAttemptFact;
};

type InternalRequestFact = PolishAuthoritativeRequestObservabilityFactV1 & {
  readonly [AUTHORIZED_FACT]: "request";
  readonly fact: ParsedRequestFact;
};

interface ParsedAttemptFact {
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptNo: 1 | 2;
  readonly profile: PolishObservabilityProfileV1;
  readonly policy: PolishObservabilityPolicyV1;
  readonly upstream: PolishAttemptUpstreamObservationV1;
  readonly usage: PolishObservabilityUsageV1;
  readonly cost: PolishObservabilityCostV1;
}

interface ParsedRequestFact {
  readonly requestId: string;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly retry: RequestRetryState;
  readonly outcome: RequestStatus;
  readonly profile: PolishObservabilityProfileV1;
  readonly policy: PolishObservabilityPolicyV1;
  readonly upstream: PolishRequestUpstreamObservationV1;
  readonly usage: PolishObservabilityUsageV1;
  readonly cost: PolishObservabilityCostV1;
}

function invalid(): never {
  throw new PolishObservabilityProjectionError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    invalid();
  }
}

function oneOf<T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) invalid();
  return value as T[number];
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value;
}

function codeId(value: unknown): string {
  if (typeof value !== "string" || !CODE_ID.test(value)) invalid();
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) invalid();
  if (value.length > 19) invalid();
  if (BigInt(value) > MAX_POSTGRES_BIGINT) invalid();
  return value;
}

function nullableDecimal(value: unknown): string | null {
  return value === null ? null : decimal(value);
}

function count(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    invalid();
  }
  return value as number;
}

function httpStatus(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599) invalid();
  return value as number;
}

function taggedRouteId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !HMAC_TAG.test(value)) invalid();
  return value;
}

function profile(value: unknown): PolishObservabilityProfileV1 {
  const source = record(value);
  exactKeys(source, ["profileKey", "profileVersionId", "gatewayKind", "modelId"]);
  return Object.freeze({
    profileKey: codeId(source.profileKey),
    profileVersionId: uuid(source.profileVersionId),
    gatewayKind: codeId(source.gatewayKind),
    modelId: codeId(source.modelId),
  });
}

function policy(value: unknown): PolishObservabilityPolicyV1 {
  const source = record(value);
  exactKeys(source, [
    "configGeneration",
    "routingPolicyVersionId",
    "priceVersionId",
    "legalBundleVersion",
    "runtimeContractId",
    "runtimeContractSha256",
  ]);
  if (typeof source.runtimeContractSha256 !== "string" || !SHA256.test(source.runtimeContractSha256)) {
    invalid();
  }
  return Object.freeze({
    configGeneration: decimal(source.configGeneration),
    routingPolicyVersionId: uuid(source.routingPolicyVersionId),
    priceVersionId: uuid(source.priceVersionId),
    legalBundleVersion: codeId(source.legalBundleVersion),
    runtimeContractId: codeId(source.runtimeContractId),
    runtimeContractSha256: source.runtimeContractSha256,
  });
}

function usage(value: unknown): PolishObservabilityUsageV1 {
  const source = record(value);
  exactKeys(source, [
    "availability",
    "complete",
    "cacheWrite",
    "inputTotalTokens",
    "inputCacheReadTokens",
    "inputCacheWriteTokens",
    "inputStandardTokens",
    "outputTokens",
    "reasoningTokens",
  ]);
  const availability = oneOf(source.availability, ["observed", "unavailable"] as const);
  const cacheWrite = oneOf(source.cacheWrite, CACHE_WRITE_STATES);
  if (typeof source.complete !== "boolean") invalid();
  const values = {
    inputTotalTokens: nullableDecimal(source.inputTotalTokens),
    inputCacheReadTokens: nullableDecimal(source.inputCacheReadTokens),
    inputCacheWriteTokens: nullableDecimal(source.inputCacheWriteTokens),
    inputStandardTokens: nullableDecimal(source.inputStandardTokens),
    outputTokens: nullableDecimal(source.outputTokens),
    reasoningTokens: nullableDecimal(source.reasoningTokens),
  };
  if (availability === "unavailable") {
    if (
      source.complete ||
      cacheWrite !== "unavailable" ||
      Object.values(values).some((entry) => entry !== null)
    ) {
      invalid();
    }
  } else {
    if (
      values.inputTotalTokens === null ||
      values.inputCacheReadTokens === null ||
      values.inputStandardTokens === null ||
      values.outputTokens === null
    ) {
      invalid();
    }
    if (cacheWrite === "reported") {
      if (values.inputCacheWriteTokens === null) invalid();
      if (
        BigInt(values.inputCacheReadTokens) +
          BigInt(values.inputCacheWriteTokens) +
          BigInt(values.inputStandardTokens) !==
        BigInt(values.inputTotalTokens)
      ) {
        invalid();
      }
    } else if (cacheWrite === "unavailable") {
      if (values.inputCacheWriteTokens !== null) invalid();
      if (
        BigInt(values.inputCacheReadTokens) + BigInt(values.inputStandardTokens) !==
        BigInt(values.inputTotalTokens)
      ) {
        invalid();
      }
    } else {
      if (
        values.inputCacheReadTokens !== "0" ||
        values.inputCacheWriteTokens !== "0" ||
        BigInt(values.inputCacheReadTokens) +
          BigInt(values.inputCacheWriteTokens) +
          BigInt(values.inputStandardTokens) !==
        BigInt(values.inputTotalTokens)
      ) {
        invalid();
      }
    }
    if (
      values.reasoningTokens !== null &&
      BigInt(values.reasoningTokens) > BigInt(values.outputTokens)
    ) {
      invalid();
    }
  }
  return Object.freeze({ availability, complete: source.complete, cacheWrite, ...values });
}

function cost(value: unknown): PolishObservabilityCostV1 {
  const source = record(value);
  exactKeys(source, ["currency", "estimatedNanos", "providerReportedNanos", "reconciliation"]);
  if (typeof source.currency !== "string" || !CURRENCY.test(source.currency)) invalid();
  const estimatedNanos = nullableDecimal(source.estimatedNanos);
  const providerReportedNanos = nullableDecimal(source.providerReportedNanos);
  const reconciliation = oneOf(source.reconciliation, RECONCILIATION_STATES);
  if (
    (reconciliation === "matched" &&
      (estimatedNanos === null || providerReportedNanos === null || estimatedNanos !== providerReportedNanos)) ||
    (reconciliation === "mismatch" &&
      (estimatedNanos === null || providerReportedNanos === null || estimatedNanos === providerReportedNanos)) ||
    (reconciliation === "incomplete_usage" && estimatedNanos !== null) ||
    (reconciliation === "not_available" &&
      (estimatedNanos === null || providerReportedNanos !== null))
  ) {
    invalid();
  }
  return Object.freeze({
    currency: source.currency,
    estimatedNanos,
    providerReportedNanos,
    reconciliation,
  });
}

function attemptUpstream(value: unknown): PolishAttemptUpstreamObservationV1 {
  const source = record(value);
  exactKeys(source, ["status", "transmitted", "httpStatus", "gatewayRequestTag", "providerRequestTag"]);
  if (typeof source.transmitted !== "boolean") invalid();
  const status = oneOf(source.status, ATTEMPT_STATUSES);
  const statusCode = httpStatus(source.httpStatus);
  if (
    !source.transmitted &&
    (!["canceled", "timed_out"].includes(status) || statusCode !== null)
  ) {
    invalid();
  }
  return Object.freeze({
    status,
    transmitted: source.transmitted,
    httpStatus: statusCode,
    gatewayRequestTag: taggedRouteId(source.gatewayRequestTag),
    providerRequestTag: taggedRouteId(source.providerRequestTag),
  });
}

function requestUpstream(value: unknown, attemptCount: number): PolishRequestUpstreamObservationV1 {
  const source = record(value);
  exactKeys(source, ["transmittedAttemptCount", "successfulAttemptCount", "latestHttpStatus"]);
  const transmittedAttemptCount = count(source.transmittedAttemptCount, 2);
  const successfulAttemptCount = count(source.successfulAttemptCount, 2);
  const latestHttpStatus = httpStatus(source.latestHttpStatus);
  if (
    transmittedAttemptCount > attemptCount ||
    successfulAttemptCount > transmittedAttemptCount ||
    (transmittedAttemptCount === 0 && latestHttpStatus !== null)
  ) {
    invalid();
  }
  return Object.freeze({ transmittedAttemptCount, successfulAttemptCount, latestHttpStatus });
}

function parseAttemptFact(value: unknown): ParsedAttemptFact {
  const source = record(value);
  exactKeys(source, [
    "requestId",
    "attemptId",
    "attemptNo",
    "profile",
    "policy",
    "upstream",
    "usage",
    "cost",
  ]);
  const attemptNo = count(source.attemptNo, 2);
  if (attemptNo === 0) invalid();
  const upstream = attemptUpstream(source.upstream);
  const parsedUsage = usage(source.usage);
  if (
    (upstream.status === "succeeded" || upstream.status === "invalid_output") &&
    (!upstream.transmitted || parsedUsage.availability !== "observed")
  ) {
    invalid();
  }
  if (!upstream.transmitted && parsedUsage.availability !== "unavailable") invalid();
  return Object.freeze({
    requestId: uuid(source.requestId),
    attemptId: uuid(source.attemptId),
    attemptNo: attemptNo as 1 | 2,
    profile: profile(source.profile),
    policy: policy(source.policy),
    upstream,
    usage: parsedUsage,
    cost: cost(source.cost),
  });
}

function parseRequestFact(value: unknown): ParsedRequestFact {
  const source = record(value);
  exactKeys(source, [
    "requestId",
    "attemptCount",
    "retryCount",
    "retry",
    "outcome",
    "profile",
    "policy",
    "upstream",
    "usage",
    "cost",
  ]);
  const attemptCount = count(source.attemptCount, 2);
  const retryCount = count(source.retryCount, 1);
  const retry = oneOf(source.retry, REQUEST_RETRY_STATES);
  const outcome = oneOf(source.outcome, REQUEST_STATUSES);
  if (
    retryCount !== Math.max(0, attemptCount - 1) ||
    (attemptCount === 0 && retry !== "not_attempted") ||
    (attemptCount === 1 && retry !== "not_needed") ||
    (attemptCount === 2 &&
      ((outcome === "succeeded" && retry !== "succeeded") ||
        (outcome !== "succeeded" && retry !== "exhausted"))) ||
    (attemptCount === 0 &&
      !["released", "abandoned", "canceled"].includes(outcome)) ||
    (attemptCount > 0 && ["released", "abandoned"].includes(outcome)) ||
    (outcome === "succeeded" && attemptCount === 0)
  ) {
    invalid();
  }
  const upstream = requestUpstream(source.upstream, attemptCount);
  if ((outcome === "succeeded") !== (upstream.successfulAttemptCount > 0)) invalid();
  return Object.freeze({
    requestId: uuid(source.requestId),
    attemptCount,
    retryCount,
    retry,
    outcome,
    profile: profile(source.profile),
    policy: policy(source.policy),
    upstream,
    usage: usage(source.usage),
    cost: cost(source.cost),
  });
}

export function authorizePolishAttemptObservabilityFactV1(
  fact: unknown,
): PolishAuthoritativeAttemptObservabilityFactV1 {
  const parsed = parseAttemptFact(fact);
  return Object.freeze({
    kind: "polish_authoritative_attempt_fact_v1" as const,
    fact: parsed,
    [AUTHORIZED_FACT]: "attempt" as const,
  }) as PolishAuthoritativeAttemptObservabilityFactV1;
}

export function authorizePolishRequestObservabilityFactV1(
  fact: unknown,
): PolishAuthoritativeRequestObservabilityFactV1 {
  const parsed = parseRequestFact(fact);
  return Object.freeze({
    kind: "polish_authoritative_request_fact_v1" as const,
    fact: parsed,
    [AUTHORIZED_FACT]: "request" as const,
  }) as PolishAuthoritativeRequestObservabilityFactV1;
}

function internalAttemptFact(
  fact: PolishAuthoritativeAttemptObservabilityFactV1,
): InternalAttemptFact {
  if (
    typeof fact !== "object" ||
    fact === null ||
    (fact as Partial<InternalAttemptFact>)[AUTHORIZED_FACT] !== "attempt"
  ) {
    invalid();
  }
  return fact as InternalAttemptFact;
}

function internalRequestFact(
  fact: PolishAuthoritativeRequestObservabilityFactV1,
): InternalRequestFact {
  if (
    typeof fact !== "object" ||
    fact === null ||
    (fact as Partial<InternalRequestFact>)[AUTHORIZED_FACT] !== "request"
  ) {
    invalid();
  }
  return fact as InternalRequestFact;
}

/** Project one authorized persisted terminal provider-attempt fact. */
export function projectPolishAttemptObservabilityEventV1(
  fact: PolishAuthoritativeAttemptObservabilityFactV1,
): PolishAttemptObservabilityEventV1 {
  const source = internalAttemptFact(fact).fact;
  return Object.freeze({
    schemaVersion: "polish_observability_event_v1",
    event: "ai_polish_attempt",
    aggregation: "attempt",
    requestId: source.requestId,
    attemptId: source.attemptId,
    attemptNo: source.attemptNo,
    retry: source.attemptNo === 2,
    success: source.upstream.status === "succeeded",
    profile: source.profile,
    policy: source.policy,
    upstream: source.upstream,
    usage: source.usage,
    cost: source.cost,
  });
}

/** Project one authorized terminal user-visible request aggregate. */
export function projectPolishRequestObservabilityEventV1(
  fact: PolishAuthoritativeRequestObservabilityFactV1,
): PolishRequestObservabilityEventV1 {
  const source = internalRequestFact(fact).fact;
  return Object.freeze({
    schemaVersion: "polish_observability_event_v1",
    event: "ai_polish_request",
    aggregation: "request",
    requestId: source.requestId,
    attemptCount: source.attemptCount,
    retryCount: source.retryCount,
    retry: source.retry,
    success: source.outcome === "succeeded",
    outcome: source.outcome,
    profile: source.profile,
    policy: source.policy,
    upstream: source.upstream,
    usage: source.usage,
    cost: source.cost,
  });
}

/**
 * Future composition seam.  The supplied sink can be a structured logger or
 * an in-process metrics bridge; throwing sinks are deliberately propagated so
 * the caller can apply its own non-authoritative observability policy.
 */
export function createPolishObservabilityProjectorV1(
  sink: PolishObservabilitySinkV1,
): PolishObservabilityProjectorV1 {
  if (typeof sink !== "function") invalid();
  return Object.freeze({
    emitAttempt(fact: PolishAuthoritativeAttemptObservabilityFactV1): PolishAttemptObservabilityEventV1 {
      const event = projectPolishAttemptObservabilityEventV1(fact);
      sink(event);
      return event;
    },
    emitRequest(fact: PolishAuthoritativeRequestObservabilityFactV1): PolishRequestObservabilityEventV1 {
      const event = projectPolishRequestObservabilityEventV1(fact);
      sink(event);
      return event;
    },
  });
}
