/**
 * Bearer-token authentication and AI-terms gate for the polish API.
 *
 * Roadmap: tmp/ai-polish-roadmap.md —「API 契约」session validation. A
 * publishable-key client verifies the user access token via
 * `auth.getUser(token)`; a service_role admin client performs the terms
 * lookup. The migration's `has_accepted_current_ai_terms()` RPC depends on
 * `auth.uid()`, which is NULL under service_role, so the terms predicate
 * (document_key + current version) is executed as a direct query with an
 * explicit filter on the verified user id instead.
 *
 * Error semantics align with POLISH_ERROR_CODES: missing/invalid token →
 * 401 UNAUTHORIZED; authenticated but current AI terms not accepted →
 * 403 AI_TERMS_REQUIRED; infrastructure failure → 500 INTERNAL_ERROR.
 *
 * Dependencies are injectable so unit tests never touch real services.
 */

import { AI_TERMS_VERSION } from "@/content/legal";
import { POLISH_ERROR_HTTP_STATUS, type PolishErrorCode } from "@/lib/polish/contract";
import { createServerAdminClient } from "@/server/supabase/admin-client";
import { createServerAuthClient } from "@/server/supabase/auth-client";

/** Error codes this module can produce (subset of the contract codes). */
export type PolishAuthErrorCode = Extract<
  PolishErrorCode,
  "UNAUTHORIZED" | "AI_TERMS_REQUIRED" | "INTERNAL_ERROR"
>;

export interface PolishAuthError {
  code: PolishAuthErrorCode;
  status: number;
  message: string;
}

export type PolishAuthOutcome =
  | { ok: true; userId: string }
  | { ok: false; error: PolishAuthError };

/**
 * Injectable dependencies. `verifyAccessToken` resolves a user access token
 * to a user id, or null for an invalid/expired token.
 * `hasAcceptedCurrentAiTerms` reports whether the given user has accepted the
 * current AI terms version. Both throw on infrastructure failure (mapped to
 * 500 INTERNAL_ERROR); the real wiring is provided by createPolishAuthDeps().
 */
export interface PolishAuthDeps {
  verifyAccessToken(token: string): Promise<string | null>;
  hasAcceptedCurrentAiTerms(userId: string): Promise<boolean>;
}

/** Case-insensitive scheme, exactly one token part; anything else is malformed. */
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function extractBearerToken(authorization: string | null): string | null {
  if (!authorization) {
    return null;
  }
  const match = BEARER_PATTERN.exec(authorization.trim());
  return match ? match[1] : null;
}

function failure(code: PolishAuthErrorCode, message: string): PolishAuthOutcome {
  return { ok: false, error: { code, status: POLISH_ERROR_HTTP_STATUS[code], message } };
}

/**
 * Verify only the Bearer token (login check, no AI-terms gate). Routes that
 * must not require terms acceptance — e.g. GET /api/polish/quota — use this.
 */
export async function verifyBearerUser(
  authorization: string | null,
  deps: Pick<PolishAuthDeps, "verifyAccessToken">,
): Promise<PolishAuthOutcome> {
  const token = extractBearerToken(authorization);
  if (!token) {
    return failure("UNAUTHORIZED", "Missing or malformed Authorization header.");
  }

  try {
    const userId = await deps.verifyAccessToken(token);
    if (!userId) {
      return failure("UNAUTHORIZED", "Invalid or expired access token.");
    }
    return { ok: true, userId };
  } catch {
    return failure("INTERNAL_ERROR", "Failed to verify the access token.");
  }
}

/**
 * Verify the Bearer token and require acceptance of the current AI terms.
 * Entry point for POST /api/polish.
 */
export async function requirePolishUser(
  authorization: string | null,
  deps: PolishAuthDeps,
): Promise<PolishAuthOutcome> {
  const outcome = await verifyBearerUser(authorization, deps);
  if (!outcome.ok) {
    return outcome;
  }

  let accepted: boolean;
  try {
    accepted = await deps.hasAcceptedCurrentAiTerms(outcome.userId);
  } catch {
    return failure("INTERNAL_ERROR", "Failed to check AI terms acceptance.");
  }
  if (!accepted) {
    return failure(
      "AI_TERMS_REQUIRED",
      "Acceptance of the current AI terms is required before polishing.",
    );
  }
  return outcome;
}

/**
 * Wire the real Supabase clients. The admin client runs under service_role,
 * which bypasses RLS, so the terms query filters explicitly by the verified
 * user id — never by a request-supplied id, and never via RPCs that rely on
 * `auth.uid()`.
 */
export function createPolishAuthDeps(): PolishAuthDeps {
  const authClient = createServerAuthClient();
  const adminClient = createServerAdminClient();

  return {
    async verifyAccessToken(token) {
      const { data, error } = await authClient.auth.getUser(token);
      if (error || !data.user) {
        return null;
      }
      return data.user.id;
    },

    async hasAcceptedCurrentAiTerms(userId) {
      const { data, error } = await adminClient
        .from("user_terms_acceptances")
        .select("version")
        .eq("user_id", userId)
        .eq("document_key", "ai_terms")
        .eq("version", AI_TERMS_VERSION)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data !== null;
    },
  };
}
