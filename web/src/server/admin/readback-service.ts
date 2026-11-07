import "server-only";
import { z } from "zod";
import { adminRuntimeReadbackSchema, externalIdSchema, type AdminRuntimeReadback } from "@/lib/admin/contract";
import { createServerAdminClient } from "../supabase/admin-client";
import { resolveAdminEnvironment } from "./environment";
import { observedConfigChecks, type ProducerClient } from "./validation-service";
export type RuntimeReadbackProducerInput = {
  database_instance_id: string;
};
const candidateSchema = z.object({
  database_instance_id: z.string().uuid(),
  environment: z.enum(["LOCAL", "PREVIEW", "PRODUCTION"]),
  dependency_digest: z.string().regex(/^[0-9a-f]{64}$/),
  target_id: externalIdSchema,
  passed: z.boolean(),
  reasons: z.array(z.string()).max(64),
  data: z.object({
    profiles: z.array(z.record(z.string(), z.unknown())).min(1).max(128)
  })
});
export async function produceAdminRuntimeReadback(input: RuntimeReadbackProducerInput, dependencies: {
  environment?: Readonly<Record<string, string | undefined>>;
  client?: ProducerClient;
} = {}): Promise<AdminRuntimeReadback> {
  const request = z.strictObject({
    database_instance_id: z.string().uuid()
  }).parse(input);
  const env = dependencies.environment ?? process.env;
  const identity = resolveAdminEnvironment(env);
  const client: ProducerClient = dependencies.client ?? createServerAdminClient();
  const result = await client.rpc("runtime_readback_candidate", {
    p_input: {
      ...request,
      contract_code: "cv_app_db_1"
    }
  });
  if (result.error) throw new Error("Readback unavailable");
  const candidate = candidateSchema.parse(result.data);
  if (candidate.database_instance_id !== request.database_instance_id || candidate.environment.toLowerCase() !== identity.name) throw new Error("Readback identity mismatch");
  const reasons = observedConfigChecks(candidate.data.profiles, env);
  const saved = await client.rpc("runtime_readback_record", {
    p_input: {
      ...request,
      contract_code: "cv_app_db_1",
      dependency_digest: candidate.dependency_digest,
      passed: reasons.length === 0,
      reasons
    }
  });
  if (saved.error) throw new Error("Readback unavailable");
  const report = adminRuntimeReadbackSchema.parse(saved.data);
  if (report.policy_version_id !== candidate.target_id || report.dependency_digest !== candidate.dependency_digest || report.passed !== (reasons.length === 0 && candidate.passed) || Date.parse(report.time_expires) <= Date.now() || Date.parse(report.time_expires) - Date.parse(report.time_checked) > 300000) throw new Error("Readback receipt mismatch");
  return report;
}
