/**
 * Fake backend dependencies for the polish routes (unit 2.3), selected when
 * POLISH_FAKE_BACKEND=true (requires POLISH_FAKE_LLM=true).
 *
 * Purpose: the CI smoke (ci.yml web-server-build) boots `next start` WITHOUT
 * a Supabase instance and still exercises the full request lifecycle —
 * auth → reserve → orchestrate (deterministic fake LLM) → finalize → 200.
 * Every auth/quota dependency is replaced by an in-memory stub whose answers
 * are always permissive, so no database or GoTrue service is needed.
 *
 * The public V2 handler deliberately does not support fake inference against
 * real Supabase accounting. Local deterministic verification therefore uses
 * this complete two-flag backend; real-backend verification uses the real
 * selected adapter only after reviewed runtime attestation exists.
 *
 * Safety: both fake factories require POLISH_FAKE_LLM=true and the V2 factory
 * additionally requires POLISH_FAKE_BACKEND=true; production is allowed only
 * with the process-owned CI marker, so these stubs cannot serve a deployment.
 */

import { randomUUID } from "node:crypto";

import type { PolishProvider } from "./provider";
import type { PolishRouteDeps } from "./lifecycle";
import type { PolishRouteDepsV2 } from "./lifecycle-v2";
import {
  parseExecutionSnapshotV1,
  sameRouteSnapshotV1,
  type ExpectedRouteV1,
  type RouteSnapshotV1,
} from "./lifecycle-v2-contract";
import { INITIAL_LEGAL_BUNDLE_VERSION, resolveProfile } from "./profile-registry";
import type { FakePolishInferenceProviderV2 } from "./provider-fake";
import {
  PolishLifecycleV2RpcError,
  serializePolishAttemptCompletionV2,
  serializePolishFinalizeV2,
  type ProviderAttemptStartV2,
} from "./quota";

/** Fixed pseudonymous user id every fake token resolves to. */
export const FAKE_BACKEND_USER_ID = "00000000-0000-4000-8000-0000000000fa";

/** Next UTC midnight, ISO — mirrors the RPC resetAt semantics. */
function nextUtcMidnightIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

export function createFakePolishRouteDeps(options: {
  provider: PolishProvider;
  env?: Record<string, string | undefined>;
}): PolishRouteDeps {
  const env = options.env ?? process.env;

  return {
    // Any well-formed Bearer token authenticates (the 401-no-token case is
    // decided before this is called); terms are always accepted.
    verifyAccessToken: async (token) => (token.length > 0 ? FAKE_BACKEND_USER_ID : null),
    hasAcceptedCurrentAiTerms: async () => true,

    reserve: async () => ({
      reservationId: randomUUID(),
      limit: 20,
      remaining: 19,
      resetAt: nextUtcMidnightIso(),
    }),
    markProviderStarted: async () => ({ started: true, attemptCount: 1 }),
    // Mirrors the real finalize RPC's atomic post-settlement quota snapshot.
    finalize: async () => ({
      alreadyFinalized: false,
      quota: { limit: 20, remaining: 19, resetAt: nextUtcMidnightIso() },
    }),
    getQuota: async () => ({ limit: 20, remaining: 20, resetAt: nextUtcMidnightIso() }),

    provider: options.provider,
    // The fake LLM ignores the id; keep it self-describing rather than
    // HMAC-looking so smoke logs are never mistaken for production ones.
    providerUserId: (userId) => `fake-backend-${userId}`,
    model: "fake-llm",
    aiPolishEnabled: env.AI_POLISH_ENABLED === "true",
  };
}

/**
 * V2 test-only backend shape.  Lifecycle code can opt into the deterministic
 * inference fixture without changing the existing V1 fake route or its
 * production guard.  No request content is copied into these dependencies.
 */
export interface FakePolishRouteDepsV2 extends PolishRouteDepsV2 {
  readonly providerV2: FakePolishInferenceProviderV2;
  readonly legacyV1: PolishRouteDeps;
}

interface FakeV2Reservation {
  readonly userId: string;
  readonly route: RouteSnapshotV1;
  readonly attempts: Map<1 | 2, ProviderAttemptStartV2>;
  readonly completedAttempts: Set<string>;
  finalized: boolean;
}

export const FAKE_V2_POLICY_VERSION_ID = "00000000-0000-4000-8000-0000000000f1";
const FAKE_V2_PRICE_VERSION_ID = "00000000-0000-4000-8000-0000000000f2";
export const FAKE_V2_EXPECTED_ROUTE: ExpectedRouteV1 = Object.freeze({
  schemaVersion: "expected_route_v1",
  configGeneration: "9223372036854775807",
  profileVersionId: "11111111-1111-4111-8111-111111111111",
  legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
  runtimeContractId: "runtime.deepseek-v2.v1",
});
const FAKE_V2_PRICE = Object.freeze({
  schemaVersion: "price_snapshot_v1" as const,
  priceVersionId: FAKE_V2_PRICE_VERSION_ID,
  currency: "CNY",
  calculatorKind: "linear_token_v1",
  components: Object.freeze({
    input_standard: "1000000000",
    input_cache_read: "50000000",
    output: "2000000000",
  }),
  parameters: Object.freeze({}),
});

function sameExpectedRoute(left: ExpectedRouteV1, right: ExpectedRouteV1): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.configGeneration === right.configGeneration &&
    left.profileVersionId === right.profileVersionId &&
    left.legalBundleVersion === right.legalBundleVersion &&
    left.runtimeContractId === right.runtimeContractId
  );
}

function fakeV2Route(): RouteSnapshotV1 {
  const profile = resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1");
  return Object.freeze({
    schemaVersion: "route_snapshot_v1",
    configGeneration: FAKE_V2_EXPECTED_ROUTE.configGeneration,
    routingPolicyVersionId: FAKE_V2_POLICY_VERSION_ID,
    profileVersionId: FAKE_V2_EXPECTED_ROUTE.profileVersionId,
    priceVersionId: FAKE_V2_PRICE_VERSION_ID,
    legalBundleVersion: FAKE_V2_EXPECTED_ROUTE.legalBundleVersion,
    runtimeContractId: FAKE_V2_EXPECTED_ROUTE.runtimeContractId,
    gatewayKind: profile.gatewayKind,
    modelId: profile.modelId,
    wireApiKind: profile.wireApiKind,
    displayDisclosureKey: profile.displayDisclosureKey,
  });
}

export function createFakePolishV2RouteDeps(options: {
  provider: PolishProvider;
  providerV2: FakePolishInferenceProviderV2;
  env?: Record<string, string | undefined>;
}): FakePolishRouteDepsV2 {
  const env = options.env ?? process.env;
  if (env.POLISH_FAKE_LLM !== "true" || env.POLISH_FAKE_BACKEND !== "true") {
    throw new Error("V2 fake backend requires both fake safety gates");
  }
  if (env.NODE_ENV === "production" && env.CI !== "true") {
    throw new Error("V2 fake backend is forbidden outside the production CI smoke");
  }
  const reservations = new Map<string, FakeV2Reservation>();
  const resetAt = () => nextUtcMidnightIso();
  const legacyV1 = createFakePolishRouteDeps(options);

  return {
    async reserve(params) {
      if (!legacyV1.aiPolishEnabled) {
        throw new PolishLifecycleV2RpcError("RESERVE_DENIED", {
          reason: "AI_DISABLED",
        });
      }
      if (!sameExpectedRoute(params.expectedRoute, FAKE_V2_EXPECTED_ROUTE)) {
        throw new PolishLifecycleV2RpcError("RESERVE_DENIED", {
          reason: "AI_ROUTE_CHANGED",
        });
      }
      const reservationId = randomUUID();
      const route = fakeV2Route();
      reservations.set(reservationId, {
        userId: params.userId,
        route,
        attempts: new Map(),
        completedAttempts: new Set(),
        finalized: false,
      });
      return {
        allowed: true,
        reservationId,
        limit: 20,
        remaining: 19,
        resetAt: resetAt(),
        routeSnapshot: route,
      };
    },
    async getExecutionSnapshot(params) {
      const reservation = reservations.get(params.reservationId);
      const raw =
        reservation === undefined || reservation.userId !== params.userId
          ? {
              schemaVersion: "ai_polish_execution_snapshot_v1",
              ok: false,
              reason: "NOT_FOUND",
            }
          : {
              schemaVersion: "ai_polish_execution_snapshot_v1",
              ok: true,
              reservationId: params.reservationId,
              routeSnapshot: reservation.route,
              profileExecutionConfig: resolveProfile(
                "deepseek.official.deepseek-v4-flash.chat.v1",
              ),
              priceSnapshot: FAKE_V2_PRICE,
            };
      const parsed = parseExecutionSnapshotV1(raw, {
        reservationId: params.reservationId,
        reserveRoute: params.reserveRoute,
        runtimeTargetResolver: params.runtimeTargetResolver,
      });
      if (!parsed.ok) {
        throw new PolishLifecycleV2RpcError("SNAPSHOT_DENIED", {
          reason: parsed.reason,
        });
      }
      return parsed;
    },
    async startAttempt(params) {
      const reservation = reservations.get(params.reservationId);
      if (
        reservation === undefined ||
        reservation.finalized ||
        !sameRouteSnapshotV1(reservation.route, params.expectedRoute)
      ) {
        throw new PolishLifecycleV2RpcError("ATTEMPT_START_DENIED", {
          reason: reservation?.finalized ? "ALREADY_FINALIZED" : "NOT_FOUND",
        });
      }
      const replay = reservation.attempts.get(params.attemptNo);
      if (replay !== undefined) return { ...replay, alreadyStarted: true };
      const receipt: ProviderAttemptStartV2 = Object.freeze({
        ok: true,
        attemptId: randomUUID(),
        attemptNo: params.attemptNo,
        alreadyStarted: false,
        status: "started",
        routeSnapshot: reservation.route,
      });
      reservation.attempts.set(params.attemptNo, receipt);
      return receipt;
    },
    async completeAttempt(params) {
      const payload = serializePolishAttemptCompletionV2(params);
      const reservation = [...reservations.values()].find((candidate) =>
        [...candidate.attempts.values()].some(
          (attempt) => attempt.attemptId === payload.p_attempt_id,
        ),
      );
      if (reservation === undefined || reservation.finalized) {
        throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_REJECTED", {
          reason: reservation?.finalized ? "REQUEST_ALREADY_FINALIZED" : "NOT_FOUND",
        });
      }
      const alreadyCompleted = reservation.completedAttempts.has(payload.p_attempt_id);
      reservation.completedAttempts.add(payload.p_attempt_id);
      return {
        ok: true,
        alreadyCompleted,
        status: payload.p_status,
        usageComplete: payload.p_usage?.usage_complete ?? false,
      };
    },
    async recordCancellation(params) {
      const reservation = reservations.get(params.reservationId);
      if (reservation === undefined || reservation.finalized) {
        throw new PolishLifecycleV2RpcError("CANCELLATION_REJECTED", {
          reason: reservation?.finalized ? "ALREADY_FINALIZED" : "NOT_FOUND",
        });
      }
      return Object.freeze({
        ok: true as const,
        reservationId: params.reservationId,
        state: "observed" as const,
      });
    },
    async finalize(params) {
      const payload = serializePolishFinalizeV2(params);
      const reservation = reservations.get(payload.p_reservation_id);
      if (reservation === undefined) {
        throw new PolishLifecycleV2RpcError("FINALIZE_REJECTED", {
          reason: "NOT_FOUND",
        });
      }
      if (params.settlementKind === "zero_child_release") {
        if (reservation.attempts.size !== 0) {
          throw new PolishLifecycleV2RpcError("FINALIZE_REJECTED", {
            reason: "NO_PROVIDER_ATTEMPTS",
          });
        }
      } else if (
        reservation.attempts.size === 0 ||
        reservation.completedAttempts.size !== reservation.attempts.size
      ) {
        throw new PolishLifecycleV2RpcError("FINALIZE_REJECTED", {
          reason: "ATTEMPT_IN_PROGRESS",
        });
      }
      reservation.finalized = true;
      return {
        ok: true,
        alreadyFinalized: false,
        status: payload.p_status,
        quotaCharged: payload.p_quota_charged,
        quota: {
          limit: 20,
          remaining: payload.p_quota_charged ? 19 : 20,
          resetAt: resetAt(),
        },
      };
    },
    runtimeTargetResolver: () => true,
    resolveProvider: () => options.providerV2,
    providerSubjectSecret: "fake-provider-subject-secret",
    routeObservationSecret: "fake-route-observation-secret",
    providerV2: options.providerV2,
    legacyV1,
  };
}
