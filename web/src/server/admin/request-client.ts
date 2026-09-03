import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { AdminEnvironment } from "./environment";

/** Same verified bearer for RPC; never a service_role client or shared session. */
export function createAdminRequestClient(
  environment: AdminEnvironment,
  token: string,
) {
  return createClient(environment.supabaseUrl, environment.publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
