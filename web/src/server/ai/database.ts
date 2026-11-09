import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { databaseError } from "./errors";
export const SERVICE_RPCS = ["ai_availability", "ai_quota", "ai_reserve", "ai_execution_snapshot", "ai_attempt_start", "ai_attempt_complete", "ai_cancel", "ai_finalize"] as const;
export type ServiceRpc = (typeof SERVICE_RPCS)[number];
export interface AiDatabase {
  call(name: ServiceRpc, input: Record<string, unknown>): Promise<unknown>;
  context(): Promise<{
    ready: boolean;
    contract_code: "cv_app_db_2";
    database_instance_id: string | null;
    environment: string | null;
    capabilities: { cv_schema_version: 7; encrypted_envelope_version: 1 };
  }>;
}
const contextSchema = z.strictObject({
  ready: z.boolean(),
  contract_code: z.literal("cv_app_db_2"),
  database_instance_id: z.uuid().nullable(),
  environment: z.string().nullable(),
  capabilities: z.strictObject({ cv_schema_version: z.literal(7), encrypted_envelope_version: z.literal(1) })
});
export function createAiDatabase(client: SupabaseClient): AiDatabase {
  return {
    async context() {
      const {
        data,
        error
      } = await client.rpc("app_context");
      if (error) throw databaseError(error);
      return contextSchema.parse(data);
    },
    async call(name, input) {
      const {
        data,
        error
      } = await client.rpc(name, {
        p_input: input
      });
      if (error) throw databaseError(error);
      return data;
    }
  };
}
