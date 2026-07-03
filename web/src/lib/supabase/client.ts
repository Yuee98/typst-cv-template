import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

  return {
    configured: Boolean(url && publishableKey),
    publishableKey,
    url,
  };
}

export function getSupabaseBrowserClient() {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return null;
  }

  browserClient ??= createClient(config.url, config.publishableKey);
  return browserClient;
}
