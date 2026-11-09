import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { registerClient } from "./user-client";
let browserClient: SupabaseClient<Database> | null = null;
export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  return {
    configured: Boolean(url && publishableKey),
    publishableKey,
    url
  };
}
export function getSupabaseBrowserClient() {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return null;
  }
  browserClient ??= createClient<Database>(config.url, config.publishableKey, {
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        cache: "no-store"
      })
    },
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "implicit",
      persistSession: true
    }
  });
  registerClient(browserClient, config.url, config.publishableKey);
  return browserClient;
}
