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
 * Local development uses a DIFFERENT configuration: POLISH_FAKE_LLM=true
 * WITHOUT this flag keeps the REAL auth/terms/quota path against the local
 * Supabase (only the LLM is faked), which is how the full chain is manually
 * verified end-to-end.
 *
 * Safety: this module is only reachable when POLISH_FAKE_LLM=true, which
 * getPolishProvider() refuses in production (unless the CI marker is set), so
 * these stubs can never serve a real deployment.
 */

import { randomUUID } from "node:crypto";

import type { PolishProvider } from "./provider";
import type { PolishRouteDeps } from "./lifecycle";

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
