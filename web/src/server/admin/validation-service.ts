import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { adminValidationReportSchema, externalIdSchema, type AdminValidationReport } from "@/lib/admin/contract";
import { providerProfileSchema, validateProviderConfiguration } from "../ai/provider";
import { createServerAdminClient } from "../supabase/admin-client";
import { resolveAdminEnvironment } from "./environment";
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const inputSchema = z.strictObject({
  target_kind: z.enum(["PROFILE", "PRICE", "POLICY"]),
  target_id: externalIdSchema,
  database_instance_id: z.string().uuid()
});
export type ValidationProducerInput = z.infer<typeof inputSchema>;
export type ProducerClient = Pick<SupabaseClient<Database>, "rpc">;
export const adminValidationCandidateSchema = z.object({
  target_kind: z.enum(["PROFILE", "PRICE", "POLICY"]),
  target_id: externalIdSchema,
  passed: z.boolean(),
  reasons: z.array(z.string()).max(64),
  dependency_digest: digest,
  database_instance_id: z.string().uuid(),
  environment: z.enum(["LOCAL", "PREVIEW", "PRODUCTION"]),
  data: z.object({
    profiles: z.array(z.record(z.string(), z.unknown())).min(1).max(128)
  })
});
export function observedConfigChecks(profiles: readonly Record<string, unknown>[], environment: Readonly<Record<string, string | undefined>>): string[] {
  const reasons: string[] = [];
  for (const record of profiles) {
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(providerProfileSchema.shape)) fields[key] = record[key];
    try {
      validateProviderConfiguration(providerProfileSchema.parse(fields), environment);
    } catch {
      reasons.push("PROVIDER_CONFIGURATION_INVALID");
    }
  }
  return [...new Set(reasons)];
}
export async function produceAdminValidationReport(input: ValidationProducerInput, dependencies: {
  environment?: Readonly<Record<string, string | undefined>>;
  client?: ProducerClient;
} = {}): Promise<AdminValidationReport> {
  const request = inputSchema.parse(input);
  const env = dependencies.environment ?? process.env;
  const identity = resolveAdminEnvironment(env);
  const client: ProducerClient = dependencies.client ?? createServerAdminClient();
  const result = await client.rpc("config_validation_candidate", {
    p_input: {
      ...request,
      contract_code: "cv_app_db_1"
    }
  });
  if (result.error) throw new Error("Validation unavailable");
  const candidate = adminValidationCandidateSchema.parse(result.data);
  if (candidate.database_instance_id !== request.database_instance_id || candidate.environment.toLowerCase() !== identity.name || candidate.target_id !== request.target_id || candidate.target_kind !== request.target_kind) throw new Error("Validation identity mismatch");
  const reasons = observedConfigChecks(candidate.data.profiles, env);
  const saved = await client.rpc("config_validation_record", {
    p_input: {
      ...request,
      contract_code: "cv_app_db_1",
      dependency_digest: candidate.dependency_digest,
      passed: reasons.length === 0,
      reasons
    }
  });
  if (saved.error) throw new Error("Validation unavailable");
  const report = adminValidationReportSchema.parse(saved.data);
  if (report.target_id !== request.target_id || report.target_kind !== request.target_kind || report.dependency_digest !== candidate.dependency_digest || report.passed !== (reasons.length === 0 && candidate.passed) || Date.parse(report.time_expires) <= Date.now() || Date.parse(report.time_expires) - Date.parse(report.time_checked) > 600000) throw new Error("Validation receipt mismatch");
  return report;
}
