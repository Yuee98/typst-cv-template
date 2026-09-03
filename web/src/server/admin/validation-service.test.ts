import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  produceAdminValidationReport,
  type AdminValidationCandidate,
} from "./validation-service";
import { COMPILED_RUNTIME_CODE_CAPABILITIES_V2 } from "../polish/runtime-code-capability-v2";

const providerId = "11111111-1111-4111-8111-111111111111";
const profileVersionId = "22222222-2222-4222-8222-222222222222";
const priceVersionId = "33333333-3333-4333-8333-333333333333";
const deploymentId = "44444444-4444-4444-8444-444444444444";
const capability = COMPILED_RUNTIME_CODE_CAPABILITIES_V2[0];
const manifest = {
  schemaVersion: "ai_provider_bindings_v1" as const,
  revision: "manifest-2026-09-04",
  bindings: [{
    credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK",
    providerId,
    recipientKey: "deepseek",
    origin: "https://api.deepseek.com",
  }],
};
const manifestSha256 = createHash("sha256")
  .update(JSON.stringify(manifest), "utf8")
  .digest("hex");

const candidate: AdminValidationCandidate = {
  schemaVersion: "admin_validation_candidate_v1",
  deployment: {
    id: deploymentId,
    environment: "local",
    projectRef: "local",
    runtimeBuildId: "build-2026-09-04",
    bindingManifestRevision: manifest.revision,
    bindingManifestSha256: manifestSha256,
    validUntil: "2099-01-01T00:00:00.000Z",
  },
  profileExecutionConfig: {
    schemaVersion: "profile_execution_config_v2",
    profileKey: "profile.deepseek",
    providerId,
    gatewayKind: "direct_deepseek",
    adapterKind: "deepseek_chat_v1",
    wireApiKind: "chat_completions_v1",
    endpointUrl: "https://api.deepseek.com/chat/completions",
    credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK",
    modelId: "deepseek-chat",
    capabilityContractId: capability.capabilityContractId,
    cachePolicyId: capability.cachePolicyId,
    legalManifestId: "deepseek-official-2026-08-23-v1",
    calculatorKind: "linear_token_v1",
    displayDisclosureKey: "deepseek-official-v1",
    config: {
      thinking: "disabled",
      structuredOutput: "json_object",
      providerSubjectField: "user_id",
    },
  },
  runtimeTarget: {
    runtimeContractId: "runtime.deepseek-v2.v1",
    runtimeTargetId: "runtime-target.deepseek.v1",
    runtimeTargetSha256: "a".repeat(64),
    profileVersionId,
    priceVersionId,
    providerId,
    recipientKey: "deepseek",
    codeCapabilityId: capability.codeCapabilityId,
    codeCapabilitySha256: capability.descriptorSha256,
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    legalManifestId: "deepseek-official-2026-08-23-v1",
    displayDisclosureKey: "deepseek-official-v1",
  },
};

type CheckOverrides = Partial<{
  endpointPolicy: boolean;
  manifestBinding: boolean;
  credentialConfigured: boolean;
  compiledCapability: boolean;
  databaseBinding: boolean;
}>;

function report(checkOverrides: CheckOverrides = {}) {
  const checkedAt = new Date(Date.now() - 1_000);
  const expiresAt = new Date(checkedAt.getTime() + 9 * 60_000);
  return {
    schemaVersion: "admin_validation_report_v1",
    reportId: "55555555-5555-4555-8555-555555555555",
    reviewedDeploymentId: deploymentId,
    environment: "local",
    projectRef: "local",
    runtimeBuildId: candidate.deployment.runtimeBuildId,
    bindingManifestRevision: manifest.revision,
    bindingManifestSha256: manifestSha256,
    runtimeContractId: candidate.runtimeTarget.runtimeContractId,
    runtimeTargetId: candidate.runtimeTarget.runtimeTargetId,
    runtimeTargetSha256: candidate.runtimeTarget.runtimeTargetSha256,
    profileVersionId,
    priceVersionId,
    providerId,
    codeCapabilityId: capability.codeCapabilityId,
    codeCapabilitySha256: capability.descriptorSha256,
    legalBundleVersion: candidate.runtimeTarget.legalBundleVersion,
    legalManifestId: candidate.runtimeTarget.legalManifestId,
    displayDisclosureKey: candidate.runtimeTarget.displayDisclosureKey,
    checks: {
      endpointPolicy: true,
      manifestBinding: true,
      credentialConfigured: true,
      compiledCapability: true,
      databaseBinding: true,
      ...checkOverrides,
    },
    passed: Object.values({
      endpointPolicy: true,
      manifestBinding: true,
      credentialConfigured: true,
      compiledCapability: true,
      databaseBinding: true,
      ...checkOverrides,
    }).every(Boolean),
    evidenceIds: ["evidence.deployment"],
    checkedAt: checkedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reportSha256: "b".repeat(64),
  };
}

function setup(data: unknown = report()) {
  const rpc = vi.fn()
    .mockResolvedValueOnce({ data: candidate, error: null })
    .mockResolvedValueOnce({ data, error: null });
  return { rpc, client: { rpc } };
}

describe("produceAdminValidationReport", () => {
  it("loads the candidate, validates compiled runtime and records only narrow observations", async () => {
    const { rpc, client } = setup();
    const result = await produceAdminValidationReport({
      reviewedDeploymentId: deploymentId,
      runtimeContractId: candidate.runtimeTarget.runtimeContractId,
      runtimeTargetId: candidate.runtimeTarget.runtimeTargetId,
    }, {
      client,
      environment: {
        AI_RUNTIME_BUILD_ID: candidate.deployment.runtimeBuildId,
        AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest),
        AI_PROVIDER_KEY_DEEPSEEK: "secret-value",
      },
    });
    expect(result.schemaVersion).toBe("admin_validation_report_v1");
    expect(rpc).toHaveBeenNthCalledWith(1, "get_admin_validation_candidate_v1", expect.any(Object));
    const recorded = rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(recorded).not.toHaveProperty("p_secret");
    expect(JSON.stringify(recorded)).not.toContain("secret-value");
    expect(recorded).toMatchObject({
      p_observed_runtime_build_id: candidate.deployment.runtimeBuildId,
      p_observed_binding_manifest_sha256: manifestSha256,
      p_credential_configured: true,
    });
  });

  it.each([
    ["crossed build", { AI_RUNTIME_BUILD_ID: "other-build" }],
    ["crossed manifest revision", { AI_PROVIDER_BINDING_MANIFEST: JSON.stringify({ ...manifest, revision: "other-revision" }) }],
  ])("rejects %s before a crossed report can be accepted", async (_name, override) => {
    const { client } = setup();
    await expect(produceAdminValidationReport({ reviewedDeploymentId: deploymentId, runtimeContractId: candidate.runtimeTarget.runtimeContractId, runtimeTargetId: candidate.runtimeTarget.runtimeTargetId }, {
      client,
      environment: {
        AI_RUNTIME_BUILD_ID: candidate.deployment.runtimeBuildId,
        AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest),
        AI_PROVIDER_KEY_DEEPSEEK: "secret-value",
        ...override,
      },
    })).rejects.toThrow();
  });

  it("records a missing secret as a false narrow check without exposing credentials", async () => {
    const { rpc, client } = setup(report({ credentialConfigured: false }));
    await produceAdminValidationReport({ reviewedDeploymentId: deploymentId, runtimeContractId: candidate.runtimeTarget.runtimeContractId, runtimeTargetId: candidate.runtimeTarget.runtimeTargetId }, {
      client,
      environment: {
        AI_RUNTIME_BUILD_ID: candidate.deployment.runtimeBuildId,
        AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest),
        AI_PROVIDER_KEY_DEEPSEEK: undefined,
      },
    });
    const recorded = rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(recorded.p_credential_configured).toBe(false);
    expect(JSON.stringify(recorded)).not.toContain("secret-value");
  });

  it("fails closed on unknown candidate fields and unsupported capability", async () => {
    const unknown = setup({ ...report(), unexpected: "value" });
    await expect(produceAdminValidationReport({ reviewedDeploymentId: deploymentId, runtimeContractId: candidate.runtimeTarget.runtimeContractId, runtimeTargetId: candidate.runtimeTarget.runtimeTargetId }, {
      client: unknown.client,
      environment: { AI_RUNTIME_BUILD_ID: candidate.deployment.runtimeBuildId, AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest), AI_PROVIDER_KEY_DEEPSEEK: "secret-value" },
    })).rejects.toThrow();
    const unsupported = setup();
    const changed = { ...candidate, runtimeTarget: { ...candidate.runtimeTarget, codeCapabilityId: "runtime-capability.unknown" } };
    unsupported.rpc.mockReset().mockResolvedValueOnce({ data: changed, error: null }).mockResolvedValueOnce({ data: report(), error: null });
    await expect(produceAdminValidationReport({ reviewedDeploymentId: deploymentId, runtimeContractId: candidate.runtimeTarget.runtimeContractId, runtimeTargetId: candidate.runtimeTarget.runtimeTargetId }, {
      client: unsupported.client,
      environment: { AI_RUNTIME_BUILD_ID: candidate.deployment.runtimeBuildId, AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest), AI_PROVIDER_KEY_DEEPSEEK: "secret-value" },
    })).rejects.toThrow();
  });

  it("rejects expired deployment authority and future-dated reports", async () => {
    const expired = setup();
    expired.rpc.mockReset().mockResolvedValueOnce({
      data: {
        ...candidate,
        deployment: { ...candidate.deployment, validUntil: "2026-01-01T00:00:00.000Z" },
      },
      error: null,
    });
    await expect(produceAdminValidationReport({ reviewedDeploymentId: deploymentId, runtimeContractId: candidate.runtimeTarget.runtimeContractId, runtimeTargetId: candidate.runtimeTarget.runtimeTargetId }, {
      client: expired.client,
      environment: { AI_RUNTIME_BUILD_ID: candidate.deployment.runtimeBuildId, AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest), AI_PROVIDER_KEY_DEEPSEEK: "secret-value" },
    })).rejects.toThrow();

    const futureReport = report();
    const futureCheckedAt = new Date(Date.now() + 60_000);
    futureReport.checkedAt = futureCheckedAt.toISOString();
    futureReport.expiresAt = new Date(futureCheckedAt.getTime() + 9 * 60_000).toISOString();
    const future = setup(futureReport);
    await expect(produceAdminValidationReport({ reviewedDeploymentId: deploymentId, runtimeContractId: candidate.runtimeTarget.runtimeContractId, runtimeTargetId: candidate.runtimeTarget.runtimeTargetId }, {
      client: future.client,
      environment: { AI_RUNTIME_BUILD_ID: candidate.deployment.runtimeBuildId, AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest), AI_PROVIDER_KEY_DEEPSEEK: "secret-value" },
    })).rejects.toThrow();
  });
});
