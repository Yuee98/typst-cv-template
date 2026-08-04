/**
 * Publishable-key Supabase client factory for the polish API server runtime.
 *
 * Used exclusively to verify a caller's access token via `auth.getUser(token)`
 * (roadmap「API 契约」session validation). Session persistence, token
 * auto-refresh and URL session detection are all disabled — the server holds
 * no user session state of its own.
 *
 * SERVER-ONLY: never import this module (or anything under src/server) from
 * client code; it must not end up in a browser bundle.
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

export function createServerAuthClient(): SupabaseClient {
  return createClient(
    requireServerEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireServerEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );
}
