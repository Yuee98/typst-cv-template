/**
 * service_role Supabase client factory for the polish API server runtime.
 *
 * Used for terms lookups, quota accounting and metadata logging. The service
 * role bypasses RLS, so every query issued through this client MUST carry an
 * explicit filter on the verified user id — never trust an id supplied by the
 * request, and never call RPCs that rely on `auth.uid()` (NULL under
 * service_role). Session persistence, token auto-refresh and URL session
 * detection are all disabled.
 *
 * SERVER-ONLY: the service role key must never ship to the browser. Never
 * import this module from client code.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Fail loud on missing env: a silently unconfigured server is worse than a crash. */
function requireServerEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }
  return value;
}

export function createServerAdminClient(): SupabaseClient {
  return createClient(
    requireServerEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireServerEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );
}
