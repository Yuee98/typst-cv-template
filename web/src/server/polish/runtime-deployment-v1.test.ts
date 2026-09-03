import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  admittedRuntimeDeploymentSchema,
  isRuntimeDeploymentAdmittedV1,
  parseRuntimeDeploymentIdentityV1,
} from "./runtime-deployment-v1";

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
const canonical = JSON.stringify(manifest);
const identity = parseRuntimeDeploymentIdentityV1({
  AI_RUNTIME_BUILD_ID: "build-a",
  AI_PROVIDER_BINDING_MANIFEST: canonical,
});

const admitted = {
  schemaVersion: "runtime_deployment_admission_v1",
  environment: "local",
  projectRef: "local",
  runtimeBuildId: "build-a",
  bindingManifestRevision: "binding-v1",
  bindingManifestSha256: createHash("sha256").update(canonical).digest("hex"),
  admissionRevision: "1",
  runtimeContractId: "runtime.contract",
  runtimeTargetId: "runtime.target",
  runtimeTargetSha256: "c".repeat(64),
  profileVersionId: "22222222-2222-4222-8222-222222222222",
  priceVersionId: "33333333-3333-4333-8333-333333333333",
  providerId: "11111111-1111-4111-8111-111111111111",
  codeCapabilityId: "runtime.capability",
  codeCapabilitySha256: "a".repeat(64),
  legalBundleVersion: "legal.bundle",
  legalManifestId: "legal.manifest",
  displayDisclosureKey: "display.key",
};

describe("runtime deployment admission identity", () => {
  it("models one admitted deployment with multiple exact target identities", () => {
    const result = admittedRuntimeDeploymentSchema.safeParse({
      schemaVersion: "admin_admitted_runtime_deployment_v1",
      reviewedDeploymentId: "44444444-4444-4444-8444-444444444444",
      environment: "local",
      projectRef: "local",
      runtimeBuildId: "build-a",
      bindingManifestRevision: "binding-v1",
      bindingManifestSha256: "d".repeat(64),
      admissionRevision: "1",
      admittedAt: "2026-09-04T00:00:00.000Z",
      targets: [
        { runtimeContractId: "contract-a", runtimeTargetId: "target-a", runtimeTargetSha256: "a".repeat(64), profileVersionId: "22222222-2222-4222-8222-222222222222", priceVersionId: "33333333-3333-4333-8333-333333333333", providerId: "11111111-1111-4111-8111-111111111111", legalBundleVersion: "bundle-a", legalManifestId: "manifest-a", displayDisclosureKey: "display-a", codeCapabilityId: "cap-a", codeCapabilitySha256: "e".repeat(64) },
        { runtimeContractId: "contract-b", runtimeTargetId: "target-b", runtimeTargetSha256: "b".repeat(64), profileVersionId: "22222222-2222-4222-8222-222222222222", priceVersionId: "33333333-3333-4333-8333-333333333333", providerId: "11111111-1111-4111-8111-111111111111", legalBundleVersion: "bundle-b", legalManifestId: "manifest-b", displayDisclosureKey: "display-b", codeCapabilityId: "cap-b", codeCapabilitySha256: "f".repeat(64) },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts exact environment/build/revision/hash and rejects crossed values", () => {
    expect(isRuntimeDeploymentAdmittedV1(identity, admitted, { environment: "local", projectRef: "local" })).toBe(true);
    expect(isRuntimeDeploymentAdmittedV1(identity, { ...admitted, runtimeBuildId: "build-b" }, { environment: "local", projectRef: "local" })).toBe(false);
    expect(isRuntimeDeploymentAdmittedV1(identity, { ...admitted, bindingManifestSha256: "b".repeat(64) }, { environment: "local", projectRef: "local" })).toBe(false);
    expect(isRuntimeDeploymentAdmittedV1(identity, { ...admitted, bindingManifestRevision: "binding-v2" }, { environment: "local", projectRef: "local" })).toBe(false);
  });

  it("fails closed on unknown fields and crossed environment/project", () => {
    expect(isRuntimeDeploymentAdmittedV1(identity, { ...admitted, extra: true }, { environment: "local", projectRef: "local" })).toBe(false);
    expect(isRuntimeDeploymentAdmittedV1(identity, admitted, { environment: "production", projectRef: "local" })).toBe(false);
    expect(isRuntimeDeploymentAdmittedV1(identity, admitted, { environment: "local", projectRef: "other" })).toBe(false);
  });
});
