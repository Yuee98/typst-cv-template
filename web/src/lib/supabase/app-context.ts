import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
export const DATABASE_CONTRACT = "cv_app_db_2" as const;
const contextSchema = z.object({
  ready: z.boolean(),
  contract_code: z.literal(DATABASE_CONTRACT),
  database_instance_id: z.uuid().nullable(),
  environment: z.string().nullable().optional()
});
export type AppContext = z.infer<typeof contextSchema> & {
  database_instance_id: string;
};
const contexts = new WeakMap<SupabaseClient, AppContext>();
let browserScope = "uninitialized";

/** Mutable context is always read from the DB; a mounted client never adopts a new instance. */
export async function requireAppContext(client: SupabaseClient): Promise<AppContext> {
  const {
    data,
    error
  } = await client.rpc("app_context");
  if (error) throw error;
  const parsed = contextSchema.safeParse(data);
  if (!parsed.success) throw new Error("CLIENT_UPDATE_REQUIRED: This database requires an application update.");
  if (!parsed.data.ready || !parsed.data.database_instance_id) throw new Error("NOT_READY: Database initialization is incomplete.");
  const current = parsed.data as AppContext;
  const previous = contexts.get(client);
  if (previous && previous.database_instance_id !== current.database_instance_id) {
    throw new Error("CLIENT_UPDATE_REQUIRED: Database instance changed. Reload before syncing.");
  }
  contexts.set(client, current);
  browserScope = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "local"}:${DATABASE_CONTRACT}:${current.database_instance_id}`;
  return current;
}
export function cloudCacheScope() {
  return browserScope;
}
export async function clientWriteContext(client: SupabaseClient, expectedUserId?: string) {
  const context = await requireAppContext(client);
  const {
    data,
    error
  } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user || expectedUserId && data.user.id !== expectedUserId) throw new Error("CONFLICT: ACCOUNT_CHANGED");
  return {
    expected_auth_user_id: data.user.id,
    contract_code: DATABASE_CONTRACT,
    database_instance_id: context.database_instance_id
  };
}
