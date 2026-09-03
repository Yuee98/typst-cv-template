import "server-only";

import { z } from "zod";
import {
  adminRuntimeReadbackSchema,
  type AdminRuntimeReadback,
} from "@/lib/admin/contract";
import {
  parseRuntimeDeploymentIdentityV1,
  type RuntimeDeploymentEnvironment,
} from "../polish/runtime-deployment-v1";
import { createServerAdminClient } from "../supabase/admin-client";

const inputSchema = z.strictObject({
  reviewedDeploymentId: z.string().uuid(),
  policyVersionId: z.string().uuid(),
  validationReportIds: z.array(z.string().uuid()).min(1).max(32).refine(
    (values) => new Set(values).size === values.length,
    "IDs must be unique",
  ),
});

export type RuntimeReadbackProducerInput = z.infer<typeof inputSchema>;

interface RpcClient {
  rpc(functionName: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export class RuntimeReadbackProducerError extends Error {
  constructor() {
    super("Runtime readback could not be produced");
    this.name = "RuntimeReadbackProducerError";
  }
}

export async function produceAdminRuntimeReadback(
  input: RuntimeReadbackProducerInput,
  dependencies: {
    environment?: RuntimeDeploymentEnvironment;
    client?: RpcClient;
  } = {},
): Promise<AdminRuntimeReadback> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new RuntimeReadbackProducerError();

  let runtime;
  try {
    runtime = parseRuntimeDeploymentIdentityV1(
      dependencies.environment ?? process.env,
    );
  } catch {
    throw new RuntimeReadbackProducerError();
  }

  const client = dependencies.client ?? createServerAdminClient();
  const result = await client.rpc("record_admin_runtime_readback_v1", {
    p_reviewed_deployment_id: parsed.data.reviewedDeploymentId,
    p_policy_version_id: parsed.data.policyVersionId,
    p_validation_report_ids: parsed.data.validationReportIds,
    p_observed_runtime_build_id: runtime.buildId,
    p_observed_binding_manifest_revision: runtime.manifest.revision,
    p_observed_binding_manifest_sha256: runtime.manifestSha256,
  });
  if (result.error) throw new RuntimeReadbackProducerError();

  const report = adminRuntimeReadbackSchema.safeParse(result.data);
  if (!report.success) throw new RuntimeReadbackProducerError();
  const expectedIds = [...parsed.data.validationReportIds].sort();
  const observedIds = [...report.data.validationReportIds].sort();
  if (
    report.data.reviewedDeploymentId !== parsed.data.reviewedDeploymentId ||
    report.data.policyVersionId !== parsed.data.policyVersionId ||
    report.data.runtimeBuildId !== runtime.buildId ||
    report.data.bindingManifestRevision !== runtime.manifest.revision ||
    report.data.bindingManifestSha256 !== runtime.manifestSha256 ||
    expectedIds.length !== observedIds.length ||
    expectedIds.some((id, index) => id !== observedIds[index]) ||
    Date.parse(report.data.checkedAt) > Date.now() + 30_000 ||
    Date.parse(report.data.expiresAt) <= Date.now()
  ) {
    throw new RuntimeReadbackProducerError();
  }
  return report.data;
}
