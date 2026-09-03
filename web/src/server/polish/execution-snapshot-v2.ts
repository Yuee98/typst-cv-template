import {
  legalBundleContainsManifest,
  type ProfileExecutionConfigV1,
} from "./profile-registry";
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
] as const;

export interface RuntimeExecutionTargetV2 {
  readonly schemaVersion: "runtime_execution_target_v2";
  readonly runtimeContractId: string;
  readonly legalBundleVersion: string;
  readonly profileVersionId: string;
  readonly profile: Readonly<ProfileExecutionConfigV2>;
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
  if (
    route.priceVersionId !== price.priceVersionId ||
    route.gatewayKind !== profile.gatewayKind ||
    route.modelId !== profile.modelId ||
    route.wireApiKind !== profile.wireApiKind ||
    route.displayDisclosureKey !== profile.displayDisclosureKey ||
    price.calculatorKind !== profile.calculatorKind ||
    !legalBundleContainsManifest(route.legalBundleVersion, profile.legalManifestId)
  ) {
    fail("frozen authority mismatch", "EXECUTION_AUTHORITY_MISMATCH");
  }

  const target = Object.freeze({
    schemaVersion: "runtime_execution_target_v2" as const,
    runtimeContractId: route.runtimeContractId,
    legalBundleVersion: route.legalBundleVersion,
    profileVersionId: route.profileVersionId,
    profile,
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
  });
}
