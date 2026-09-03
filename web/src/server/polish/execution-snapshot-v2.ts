import type { ProfileExecutionConfigV1 } from "./profile-registry";
import {
  parseExecutionSnapshotV1,
  parsePriceSnapshotV1,
  parseRouteSnapshotV1,
  PolishLifecycleV2ContractError,
  sameRouteSnapshotV1,
  type ExecutionSnapshotResultV1,
  type RouteSnapshotV1,
  type RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";
import {
  validateProfileExecutionConfigV2,
  type ProfileExecutionConfigV2,
} from "./profile-execution-v2";
import { resolveRuntimeCodeCapabilityV2 } from "./runtime-code-capability-v2";
import type { FrozenPriceSnapshotV1 } from "./pricing";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SUCCESS_KEYS = [
  "schemaVersion",
  "ok",
  "reservationId",
  "routeSnapshot",
  "profileExecutionConfig",
  "priceSnapshot",
  "runtimeEvidence",
] as const;
const CODE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/u;
const LOWER_HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const RUNTIME_EVIDENCE_KEYS = [
  "schemaVersion",
  "runtimeContractId",
  "runtimeTargetId",
  "runtimeTargetSha256",
  "routeDescriptorId",
  "routeDescriptorSha256",
  "profileVersionId",
  "priceVersionId",
  "providerId",
  "recipientKey",
  "codeCapabilityId",
  "codeCapabilitySha256",
  "gatewayKind",
  "adapterKind",
  "wireApiKind",
  "endpointUrl",
  "credentialEnvName",
  "modelId",
  "capabilityContractId",
  "cachePolicyId",
  "calculatorKind",
  "legalBundleVersion",
  "legalManifestId",
  "legalManifestSha256",
  "displayDisclosureKey",
  "externalEvidenceIds",
] as const;

export interface RuntimeExecutionEvidenceV2 {
  readonly schemaVersion: "runtime_execution_evidence_v2";
  readonly runtimeContractId: string;
  readonly runtimeTargetId: string;
  readonly runtimeTargetSha256: string;
  readonly routeDescriptorId: string;
  readonly routeDescriptorSha256: string;
  readonly profileVersionId: string;
  readonly priceVersionId: string;
  readonly providerId: string;
  readonly recipientKey: string;
  readonly codeCapabilityId: string;
  readonly codeCapabilitySha256: string;
  readonly gatewayKind: ProfileExecutionConfigV2["gatewayKind"];
  readonly adapterKind: ProfileExecutionConfigV2["adapterKind"];
  readonly wireApiKind: ProfileExecutionConfigV2["wireApiKind"];
  readonly endpointUrl: string;
  readonly credentialEnvName: string;
  readonly modelId: string;
  readonly capabilityContractId: string;
  readonly cachePolicyId: string;
  readonly calculatorKind: string;
  readonly legalBundleVersion: string;
  readonly legalManifestId: string;
  readonly legalManifestSha256: string;
  readonly displayDisclosureKey: string;
  readonly externalEvidenceIds: readonly string[];
}

export interface RuntimeExecutionTargetV2 {
  readonly schemaVersion: "runtime_execution_target_v2";
  readonly runtimeContractId: string;
  readonly legalBundleVersion: string;
  readonly profileVersionId: string;
  readonly profile: Readonly<ProfileExecutionConfigV2>;
  readonly evidence: Readonly<RuntimeExecutionEvidenceV2>;
}

export type RuntimeTargetResolverV2 = (
  target: RuntimeExecutionTargetV2,
) => boolean;

export const EMPTY_RUNTIME_TARGET_RESOLVER_V2: RuntimeTargetResolverV2 = () =>
  false;

export type ExecutionSnapshotResultV2 =
  | ExecutionSnapshotResultV1
  | Readonly<{
      schemaVersion: "ai_polish_execution_snapshot_v2";
      ok: true;
      reservationId: string;
      routeSnapshot: RouteSnapshotV1;
      profileExecutionConfig: Readonly<ProfileExecutionConfigV2>;
      priceSnapshot: Readonly<FrozenPriceSnapshotV1>;
      runtimeEvidence: Readonly<RuntimeExecutionEvidenceV2>;
    }>;

export type VersionedProfileExecutionConfig =
  | Readonly<ProfileExecutionConfigV1>
  | Readonly<ProfileExecutionConfigV2>;

function fail(
  message: string,
  code: PolishLifecycleV2ContractError["code"] = "MALFORMED_RPC_RESPONSE",
): never {
  throw new PolishLifecycleV2ContractError(
    code,
    `invalid versioned execution snapshot: ${message}`,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("object required");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    fail("unexpected fields");
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  pattern?: RegExp,
): string {
  const result = value[key];
  if (
    typeof result !== "string" ||
    result.length === 0 ||
    (pattern !== undefined && !pattern.test(result))
  ) {
    fail(`invalid runtime evidence ${key}`);
  }
  return result;
}

export function parseRuntimeExecutionEvidenceV2(
  value: unknown,
): Readonly<RuntimeExecutionEvidenceV2> {
  const input = record(value);
  exactKeys(input, RUNTIME_EVIDENCE_KEYS);
  if (input.schemaVersion !== "runtime_execution_evidence_v2") {
    fail("invalid runtime evidence schema");
  }
  const externalEvidenceIds = input.externalEvidenceIds;
  if (
    !Array.isArray(externalEvidenceIds) ||
    externalEvidenceIds.length === 0 ||
    externalEvidenceIds.length > 64 ||
    externalEvidenceIds.some(
      (id) => typeof id !== "string" || !CODE_ID_PATTERN.test(id),
    ) ||
    new Set(externalEvidenceIds).size !== externalEvidenceIds.length
  ) {
    fail("invalid runtime evidence externalEvidenceIds");
  }
  const evidence = {
    schemaVersion: "runtime_execution_evidence_v2" as const,
    runtimeContractId: requiredString(input, "runtimeContractId", CODE_ID_PATTERN),
    runtimeTargetId: requiredString(input, "runtimeTargetId", CODE_ID_PATTERN),
    runtimeTargetSha256: requiredString(input, "runtimeTargetSha256", LOWER_HEX_64_PATTERN),
    routeDescriptorId: requiredString(input, "routeDescriptorId", CODE_ID_PATTERN),
    routeDescriptorSha256: requiredString(input, "routeDescriptorSha256", LOWER_HEX_64_PATTERN),
    profileVersionId: requiredString(input, "profileVersionId", UUID_PATTERN),
    priceVersionId: requiredString(input, "priceVersionId", UUID_PATTERN),
    providerId: requiredString(input, "providerId", UUID_PATTERN),
    recipientKey: requiredString(input, "recipientKey", CODE_ID_PATTERN),
    codeCapabilityId: requiredString(input, "codeCapabilityId", CODE_ID_PATTERN),
    codeCapabilitySha256: requiredString(input, "codeCapabilitySha256", LOWER_HEX_64_PATTERN),
    gatewayKind: requiredString(input, "gatewayKind") as ProfileExecutionConfigV2["gatewayKind"],
    adapterKind: requiredString(input, "adapterKind") as ProfileExecutionConfigV2["adapterKind"],
    wireApiKind: requiredString(input, "wireApiKind") as ProfileExecutionConfigV2["wireApiKind"],
    endpointUrl: requiredString(input, "endpointUrl"),
    credentialEnvName: requiredString(input, "credentialEnvName"),
    modelId: requiredString(input, "modelId"),
    capabilityContractId: requiredString(input, "capabilityContractId", CODE_ID_PATTERN),
    cachePolicyId: requiredString(input, "cachePolicyId", CODE_ID_PATTERN),
    calculatorKind: requiredString(input, "calculatorKind", CODE_ID_PATTERN),
    legalBundleVersion: requiredString(input, "legalBundleVersion", CODE_ID_PATTERN),
    legalManifestId: requiredString(input, "legalManifestId", CODE_ID_PATTERN),
    legalManifestSha256: requiredString(input, "legalManifestSha256", LOWER_HEX_64_PATTERN),
    displayDisclosureKey: requiredString(input, "displayDisclosureKey", CODE_ID_PATTERN),
    externalEvidenceIds: Object.freeze([...externalEvidenceIds]) as readonly string[],
  };
  return Object.freeze(evidence);
}

export function parseVersionedExecutionSnapshot(
  value: unknown,
  expected: {
    reservationId: string;
    reserveRoute: RouteSnapshotV1;
    runtimeTargetResolverV1: RuntimeTargetResolverV1;
    runtimeTargetResolverV2: RuntimeTargetResolverV2;
  },
): ExecutionSnapshotResultV2 {
  const input = record(value);
  if (input.schemaVersion !== "ai_polish_execution_snapshot_v2") {
    return parseExecutionSnapshotV1(value, {
      reservationId: expected.reservationId,
      reserveRoute: expected.reserveRoute,
      runtimeTargetResolver: expected.runtimeTargetResolverV1,
    });
  }
  if (input.ok !== true) fail("v2 response must be a success branch");
  exactKeys(input, SUCCESS_KEYS);
  if (
    typeof input.reservationId !== "string" ||
    !UUID_PATTERN.test(input.reservationId) ||
    input.reservationId !== expected.reservationId
  ) {
    fail("reservation mismatch");
  }

  const route = parseRouteSnapshotV1(input.routeSnapshot);
  if (!sameRouteSnapshotV1(route, expected.reserveRoute)) fail("route mismatch");
  const profile = validateProfileExecutionConfigV2(input.profileExecutionConfig);
  const price = parsePriceSnapshotV1(input.priceSnapshot);
  const evidence = parseRuntimeExecutionEvidenceV2(input.runtimeEvidence);
  const compiledCapability = (() => {
    try {
      return resolveRuntimeCodeCapabilityV2(evidence.codeCapabilityId);
    } catch {
      return fail(
        "runtime code capability unavailable",
        "RUNTIME_TARGET_UNAVAILABLE",
      );
    }
  })();
  if (
    route.priceVersionId !== price.priceVersionId ||
    route.gatewayKind !== profile.gatewayKind ||
    route.modelId !== profile.modelId ||
    route.wireApiKind !== profile.wireApiKind ||
    route.displayDisclosureKey !== profile.displayDisclosureKey ||
    price.calculatorKind !== profile.calculatorKind ||
    evidence.runtimeContractId !== route.runtimeContractId ||
    evidence.profileVersionId !== route.profileVersionId ||
    evidence.priceVersionId !== route.priceVersionId ||
    evidence.providerId !== profile.providerId ||
    evidence.gatewayKind !== profile.gatewayKind ||
    evidence.adapterKind !== profile.adapterKind ||
    evidence.wireApiKind !== profile.wireApiKind ||
    evidence.endpointUrl !== profile.endpointUrl ||
    evidence.credentialEnvName !== profile.credentialEnvName ||
    evidence.modelId !== profile.modelId ||
    evidence.capabilityContractId !== profile.capabilityContractId ||
    evidence.cachePolicyId !== profile.cachePolicyId ||
    evidence.calculatorKind !== price.calculatorKind ||
    evidence.legalBundleVersion !== route.legalBundleVersion ||
    evidence.legalManifestId !== profile.legalManifestId ||
    evidence.displayDisclosureKey !== route.displayDisclosureKey ||
    compiledCapability.descriptorSha256 !== evidence.codeCapabilitySha256 ||
    compiledCapability.gatewayKind !== evidence.gatewayKind ||
    compiledCapability.adapterKind !== evidence.adapterKind ||
    compiledCapability.wireApiKind !== evidence.wireApiKind ||
    compiledCapability.capabilityContractId !== evidence.capabilityContractId ||
    compiledCapability.cachePolicyId !== evidence.cachePolicyId ||
    compiledCapability.calculatorKind !== evidence.calculatorKind
  ) {
    fail("frozen authority mismatch", "EXECUTION_AUTHORITY_MISMATCH");
  }

  const target = Object.freeze({
    schemaVersion: "runtime_execution_target_v2" as const,
    runtimeContractId: route.runtimeContractId,
    legalBundleVersion: route.legalBundleVersion,
    profileVersionId: route.profileVersionId,
    profile,
    evidence,
  });
  let accepted = false;
  try {
    accepted = expected.runtimeTargetResolverV2(target) === true;
  } catch {
    accepted = false;
  }
  if (!accepted) fail("runtime target unavailable", "RUNTIME_TARGET_UNAVAILABLE");

  return Object.freeze({
    schemaVersion: "ai_polish_execution_snapshot_v2" as const,
    ok: true as const,
    reservationId: input.reservationId,
    routeSnapshot: route,
    profileExecutionConfig: profile,
    priceSnapshot: price,
    runtimeEvidence: evidence,
  });
}
