import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseProviderBindingManifest,
  type ProviderBindingManifest,
} from "./provider-binding-v2";

const codeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/u);
const buildId = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,199}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const uuid = z.string().uuid();

export const runtimeDeploymentValidationSchema = z.strictObject({
  schemaVersion: z.literal("runtime_deployment_validation_v1"),
  reportId: uuid,
  reviewedDeploymentId: uuid,
  environment: z.enum(["local", "preview", "production"]),
  projectRef: z.string().min(1).max(100),
  runtimeBuildId: buildId,
  bindingManifestRevision: codeId,
  bindingManifestSha256: sha256,
  runtimeContractId: codeId,
  runtimeTargetId: codeId,
  runtimeTargetSha256: sha256,
  profileVersionId: uuid,
  priceVersionId: uuid,
  providerId: uuid,
  codeCapabilityId: codeId,
  codeCapabilitySha256: sha256,
  legalBundleVersion: codeId,
  legalManifestId: codeId,
  displayDisclosureKey: codeId,
  checkedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  reportSha256: sha256,
}).superRefine((value, context) => {
  const checkedAt = Date.parse(value.checkedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= checkedAt || expiresAt - checkedAt > 10 * 60_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "invalid deployment validation window",
    });
  }
});
export type RuntimeDeploymentValidationV1 = z.infer<
  typeof runtimeDeploymentValidationSchema
>;

export const runtimeDeploymentAdmissionSchema = z.strictObject({
  schemaVersion: z.literal("runtime_deployment_admission_v1"),
  environment: z.enum(["local", "preview", "production"]),
  projectRef: z.string().min(1).max(100),
  runtimeBuildId: buildId,
  bindingManifestRevision: codeId,
  bindingManifestSha256: sha256,
  admissionRevision: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  runtimeContractId: codeId,
  runtimeTargetId: codeId,
  runtimeTargetSha256: sha256,
  profileVersionId: uuid,
  priceVersionId: uuid,
  providerId: uuid,
  codeCapabilityId: codeId,
  codeCapabilitySha256: sha256,
  legalBundleVersion: codeId,
  legalManifestId: codeId,
  displayDisclosureKey: codeId,
});
export type RuntimeDeploymentAdmissionV1 = z.infer<typeof runtimeDeploymentAdmissionSchema>;

export const runtimeDeploymentAdmissionV2Schema = z.strictObject({
  schemaVersion: z.literal("runtime_deployment_admission_v2"),
  admissionId: uuid,
  reviewedDeploymentId: uuid,
  validationReportId: uuid,
  environment: z.enum(["local", "preview", "production"]),
  projectRef: z.string().min(1).max(100),
  runtimeBuildId: buildId,
  bindingManifestRevision: codeId,
  bindingManifestSha256: sha256,
  admissionRevision: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  targetSetSha256: sha256,
  runtimeContractId: codeId,
  runtimeTargetId: codeId,
  runtimeTargetSha256: sha256,
  profileVersionId: uuid,
  priceVersionId: uuid,
  providerId: uuid,
  codeCapabilityId: codeId,
  codeCapabilitySha256: sha256,
  legalBundleVersion: codeId,
  legalManifestId: codeId,
  displayDisclosureKey: codeId,
});
export type RuntimeDeploymentAdmissionV2 = z.infer<
  typeof runtimeDeploymentAdmissionV2Schema
>;

export interface RuntimeDeploymentEnvironment {
  readonly AI_RUNTIME_BUILD_ID?: string;
  readonly AI_PROVIDER_BINDING_MANIFEST?: string;
  readonly [key: string]: string | undefined;
}

export interface RuntimeDeploymentIdentityV1 {
  readonly buildId: string;
  readonly manifest: ProviderBindingManifest;
  readonly manifestSha256: string;
}

export const admittedRuntimeDeploymentSchema = z.strictObject({
  schemaVersion: z.literal("admin_admitted_runtime_deployment_v1"),
  reviewedDeploymentId: uuid,
  environment: z.enum(["local", "preview", "production"]),
  projectRef: z.string().min(1).max(100),
  runtimeBuildId: buildId,
  bindingManifestRevision: codeId,
  bindingManifestSha256: sha256,
  admissionRevision: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  admittedAt: z.string().datetime({ offset: true }),
  targets: z.array(z.strictObject({
    runtimeContractId: codeId,
    runtimeTargetId: codeId,
    runtimeTargetSha256: sha256,
    profileVersionId: uuid,
    priceVersionId: uuid,
    providerId: uuid,
    legalBundleVersion: codeId,
    legalManifestId: codeId,
    displayDisclosureKey: codeId,
    codeCapabilityId: codeId,
    codeCapabilitySha256: sha256,
  })).min(1).max(64),
});
export type AdmittedRuntimeDeploymentV1 = z.infer<typeof admittedRuntimeDeploymentSchema>;

export function isRuntimeDeploymentAdmittedV1(
  identity: RuntimeDeploymentIdentityV1,
  admitted: unknown,
  expected: { environment: string; projectRef: string },
): boolean {
  const parsed = runtimeDeploymentAdmissionSchema.safeParse(admitted);
  if (!parsed.success) return false;
  return parsed.data.environment === expected.environment &&
    parsed.data.projectRef === expected.projectRef &&
    parsed.data.runtimeBuildId === identity.buildId &&
    parsed.data.bindingManifestRevision === identity.manifest.revision &&
    parsed.data.bindingManifestSha256 === identity.manifestSha256;
}

export function canonicalProviderBindingManifest(
  manifest: ProviderBindingManifest,
): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    revision: manifest.revision,
    bindings: [...manifest.bindings]
      // Credential names are restricted ASCII. Compare code units directly so
      // the manifest digest does not depend on the host ICU locale.
      .sort((left, right) =>
        left.credentialEnvName === right.credentialEnvName
          ? 0
          : left.credentialEnvName < right.credentialEnvName
            ? -1
            : 1,
      )
      .map((binding) => ({
        credentialEnvName: binding.credentialEnvName,
        providerId: binding.providerId,
        recipientKey: binding.recipientKey,
        origin: binding.origin,
      })),
  });
}

export function parseRuntimeDeploymentIdentityV1(
  env: RuntimeDeploymentEnvironment,
): RuntimeDeploymentIdentityV1 {
  const parsedBuildId = buildId.safeParse(env.AI_RUNTIME_BUILD_ID);
  if (!parsedBuildId.success || !env.AI_PROVIDER_BINDING_MANIFEST) {
    throw new Error("Runtime deployment identity is unavailable");
  }
  let value: unknown;
  try {
    value = JSON.parse(env.AI_PROVIDER_BINDING_MANIFEST);
  } catch {
    throw new Error("Runtime deployment identity is unavailable");
  }
  const manifest = parseProviderBindingManifest(value);
  return Object.freeze({
    buildId: parsedBuildId.data,
    manifest,
    manifestSha256: createHash("sha256")
      .update(canonicalProviderBindingManifest(manifest), "utf8")
      .digest("hex"),
  });
}
