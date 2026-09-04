import { createHmac } from "node:crypto";

import {
  legalBundleContainsManifest,
  validateProfileExecutionConfig,
  type ProfileExecutionConfigV1,
} from "./profile-registry";
import {
  validateFrozenPriceSnapshot,
  type FrozenPriceSnapshotV1,
  type PriceComponent,
} from "./pricing";

const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const CODE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/u;

const EXPECTED_ROUTE_KEYS = [
  "schemaVersion",
  "configGeneration",
  "profileVersionId",
  "legalBundleVersion",
  "runtimeContractId",
] as const;

const ROUTE_SNAPSHOT_KEYS = [
  "schemaVersion",
  "configGeneration",
  "routingPolicyVersionId",
  "profileVersionId",
  "priceVersionId",
  "legalBundleVersion",
  "runtimeContractId",
  "gatewayKind",
  "modelId",
  "wireApiKind",
  "displayDisclosureKey",
] as const;

const EXECUTION_SUCCESS_KEYS = [
  "schemaVersion",
  "ok",
  "reservationId",
  "routeSnapshot",
  "profileExecutionConfig",
  "priceSnapshot",
] as const;
const EXECUTION_FAILURE_KEYS = ["schemaVersion", "ok", "reason"] as const;
const PRICE_SNAPSHOT_KEYS = [
  "schemaVersion",
  "priceVersionId",
  "currency",
  "calculatorKind",
  "components",
  "parameters",
] as const;

const RESERVE_SUCCESS_KEYS = [
  "allowed",
  "reservationId",
  "limit",
  "remaining",
  "resetAt",
  "routeSnapshot",
] as const;
const RESERVE_BASIC_DENIAL_KEYS = ["allowed", "reason", "message"] as const;
const RESERVE_QUOTA_DENIAL_KEYS = [
  "allowed",
  "reason",
  "message",
  "remaining",
  "resetAt",
] as const;
const RESERVE_RATE_DENIAL_KEYS = [
  "allowed",
  "reason",
  "message",
  "retryAfterSeconds",
] as const;

const ATTEMPT_START_SUCCESS_KEYS = [
  "ok",
  "attemptId",
  "attemptNo",
  "alreadyStarted",
  "status",
  "routeSnapshot",
] as const;
const RPC_FAILURE_KEYS = ["ok", "reason"] as const;
const ATTEMPT_COMPLETE_SUCCESS_KEYS = [
  "ok",
  "alreadyCompleted",
  "status",
  "usageComplete",
] as const;
const FINALIZE_SUCCESS_KEYS = [
  "ok",
  "alreadyFinalized",
  "status",
  "quotaCharged",
  "quota",
] as const;
const QUOTA_KEYS = ["limit", "remaining", "resetAt"] as const;

const EXECUTION_FAILURE_REASONS = [
  "NOT_FOUND",
  "ALREADY_FINALIZED",
  "SERVICE_UNAVAILABLE",
] as const;
const RESERVE_BASIC_DENIAL_REASONS = [
  "AI_DISABLED",
  "SERVICE_UNAVAILABLE",
  "DUPLICATE_REQUEST",
  "REQUEST_IN_PROGRESS",
  "AI_ROUTE_CHANGED",
  "AI_TERMS_REQUIRED",
] as const;
const ATTEMPT_START_FAILURE_REASONS = [
  "NOT_FOUND",
  "ALREADY_FINALIZED",
  "SERVICE_UNAVAILABLE",
  "AI_DISABLED",
] as const;
const ATTEMPT_COMPLETE_FAILURE_REASONS = [
  "NOT_FOUND",
  "REQUEST_ALREADY_FINALIZED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
  "ATTEMPT_COMPLETION_CONFLICT",
] as const;
const FINALIZE_FAILURE_REASONS = [
  "NOT_FOUND",
  "INVALID_STATUS",
  "SERVICE_UNAVAILABLE",
  "AMBIGUOUS_USAGE_SOURCE",
  "ATTEMPT_IN_PROGRESS",
  "NO_PROVIDER_ATTEMPTS",
  "ATTEMPT_USAGE_SOURCE_REQUIRED",
  "INTERNAL_ERROR",
] as const;

const ATTEMPT_STATUSES = [
  "started",
  "succeeded",
  "invalid_output",
  "failed_upstream",
  "timed_out",
  "canceled",
  "unknown",
] as const;
const ATTEMPT_TERMINAL_STATUSES = [
  "succeeded",
  "invalid_output",
  "failed_upstream",
  "timed_out",
  "canceled",
] as const;
const FINALIZE_STATUSES = [
  "succeeded",
  "canceled",
  "failed_upstream",
  "invalid_output",
  "released",
  "abandoned",
] as const;

export type RouteObservationFieldKind =
  | "gateway_request_id"
  | "provider_request_id";
export type RouteObservationDropReason =
  | "not_string"
  | "invalid_ascii_grammar"
  | "sensitive_prefix";
export type RouteIdObservationV1 =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "dropped"; reason: RouteObservationDropReason }>
  | Readonly<{ kind: "tagged"; value: string }>;

export type ExecutionSnapshotFailureReasonV1 =
  (typeof EXECUTION_FAILURE_REASONS)[number];
export type ReserveDenialReasonV2 =
  | (typeof RESERVE_BASIC_DENIAL_REASONS)[number]
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED";
export type AttemptStartFailureReasonV2 =
  (typeof ATTEMPT_START_FAILURE_REASONS)[number];
export type AttemptCompleteFailureReasonV2 =
  (typeof ATTEMPT_COMPLETE_FAILURE_REASONS)[number];
export type FinalizeFailureReasonV2 =
  (typeof FINALIZE_FAILURE_REASONS)[number];
export type AttemptLedgerStatusV2 = (typeof ATTEMPT_STATUSES)[number];
export type AttemptTerminalStatusV2 =
  (typeof ATTEMPT_TERMINAL_STATUSES)[number];
export type FinalizeLedgerStatusV2 = (typeof FINALIZE_STATUSES)[number];

export class PolishLifecycleV2ContractError extends Error {
  readonly code:
    | "MALFORMED_RPC_RESPONSE"
    | "EXECUTION_AUTHORITY_MISMATCH"
    | "RUNTIME_TARGET_UNAVAILABLE"
    | "secret_not_string"
    | "secret_invalid_unicode"
    | "secret_empty_after_trim";

  constructor(
    code: PolishLifecycleV2ContractError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PolishLifecycleV2ContractError";
    this.code = code;
  }
}

export interface ExpectedRouteV1 {
  readonly schemaVersion: "expected_route_v1";
  readonly configGeneration: string;
  readonly profileVersionId: string;
  readonly legalBundleVersion: string;
  readonly runtimeContractId: string;
}

export interface RouteSnapshotV1 {
  readonly schemaVersion: "route_snapshot_v1";
  readonly configGeneration: string;
  readonly routingPolicyVersionId: string;
  readonly profileVersionId: string;
  readonly priceVersionId: string;
  readonly legalBundleVersion: string;
  readonly runtimeContractId: string;
  readonly gatewayKind: string;
  readonly modelId: string;
  readonly wireApiKind: string;
  readonly displayDisclosureKey: string;
}

export type ExecutionSnapshotResultV1 =
  | Readonly<{
      schemaVersion: "ai_polish_execution_snapshot_v1";
      ok: false;
      reason: ExecutionSnapshotFailureReasonV1;
    }>
  | Readonly<{
      schemaVersion: "ai_polish_execution_snapshot_v1";
      ok: true;
      reservationId: string;
      routeSnapshot: RouteSnapshotV1;
      profileExecutionConfig: Readonly<ProfileExecutionConfigV1>;
      priceSnapshot: Readonly<FrozenPriceSnapshotV1>;
    }>;

export interface RuntimeRouteDescriptorV1 {
  readonly gatewayKind: string;
  readonly adapterKind: string;
  readonly wireApiKind: string;
  readonly credentialAlias: string;
  readonly endpointAlias: string;
  readonly modelId: string;
  readonly capabilityContractId: string;
  readonly cachePolicyId: string;
  readonly calculatorKind: string;
  readonly displayDisclosureKey: string;
}

export interface RuntimeExecutionTargetV1 {
  readonly schemaVersion: "runtime_execution_target_v1";
  readonly runtimeContractId: string;
  readonly legalBundleVersion: string;
  readonly profileVersionId: string;
  readonly profileKey: string;
  readonly legalManifestId: string;
  readonly routeDescriptor: RuntimeRouteDescriptorV1;
}

export type RuntimeTargetResolverV1 = (
  target: RuntimeExecutionTargetV1,
) => boolean;

export const EMPTY_RUNTIME_TARGET_RESOLVER_V1: RuntimeTargetResolverV1 = () =>
  false;

export type ReserveRpcResultV2 =
  | Readonly<{
      allowed: true;
      reservationId: string;
      limit: number;
      remaining: number;
      resetAt: string;
      routeSnapshot: RouteSnapshotV1;
    }>
  | Readonly<{
      allowed: false;
      reason: (typeof RESERVE_BASIC_DENIAL_REASONS)[number];
      message: string;
    }>
  | Readonly<{
      allowed: false;
      reason: "QUOTA_EXCEEDED";
      message: string;
      remaining: number;
      resetAt: string;
    }>
  | Readonly<{
      allowed: false;
      reason: "RATE_LIMITED";
      message: string;
      retryAfterSeconds: number;
    }>;

export type AttemptStartRpcResultV2 =
  | Readonly<{
      ok: false;
      reason: AttemptStartFailureReasonV2;
    }>
  | Readonly<{
      ok: true;
      attemptId: string;
      attemptNo: 1 | 2;
      alreadyStarted: boolean;
      status: AttemptLedgerStatusV2;
      routeSnapshot: RouteSnapshotV1;
    }>;

export type AttemptCompleteRpcResultV2 =
  | Readonly<{
      ok: false;
      reason: AttemptCompleteFailureReasonV2;
    }>
  | Readonly<{
      ok: true;
      alreadyCompleted: boolean;
      status: AttemptTerminalStatusV2;
      usageComplete: boolean;
    }>;

export interface FinalizeQuotaSnapshotV2 {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
}

export type FinalizeRpcResultV2 =
  | Readonly<{ ok: false; reason: FinalizeFailureReasonV2 }>
  | Readonly<{
      ok: true;
      alreadyFinalized: boolean;
      status: FinalizeLedgerStatusV2;
      quotaCharged: boolean;
      quota: FinalizeQuotaSnapshotV2;
    }>;

type JsonRecord = Record<string, unknown>;

function fail(
  message: string,
  code: PolishLifecycleV2ContractError["code"] = "MALFORMED_RPC_RESPONSE",
): never {
  throw new PolishLifecycleV2ContractError(code, message);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !expected.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} keys do not match the frozen contract`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.length === 0) fail(`${label} must not be empty`);
  return result;
}

function requireCanonicalUuid(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!UUID_PATTERN.test(result)) fail(`${label} must be a canonical lowercase UUID`);
  return result;
}

function requireCodeId(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!CODE_ID_PATTERN.test(result)) fail(`${label} must be a canonical code id`);
  return result;
}

function requirePostgresBigint(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (
    !CANONICAL_DECIMAL_PATTERN.test(result) ||
    BigInt(result) > MAX_POSTGRES_BIGINT
  ) {
    fail(`${label} must be a canonical PostgreSQL bigint string`);
  }
  return result;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  options: { positive?: boolean } = {},
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (options.positive === true && value === 0) ||
    value > MAX_POSTGRES_INTEGER
  ) {
    fail(`${label} must be a bounded integer`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const result = requireNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(result))) fail(`${label} must be a timestamp`);
  return result;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${label} is not in the frozen vocabulary`);
  }
  return value as T[number];
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function parseExpectedRouteV1(value: unknown): ExpectedRouteV1 {
  const route = requireRecord(value, "expected route");
  assertExactKeys(route, EXPECTED_ROUTE_KEYS, "expected route");
  if (route.schemaVersion !== "expected_route_v1") {
    fail("expected route schemaVersion is invalid");
  }
  return Object.freeze({
    schemaVersion: "expected_route_v1",
    configGeneration: requirePostgresBigint(
      route.configGeneration,
      "expected route generation",
    ),
    profileVersionId: requireCanonicalUuid(
      route.profileVersionId,
      "expected route profile id",
    ),
    legalBundleVersion: requireCodeId(
      route.legalBundleVersion,
      "expected route legal bundle",
    ),
    runtimeContractId: requireCodeId(
      route.runtimeContractId,
      "expected route runtime id",
    ),
  });
}

export function parseRouteSnapshotV1(value: unknown): RouteSnapshotV1 {
  const route = requireRecord(value, "route snapshot");
  assertExactKeys(route, ROUTE_SNAPSHOT_KEYS, "route snapshot");
  if (route.schemaVersion !== "route_snapshot_v1") {
    fail("route snapshot schemaVersion is invalid");
  }
  return Object.freeze({
    schemaVersion: "route_snapshot_v1",
    configGeneration: requirePostgresBigint(
      route.configGeneration,
      "route snapshot generation",
    ),
    routingPolicyVersionId: requireCanonicalUuid(
      route.routingPolicyVersionId,
      "route snapshot policy id",
    ),
    profileVersionId: requireCanonicalUuid(
      route.profileVersionId,
      "route snapshot profile id",
    ),
    priceVersionId: requireCanonicalUuid(
      route.priceVersionId,
      "route snapshot price id",
    ),
    legalBundleVersion: requireCodeId(
      route.legalBundleVersion,
      "route snapshot legal bundle",
    ),
    runtimeContractId: requireCodeId(
      route.runtimeContractId,
      "route snapshot runtime id",
    ),
    gatewayKind: requireNonEmptyString(
      route.gatewayKind,
      "route snapshot gateway",
    ),
    modelId: requireNonEmptyString(route.modelId, "route snapshot model"),
    wireApiKind: requireNonEmptyString(
      route.wireApiKind,
      "route snapshot wire API",
    ),
    displayDisclosureKey: requireNonEmptyString(
      route.displayDisclosureKey,
      "route snapshot disclosure",
    ),
  });
}

export function sameRouteSnapshotV1(
  left: RouteSnapshotV1,
  right: RouteSnapshotV1,
): boolean {
  return ROUTE_SNAPSHOT_KEYS.every((key) => left[key] === right[key]);
}

function parseProfileExecutionConfigV1(
  value: unknown,
): Readonly<ProfileExecutionConfigV1> {
  try {
    return deepFreeze(structuredClone(validateProfileExecutionConfig(value)));
  } catch {
    return fail("profile execution config failed the code-owned registry");
  }
}

export function parsePriceSnapshotV1(
  value: unknown,
): Readonly<FrozenPriceSnapshotV1> {
  const price = requireRecord(value, "price snapshot");
  assertExactKeys(price, PRICE_SNAPSHOT_KEYS, "price snapshot");
  const priceVersionId = requireCanonicalUuid(
    price.priceVersionId,
    "price snapshot id",
  );
  const candidate: FrozenPriceSnapshotV1 = {
    schemaVersion: price.schemaVersion as FrozenPriceSnapshotV1["schemaVersion"],
    priceVersionId,
    currency: price.currency as string,
    calculatorKind: price.calculatorKind as string,
    components: price.components as Partial<Record<PriceComponent, string>>,
    parameters: price.parameters,
  };
  try {
    validateFrozenPriceSnapshot(candidate);
  } catch {
    return fail("price snapshot failed the code-owned calculator contract");
  }
  return deepFreeze(structuredClone(candidate));
}

function buildRuntimeExecutionTargetV1(
  route: RouteSnapshotV1,
  profile: Readonly<ProfileExecutionConfigV1>,
): RuntimeExecutionTargetV1 {
  return deepFreeze({
    schemaVersion: "runtime_execution_target_v1" as const,
    runtimeContractId: route.runtimeContractId,
    legalBundleVersion: route.legalBundleVersion,
    profileVersionId: route.profileVersionId,
    profileKey: profile.profileKey,
    legalManifestId: profile.legalManifestId,
    routeDescriptor: {
      gatewayKind: profile.gatewayKind,
      adapterKind: profile.adapterKind,
      wireApiKind: profile.wireApiKind,
      credentialAlias: profile.credentialAlias,
      endpointAlias: profile.endpointAlias,
      modelId: profile.modelId,
      capabilityContractId: profile.capabilityContractId,
      cachePolicyId: profile.cachePolicyId,
      calculatorKind: profile.calculatorKind,
      displayDisclosureKey: profile.displayDisclosureKey,
    },
  });
}

export function parseExecutionSnapshotV1(
  value: unknown,
  expected: {
    reservationId: string;
    reserveRoute: RouteSnapshotV1;
    runtimeTargetResolver: RuntimeTargetResolverV1;
  },
): ExecutionSnapshotResultV1 {
  const result = requireRecord(value, "execution snapshot");
  if (result.schemaVersion !== "ai_polish_execution_snapshot_v1") {
    fail("execution snapshot schemaVersion is invalid");
  }

  if (result.ok === false) {
    assertExactKeys(result, EXECUTION_FAILURE_KEYS, "execution snapshot failure");
    return Object.freeze({
      schemaVersion: "ai_polish_execution_snapshot_v1",
      ok: false,
      reason: requireEnum(
        result.reason,
        EXECUTION_FAILURE_REASONS,
        "execution snapshot reason",
      ),
    });
  }

  if (result.ok !== true) fail("execution snapshot discriminator is invalid");
  assertExactKeys(result, EXECUTION_SUCCESS_KEYS, "execution snapshot success");

  const reservationId = requireCanonicalUuid(
    result.reservationId,
    "execution snapshot reservation id",
  );
  if (reservationId !== requireCanonicalUuid(expected.reservationId, "expected reservation id")) {
    fail(
      "execution snapshot reservation does not match the admitted request",
      "EXECUTION_AUTHORITY_MISMATCH",
    );
  }

  const routeSnapshot = parseRouteSnapshotV1(result.routeSnapshot);
  if (!sameRouteSnapshotV1(routeSnapshot, expected.reserveRoute)) {
    fail(
      "execution route does not match the reserve route",
      "EXECUTION_AUTHORITY_MISMATCH",
    );
  }

  const profileExecutionConfig = parseProfileExecutionConfigV1(
    result.profileExecutionConfig,
  );
  const priceSnapshot = parsePriceSnapshotV1(result.priceSnapshot);

  if (routeSnapshot.priceVersionId !== priceSnapshot.priceVersionId) {
    fail("route and price ids differ", "EXECUTION_AUTHORITY_MISMATCH");
  }
  for (const key of [
    "gatewayKind",
    "modelId",
    "wireApiKind",
    "displayDisclosureKey",
  ] as const) {
    if (routeSnapshot[key] !== profileExecutionConfig[key]) {
      fail(`route and profile ${key} differ`, "EXECUTION_AUTHORITY_MISMATCH");
    }
  }
  if (profileExecutionConfig.calculatorKind !== priceSnapshot.calculatorKind) {
    fail("profile and price calculators differ", "EXECUTION_AUTHORITY_MISMATCH");
  }
  if (
    !legalBundleContainsManifest(
      routeSnapshot.legalBundleVersion,
      profileExecutionConfig.legalManifestId,
    )
  ) {
    fail("profile legal manifest is not in the route bundle", "EXECUTION_AUTHORITY_MISMATCH");
  }

  const runtimeTarget = buildRuntimeExecutionTargetV1(
    routeSnapshot,
    profileExecutionConfig,
  );
  let runtimeAccepted = false;
  try {
    runtimeAccepted = expected.runtimeTargetResolver(runtimeTarget) === true;
  } catch {
    runtimeAccepted = false;
  }
  if (!runtimeAccepted) {
    fail(
      "runtime contract does not authorize the exact execution target",
      "RUNTIME_TARGET_UNAVAILABLE",
    );
  }

  return deepFreeze({
    schemaVersion: "ai_polish_execution_snapshot_v1" as const,
    ok: true as const,
    reservationId,
    routeSnapshot,
    profileExecutionConfig,
    priceSnapshot,
  });
}

export function parseReserveRpcResultV2(value: unknown): ReserveRpcResultV2 {
  const result = requireRecord(value, "reserve V2 response");
  if (result.allowed === true) {
    assertExactKeys(result, RESERVE_SUCCESS_KEYS, "reserve V2 success");
    return Object.freeze({
      allowed: true,
      reservationId: requireCanonicalUuid(
        result.reservationId,
        "reserve reservation id",
      ),
      limit: requireSafeInteger(result.limit, "reserve limit"),
      remaining: requireSafeInteger(result.remaining, "reserve remaining"),
      resetAt: requireTimestamp(result.resetAt, "reserve resetAt"),
      routeSnapshot: parseRouteSnapshotV1(result.routeSnapshot),
    });
  }
  if (result.allowed !== false) fail("reserve V2 discriminator is invalid");

  if (result.reason === "QUOTA_EXCEEDED") {
    assertExactKeys(result, RESERVE_QUOTA_DENIAL_KEYS, "reserve quota denial");
    return Object.freeze({
      allowed: false,
      reason: "QUOTA_EXCEEDED",
      message: requireNonEmptyString(result.message, "reserve denial message"),
      remaining: requireSafeInteger(result.remaining, "reserve remaining"),
      resetAt: requireTimestamp(result.resetAt, "reserve resetAt"),
    });
  }
  if (result.reason === "RATE_LIMITED") {
    assertExactKeys(result, RESERVE_RATE_DENIAL_KEYS, "reserve rate denial");
    return Object.freeze({
      allowed: false,
      reason: "RATE_LIMITED",
      message: requireNonEmptyString(result.message, "reserve denial message"),
      retryAfterSeconds: requireSafeInteger(
        result.retryAfterSeconds,
        "reserve retryAfterSeconds",
        { positive: true },
      ),
    });
  }

  assertExactKeys(result, RESERVE_BASIC_DENIAL_KEYS, "reserve basic denial");
  return Object.freeze({
    allowed: false,
    reason: requireEnum(
      result.reason,
      RESERVE_BASIC_DENIAL_REASONS,
      "reserve denial reason",
    ),
    message: requireNonEmptyString(result.message, "reserve denial message"),
  });
}

export function parseAttemptStartRpcResultV2(
  value: unknown,
): AttemptStartRpcResultV2 {
  const result = requireRecord(value, "attempt start response");
  if (result.ok === false) {
    assertExactKeys(result, RPC_FAILURE_KEYS, "attempt start failure");
    return Object.freeze({
      ok: false,
      reason: requireEnum(
        result.reason,
        ATTEMPT_START_FAILURE_REASONS,
        "attempt start reason",
      ),
    });
  }
  if (result.ok !== true) fail("attempt start discriminator is invalid");
  assertExactKeys(result, ATTEMPT_START_SUCCESS_KEYS, "attempt start success");
  const attemptNo = requireSafeInteger(result.attemptNo, "attempt number", {
    positive: true,
  });
  if (attemptNo !== 1 && attemptNo !== 2) fail("attempt number is outside the budget");
  return Object.freeze({
    ok: true,
    attemptId: requireCanonicalUuid(result.attemptId, "attempt id"),
    attemptNo,
    alreadyStarted: requireBoolean(result.alreadyStarted, "alreadyStarted"),
    status: requireEnum(result.status, ATTEMPT_STATUSES, "attempt status"),
    routeSnapshot: parseRouteSnapshotV1(result.routeSnapshot),
  });
}

export function parseAttemptCompleteRpcResultV2(
  value: unknown,
): AttemptCompleteRpcResultV2 {
  const result = requireRecord(value, "attempt complete response");
  if (result.ok === false) {
    assertExactKeys(result, RPC_FAILURE_KEYS, "attempt complete failure");
    return Object.freeze({
      ok: false,
      reason: requireEnum(
        result.reason,
        ATTEMPT_COMPLETE_FAILURE_REASONS,
        "attempt complete reason",
      ),
    });
  }
  if (result.ok !== true) fail("attempt complete discriminator is invalid");
  assertExactKeys(
    result,
    ATTEMPT_COMPLETE_SUCCESS_KEYS,
    "attempt complete success",
  );
  return Object.freeze({
    ok: true,
    alreadyCompleted: requireBoolean(
      result.alreadyCompleted,
      "alreadyCompleted",
    ),
    status: requireEnum(
      result.status,
      ATTEMPT_TERMINAL_STATUSES,
      "completed attempt status",
    ),
    usageComplete: requireBoolean(result.usageComplete, "usageComplete"),
  });
}

export function parseFinalizeRpcResultV2(value: unknown): FinalizeRpcResultV2 {
  const result = requireRecord(value, "finalize response");
  if (result.ok === false) {
    assertExactKeys(result, RPC_FAILURE_KEYS, "finalize failure");
    return Object.freeze({
      ok: false,
      reason: requireEnum(
        result.reason,
        FINALIZE_FAILURE_REASONS,
        "finalize reason",
      ),
    });
  }
  if (result.ok !== true) fail("finalize discriminator is invalid");
  assertExactKeys(result, FINALIZE_SUCCESS_KEYS, "finalize success");
  const quota = requireRecord(result.quota, "finalize quota");
  assertExactKeys(quota, QUOTA_KEYS, "finalize quota");
  return deepFreeze({
    ok: true as const,
    alreadyFinalized: requireBoolean(
      result.alreadyFinalized,
      "alreadyFinalized",
    ),
    status: requireEnum(result.status, FINALIZE_STATUSES, "finalize status"),
    quotaCharged: requireBoolean(result.quotaCharged, "quotaCharged"),
    quota: {
      limit: requireSafeInteger(quota.limit, "finalize quota limit"),
      remaining: requireSafeInteger(
        quota.remaining,
        "finalize quota remaining",
      ),
      resetAt: requireTimestamp(quota.resetAt, "finalize quota resetAt"),
    },
  });
}

const RAW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const SENSITIVE_PREFIXES = [
  "access-token",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "authorization",
  "basic",
  "bearer",
  "cookie",
  "eyj",
  "ghp_",
  "github_pat_",
  "passwd",
  "password",
  "refresh-token",
  "refresh_token",
  "secret",
  "set-cookie",
  "sk-",
  "sk_",
  "token",
  "x-api-key",
  "x-auth-token",
] as const;
const ROUTE_FIELD_KINDS = [
  "gateway_request_id",
  "provider_request_id",
] as const;

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("route observation secret contains invalid Unicode", "secret_invalid_unicode");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail("route observation secret contains invalid Unicode", "secret_invalid_unicode");
    }
  }
}

function isContractWhitespace(scalar: string): boolean {
  const codePoint = scalar.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x0009 && codePoint <= 0x000d) ||
      codePoint === 0x0020 ||
      codePoint === 0x00a0 ||
      codePoint === 0x1680 ||
      (codePoint >= 0x2000 && codePoint <= 0x200a) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0x202f ||
      codePoint === 0x205f ||
      codePoint === 0x3000 ||
      codePoint === 0xfeff)
  );
}

function routeObservationSecretBytes(secret: unknown): Buffer {
  if (typeof secret !== "string") {
    fail("route observation secret is not a string", "secret_not_string");
  }
  assertUnicodeScalarString(secret);
  const scalars = Array.from(secret);
  let start = 0;
  let end = scalars.length;
  while (start < end && isContractWhitespace(scalars[start])) start += 1;
  while (end > start && isContractWhitespace(scalars[end - 1])) end -= 1;
  if (start === end) {
    fail("route observation secret is empty after trim", "secret_empty_after_trim");
  }
  return Buffer.from(scalars.slice(start, end).join(""), "utf8");
}

function classifyRawRouteId(
  value: unknown,
):
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "dropped"; reason: RouteObservationDropReason }>
  | Readonly<{ kind: "eligible"; rawId: string }> {
  if (value === null || value === undefined) return Object.freeze({ kind: "absent" });
  if (typeof value !== "string") {
    return Object.freeze({ kind: "dropped", reason: "not_string" });
  }
  if (!RAW_ID_PATTERN.test(value)) {
    return Object.freeze({
      kind: "dropped",
      reason: "invalid_ascii_grammar",
    });
  }
  const lower = value.toLowerCase();
  if (SENSITIVE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return Object.freeze({ kind: "dropped", reason: "sensitive_prefix" });
  }
  return Object.freeze({ kind: "eligible", rawId: value });
}

export function observeRouteIdentifierV1(
  value: unknown,
  fieldKind: string,
  secret: unknown,
): RouteIdObservationV1 {
  const classified = classifyRawRouteId(value);
  if (classified.kind !== "eligible") return classified;
  if (!(ROUTE_FIELD_KINDS as readonly string[]).includes(fieldKind)) {
    fail("route observation field kind is unknown");
  }
  const message = Buffer.from(
    `route-observation-v1\nfield_kind:${fieldKind}\nraw_id_utf8_length:${Buffer.byteLength(classified.rawId, "utf8")}\nraw_id:${classified.rawId}`,
    "utf8",
  );
  const digest = createHmac("sha256", routeObservationSecretBytes(secret))
    .update(message)
    .digest("hex");
  return Object.freeze({ kind: "tagged", value: `hmac-sha256:${digest}` });
}
