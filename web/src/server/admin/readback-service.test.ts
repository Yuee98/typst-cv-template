import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  produceAdminRuntimeReadback,
  RuntimeReadbackProducerError,
} from "./readback-service";

const manifest = {
  schemaVersion: "ai_provider_bindings_v1" as const,
  revision: "binding-v1",
  bindings: [{
    credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK",
    providerId: "11111111-1111-4111-8111-111111111111",
    recipientKey: "deepseek",
    origin: "https://api.deepseek.com",
  }],
};
const environment = {
  AI_RUNTIME_BUILD_ID: "build-a",
  AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest),
};
const input = {
  reviewedDeploymentId: "22222222-2222-4222-8222-222222222222",
  policyVersionId: "33333333-3333-4333-8333-333333333333",
  validationReportIds: ["44444444-4444-4444-8444-444444444444"],
};
function report() {
  const checkedAt = new Date(Date.now() - 1_000);
  return {
    schemaVersion: "admin_runtime_readback_v1",
    reportId: "55555555-5555-4555-8555-555555555555",
    closingCycleId: "66666666-6666-4666-8666-666666666666",
    controlRevision: "7",
    configGeneration: "8",
    policyVersionId: input.policyVersionId,
    legalBundleVersion: "legal.bundle.v1",
    reviewedDeploymentId: input.reviewedDeploymentId,
    runtimeBuildId: environment.AI_RUNTIME_BUILD_ID,
    bindingManifestRevision: manifest.revision,
    bindingManifestSha256: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    validationReportIds: input.validationReportIds,
    effectiveRoutes: [{ runtimeTargetId: "target.deepseek.v1" }],
    checkedAt: checkedAt.toISOString(),
    expiresAt: new Date(checkedAt.getTime() + 9 * 60_000).toISOString(),
    reportSha256: "a".repeat(64),
  };
}

describe("trusted Admin runtime readback producer", () => {
  it("binds the service RPC to the observed build and manifest", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: report(), error: null });
    const result = await produceAdminRuntimeReadback(input, {
      environment,
      client: { rpc },
    });
    expect(result.reportId).toBe(report().reportId);
    expect(rpc).toHaveBeenCalledWith("record_admin_runtime_readback_v1", {
      p_reviewed_deployment_id: input.reviewedDeploymentId,
      p_policy_version_id: input.policyVersionId,
      p_validation_report_ids: input.validationReportIds,
      p_observed_runtime_build_id: environment.AI_RUNTIME_BUILD_ID,
      p_observed_binding_manifest_revision: manifest.revision,
      p_observed_binding_manifest_sha256: report().bindingManifestSha256,
    });
  });

  it.each([
    { name: "crossed deployment", patch: { reviewedDeploymentId: "77777777-7777-4777-8777-777777777777" } },
    { name: "crossed build", patch: { runtimeBuildId: "other-build" } },
    { name: "extra output", patch: { credential: "hidden-value" } },
    { name: "expired", patch: { expiresAt: new Date(Date.now() - 1_000).toISOString() } },
  ])("fails closed for $name", async ({ patch }) => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ...report(), ...patch },
      error: null,
    });
    await expect(
      produceAdminRuntimeReadback(input, { environment, client: { rpc } }),
    ).rejects.toBeInstanceOf(RuntimeReadbackProducerError);
  });

  it("does not call the service client for invalid input or runtime identity", async () => {
    const rpc = vi.fn();
    await expect(
      produceAdminRuntimeReadback(
        { ...input, validationReportIds: [] },
        { environment, client: { rpc } },
      ),
    ).rejects.toBeInstanceOf(RuntimeReadbackProducerError);
    await expect(
      produceAdminRuntimeReadback(input, {
        environment: { ...environment, AI_RUNTIME_BUILD_ID: undefined },
        client: { rpc },
      }),
    ).rejects.toBeInstanceOf(RuntimeReadbackProducerError);
    expect(rpc).not.toHaveBeenCalled();
  });
});
