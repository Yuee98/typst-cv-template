import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
type Connection = {
  url: string;
  publishableKey: string;
};
const connections = new WeakMap<SupabaseClient, Connection>();

/** Register explicit public connection coordinates; never infer or fall back to another project. */
export function registerClient(client: SupabaseClient, url: string, publishableKey: string): void {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["", "/"].includes(endpoint.pathname) || !publishableKey.trim()) {
    throw new Error("Invalid Supabase connection registration");
  }
  const existing = connections.get(client);
  if (existing && (existing.url !== endpoint.origin || existing.publishableKey !== publishableKey)) {
    throw new Error("Supabase connection registration cannot change");
  }
  connections.set(client, {
    url: endpoint.origin,
    publishableKey
  });
}

/**
 * Bind an operation to one verified account and access token. The original
 * browser client's session may change while this operation awaits a response;
 * every request from this client continues to use the captured bearer.
 */
export async function bindSupabaseUser(client: SupabaseClient, expectedUserId: string): Promise<SupabaseClient<Database>> {
  const connection = connections.get(client);
  if (!connection) throw new Error("Supabase client must have an explicit registered connection");
  if (!expectedUserId) throw new Error("UNAUTHORIZED: Expected account is required");
  const session = await client.auth.getSession();
  if (session.error) throw session.error;
  const token = session.data.session?.access_token;
  if (!token || session.data.session?.user.id !== expectedUserId) throw new Error("UNAUTHORIZED: Authenticated account changed");
  const verified = await client.auth.getUser(token);
  if (verified.error) throw verified.error;
  if (verified.data.user?.id !== expectedUserId) throw new Error("UNAUTHORIZED: Authenticated account changed");
  return createClient<Database>(connection.url, connection.publishableKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      },
      fetch: (input, init) => fetch(input, {
        ...init,
        cache: "no-store"
      })
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}
