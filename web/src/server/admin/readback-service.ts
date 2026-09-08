import "server-only";
import { z } from "zod";
import {
  adminRuntimeReadbackSchema,
  adminRuntimeReadbackRequestSchema,
  type AdminRuntimeReadback,
} from "@/lib/admin/contract";
import { createServerAdminClient } from "../supabase/admin-client";
import { resolveAdminEnvironment } from "./environment";
import { adminValidationCandidateSchema, observedConfigChecks } from "./validation-service";

const inputSchema = adminRuntimeReadbackRequestSchema.omit({ operation: true });
const candidateSchema = z.strictObject(adminRuntimeReadbackSchema.shape).omit({
  reportId: true, checkedAt: true, expiresAt: true, reportSha256: true,
}).extend({
  schemaVersion: z.literal("admin_runtime_readback_candidate_v3"),
  candidates: z.array(adminValidationCandidateSchema).min(1).max(32),
});
export type RuntimeReadbackProducerInput = z.infer<typeof inputSchema>;
interface RpcClient {
  rpc(functionName: string, args: Record<string, unknown>): Promise<{
    data: unknown; error: { code?: string; message?: string } | null;
  }>;
}
export class RuntimeReadbackProducerError extends Error {
  constructor() { super("Runtime readback could not be produced"); this.name = "RuntimeReadbackProducerError"; }
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((id, i) => id === sortedRight[i]);
}

export async function produceAdminRuntimeReadback(
  input: RuntimeReadbackProducerInput,
  dependencies: { environment?: Readonly<Record<string, string | undefined>>; client?: RpcClient } = {},
): Promise<AdminRuntimeReadback> {
  try {
    const request = inputSchema.parse(input);
    const env = dependencies.environment ?? process.env;
    const identity = resolveAdminEnvironment(env);
    const client = dependencies.client ?? createServerAdminClient();
    const args = {
      p_environment: identity.name, p_project_ref: identity.projectRef,
      p_policy_version_id: request.policyVersionId,
      p_validation_report_ids: request.validationReportIds,
    };
    const result = await client.rpc("get_admin_runtime_readback_candidate_v3", args);
    if (result.error) throw new RuntimeReadbackProducerError();
    const candidate = candidateSchema.parse(result.data);
    if (candidate.environment !== identity.name || candidate.projectRef !== identity.projectRef ||
      candidate.policyVersionId !== request.policyVersionId ||
      !sameIds(candidate.validationReportIds, request.validationReportIds) ||
      candidate.candidates.length !== candidate.effectiveRoutes.length) throw new RuntimeReadbackProducerError();

    // Re-observe this server's supported code and configured credentials for
    // every exact route. A DB report alone cannot prove the current process.
    const unmatched = [...candidate.effectiveRoutes];
    for (const config of candidate.candidates) {
      if (config.environment !== identity.name || config.projectRef !== identity.projectRef ||
        config.runtimeTarget.legalBundleVersion !== candidate.legalBundleVersion) throw new RuntimeReadbackProducerError();
      const index = unmatched.findIndex((route) => Object.entries(route).every(
        ([key, value]) => config.runtimeTarget[key as keyof typeof config.runtimeTarget] === value,
      ));
      if (index < 0) throw new RuntimeReadbackProducerError();
      unmatched.splice(index, 1);
      const checks = observedConfigChecks(config, env);
      if (!checks.endpointPolicy || !checks.credentialBinding || !checks.credentialConfigured || !checks.compiledCapability)
        throw new RuntimeReadbackProducerError();
    }
    const saved = await client.rpc("record_admin_runtime_readback_v3", {
      ...args,
      p_expected_closing_cycle_id: candidate.closingCycleId,
      p_expected_control_revision: candidate.controlRevision,
      p_expected_config_generation: candidate.configGeneration,
    });
    if (saved.error) throw new RuntimeReadbackProducerError();
    const report = adminRuntimeReadbackSchema.parse(saved.data);
    for (const key of ["environment", "projectRef", "closingCycleId", "controlRevision", "configGeneration", "policyVersionId", "legalBundleVersion"] as const) {
      if (report[key] !== candidate[key]) throw new RuntimeReadbackProducerError();
    }
    const routeKey = (route: typeof report.effectiveRoutes[number]) => JSON.stringify(Object.entries(route).sort(([a], [b]) => a.localeCompare(b)));
    if (!sameIds(report.validationReportIds, request.validationReportIds) ||
      !sameIds(report.effectiveRoutes.map(routeKey), candidate.effectiveRoutes.map(routeKey)) ||
      Date.parse(report.checkedAt) > Date.now() + 30_000 || Date.parse(report.expiresAt) <= Date.now())
      throw new RuntimeReadbackProducerError();
    return report;
  } catch { throw new RuntimeReadbackProducerError(); }
}
