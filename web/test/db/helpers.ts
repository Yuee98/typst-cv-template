/**
 * Shared helpers for the real-DB integration suite (unit 1.4).
 *
 * The suite runs against a LOCAL Supabase instance only. Connection env is
 * injected by scripts/run-db-tests.mjs (SUPABASE_TEST_*); when it is missing
 * every suite skips itself via `describe.skipIf(!RUN_DB_TESTS)`.
 *
 * Test isolation model:
 *   - every test file creates its own auth users (random emails) and deletes
 *     them afterwards; FK ON DELETE CASCADE wipes their ledger/usage/terms
 *     rows;
 *   - ai_feature_config is a singleton shared across files, so every file
 *     sets what it needs in beforeEach and restores FEATURE_CONFIG_DEFAULTS
 *     in afterAll;
 *   - global daily counters are never user-scoped, so tests assert RELATIVE
 *     deltas against a baseline read instead of absolute values.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  PolishQuotaError,
  reservePolishRequest,
} from "@/server/polish/quota";

export interface DbTestEnv {
  url: string;
  publishableKey: string;
  secretKey: string;
}

export function getDbTestEnv(): DbTestEnv | null {
  const url = process.env.SUPABASE_TEST_URL?.trim();
  const publishableKey = process.env.SUPABASE_TEST_PUBLISHABLE_KEY?.trim();
  const secretKey = process.env.SUPABASE_TEST_SECRET_KEY?.trim();
  if (!url || !publishableKey || !secretKey) {
    return null;
  }
  return { url, publishableKey, secretKey };
}

export const DB_TEST_ENV = getDbTestEnv();
export const RUN_DB_TESTS = DB_TEST_ENV !== null;

const NO_SESSION_AUTH = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false,
} as const;

function requireEnv(): DbTestEnv {
  if (!DB_TEST_ENV) {
    throw new Error(
      "SUPABASE_TEST_* env is missing; run via `pnpm --filter web test:db`.",
    );
  }
  return DB_TEST_ENV;
}

/** service_role client: bypasses RLS, used for setup/assertions and RPCs. */
export function createServiceClient(): SupabaseClient {
  const env = requireEnv();
  return createClient(env.url, env.secretKey, { auth: NO_SESSION_AUTH });
}

/** anon client: no session; used for grant-denial probes and sign-in. */
export function createAnonClient(): SupabaseClient {
  const env = requireEnv();
  return createClient(env.url, env.publishableKey, { auth: NO_SESSION_AUTH });
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function createTestUser(
  service: SupabaseClient,
  label: string,
): Promise<TestUser> {
  const email = `dbtest-${label}-${crypto.randomUUID()}@example.com`;
  const password = `DbTest!${crypto.randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createTestUser(${label}) failed: ${error?.message}`);
  }
  return { id: data.user.id, email, password };
}

export async function deleteTestUser(
  service: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await service.auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(`deleteTestUser failed: ${error.message}`);
  }
}

/** Records the exact AI legal bundle accepted by an AI-path DB fixture. */
export async function acceptAiLegalBundle(
  service: SupabaseClient,
  userId: string,
  legalBundleVersion: string,
): Promise<void> {
  const { error } = await service.from("user_terms_acceptances").upsert(
    {
      user_id: userId,
      document_key: "ai_terms",
      version: legalBundleVersion,
    },
    {
      onConflict: "user_id,document_key,version",
      ignoreDuplicates: true,
    },
  );
  if (error) {
    throw new Error(`acceptAiLegalBundle failed: ${error.message}`);
  }
}

/** Returns a client whose PostgREST/RPC calls run as this user (authenticated role). */
export async function signInAsUser(user: TestUser): Promise<SupabaseClient> {
  const client = createAnonClient();
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) {
    throw new Error(`signInAsUser failed: ${error.message}`);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Time helpers (the local DB shares this machine's clock)
// ---------------------------------------------------------------------------

/** UTC calendar day, matching `(now() at time zone 'utc')::date` in the RPCs. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function utcDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Truncated minute instant, matching `date_trunc('minute', now())`. */
export function currentMinuteBucket(): string {
  const bucket = new Date();
  bucket.setSeconds(0, 0);
  return bucket.toISOString();
}

export function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the wall clock is at least `marginMs` away from a minute
 * boundary. Tests that pin the current per-minute rate bucket use this so a
 * bucket rollover mid-assertion cannot flake them.
 */
export async function settleAwayFromMinuteBoundary(
  marginMs = 1_500,
): Promise<void> {
  const msIntoMinute = Date.now() % 60_000;
  if (msIntoMinute < marginMs) {
    await sleep(marginMs - msIntoMinute);
  } else if (msIntoMinute > 60_000 - marginMs) {
    await sleep(60_000 - msIntoMinute + marginMs);
  }
}

// ---------------------------------------------------------------------------
// Feature config (singleton runtime switch)
// ---------------------------------------------------------------------------

export interface FeatureConfigOverrides {
  enabled?: boolean;
  globalDailyLimit?: number;
  allowlist?: string[];
}

/** Post-migration defaults; restored by every file that mutates the switch. */
export const FEATURE_CONFIG_DEFAULTS = {
  enabled: false,
  globalDailyLimit: 2000,
  allowlist: [],
} as const satisfies FeatureConfigOverrides;

export async function configureFeature(
  service: SupabaseClient,
  overrides: FeatureConfigOverrides,
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (overrides.enabled !== undefined) {
    row.ai_polish_enabled = overrides.enabled;
  }
  if (overrides.globalDailyLimit !== undefined) {
    row.global_daily_limit = overrides.globalDailyLimit;
  }
  if (overrides.allowlist !== undefined) {
    row.enabled_user_allowlist = overrides.allowlist;
  }
  const { error } = await service
    .from("ai_feature_config")
    .update(row)
    .eq("id", true);
  if (error) {
    throw new Error(`configureFeature failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Row readers for assertions
// ---------------------------------------------------------------------------

export async function getUsageRow(service: SupabaseClient, userId: string) {
  const { data, error } = await service
    .from("ai_usage_daily")
    .select("*")
    .eq("user_id", userId)
    .eq("day", utcToday())
    .maybeSingle();
  if (error) {
    throw new Error(`getUsageRow failed: ${error.message}`);
  }
  return data;
}

export async function getGlobalUsageRow(service: SupabaseClient) {
  const { data, error } = await service
    .from("ai_global_usage_daily")
    .select("*")
    .eq("day", utcToday())
    .maybeSingle();
  if (error) {
    throw new Error(`getGlobalUsageRow failed: ${error.message}`);
  }
  return data;
}

export async function getGlobalStartedCount(
  service: SupabaseClient,
): Promise<number> {
  const row = await getGlobalUsageRow(service);
  return row?.provider_started_count ?? 0;
}

export async function getRateBuckets(service: SupabaseClient, userId: string) {
  const { data, error } = await service
    .from("ai_rate_minutes")
    .select("*")
    .eq("user_id", userId);
  if (error) {
    throw new Error(`getRateBuckets failed: ${error.message}`);
  }
  return data;
}

export async function getLedgerRows(service: SupabaseClient, userId: string) {
  const { data, error } = await service
    .from("ai_request_ledger")
    .select("*")
    .eq("user_id", userId);
  if (error) {
    throw new Error(`getLedgerRows failed: ${error.message}`);
  }
  return data;
}

export async function getLedgerRow(
  service: SupabaseClient,
  reservationId: string,
) {
  const { data, error } = await service
    .from("ai_request_ledger")
    .select("*")
    .eq("reservation_id", reservationId)
    .maybeSingle();
  if (error) {
    throw new Error(`getLedgerRow failed: ${error.message}`);
  }
  return data;
}

/** Removes the current minute's rate bucket so a burst starts from zero. */
export async function clearCurrentRateBucket(
  service: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await service
    .from("ai_rate_minutes")
    .delete()
    .eq("user_id", userId)
    .eq("minute_bucket", currentMinuteBucket());
  if (error) {
    throw new Error(`clearCurrentRateBucket failed: ${error.message}`);
  }
}

export async function setDailyUsageCount(
  service: SupabaseClient,
  userId: string,
  count: number,
): Promise<void> {
  const { error } = await service
    .from("ai_usage_daily")
    .upsert({ user_id: userId, day: utcToday(), request_count: count });
  if (error) {
    throw new Error(`setDailyUsageCount failed: ${error.message}`);
  }
}

export async function setGlobalStartedCount(
  service: SupabaseClient,
  count: number,
): Promise<void> {
  const { error } = await service
    .from("ai_global_usage_daily")
    .upsert({ day: utcToday(), provider_started_count: count });
  if (error) {
    throw new Error(`setGlobalStartedCount failed: ${error.message}`);
  }
}

export async function setCurrentRateBucketCount(
  service: SupabaseClient,
  userId: string,
  count: number,
): Promise<void> {
  const { error } = await service
    .from("ai_rate_minutes")
    .upsert({
      user_id: userId,
      minute_bucket: currentMinuteBucket(),
      count,
    });
  if (error) {
    throw new Error(`setCurrentRateBucketCount failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// reserve through the real TS wrapper (src/server/polish/quota.ts)
// ---------------------------------------------------------------------------

export type ReserveOutcome =
  | { ok: true; reservationId: string; remaining: number }
  | { ok: false; error: PolishQuotaError };

/** reserve with fresh random ids; denial codes are returned, not thrown. */
export async function tryReserve(
  service: SupabaseClient,
  userId: string,
  clientRequestId?: string,
): Promise<ReserveOutcome> {
  try {
    const reservation = await reservePolishRequest(service, {
      userId,
      requestId: crypto.randomUUID(),
      clientRequestId: clientRequestId ?? crypto.randomUUID(),
    });
    return {
      ok: true,
      reservationId: reservation.reservationId,
      remaining: reservation.remaining,
    };
  } catch (error) {
    if (error instanceof PolishQuotaError) {
      return { ok: false, error };
    }
    throw error;
  }
}
