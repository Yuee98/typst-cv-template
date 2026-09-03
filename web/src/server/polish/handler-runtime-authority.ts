import {
  createCodeOwnedPolishAdapterResolverV2,
  type PolishAdapterResolverV2,
} from "./lifecycle-v2";
import {
  type RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";
import {
  createProviderSecretResolver,
  validateProviderEndpoint,
} from "./provider-binding-v2";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V2,
  type RuntimeExecutionTargetV2,
  type RuntimeTargetResolverV2,
} from "./execution-snapshot-v2";
import { resolveAdminEnvironment } from "../admin/environment";
import { parseRuntimeDeploymentIdentityV1 } from "./runtime-deployment-v1";
import {
  DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1,
  DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1,
} from "./service-runtime-contract-v1";

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export interface RealPolishRuntimeAuthorityV2 {
  readonly runtimeTargetResolver: RuntimeTargetResolverV1;
  readonly runtimeTargetResolverV2: RuntimeTargetResolverV2;
  readonly resolveProvider: PolishAdapterResolverV2;
}

const REAL_POLISH_RUNTIME_TARGET_RESOLVER_V2: RuntimeTargetResolverV1 =
  (target) =>
    DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(target) ||
    DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1(target);

export function createReportedRuntimeTargetResolverV2(
  env: ServerEnvironment,
): RuntimeTargetResolverV2 {
  let deployment: ReturnType<typeof parseRuntimeDeploymentIdentityV1>;
  let environment: ReturnType<typeof resolveAdminEnvironment>;
  try {
    deployment = parseRuntimeDeploymentIdentityV1(env);
    environment = resolveAdminEnvironment(env);
  } catch {
    return EMPTY_RUNTIME_TARGET_RESOLVER_V2;
  }
  const resolveSecret = createProviderSecretResolver(env);
  return (target: RuntimeExecutionTargetV2): boolean => {
    try {
      const report = target.deploymentValidation;
      const endpoint = validateProviderEndpoint(target.profile);
      const binding = deployment.manifest.bindings.find(
        (item) =>
          item.credentialEnvName === target.profile.credentialEnvName,
      );
      resolveSecret(target.profile.credentialEnvName);
      return (
        report.environment === environment.name &&
        report.projectRef === environment.projectRef &&
        report.runtimeBuildId === deployment.buildId &&
        report.bindingManifestRevision === deployment.manifest.revision &&
        report.bindingManifestSha256 === deployment.manifestSha256 &&
        report.runtimeContractId === target.runtimeContractId &&
        report.runtimeTargetId === target.evidence.runtimeTargetId &&
        report.runtimeTargetSha256 === target.evidence.runtimeTargetSha256 &&
        report.profileVersionId === target.profileVersionId &&
        report.priceVersionId === target.evidence.priceVersionId &&
        report.providerId === target.profile.providerId &&
        report.codeCapabilityId === target.evidence.codeCapabilityId &&
        report.codeCapabilitySha256 === target.evidence.codeCapabilitySha256 &&
        report.legalBundleVersion === target.legalBundleVersion &&
        report.legalManifestId === target.evidence.legalManifestId &&
        report.displayDisclosureKey === target.evidence.displayDisclosureKey &&
        (report.schemaVersion === "runtime_deployment_admission_v1" ||
          Date.parse(report.expiresAt) > Date.now()) &&
        binding?.providerId === target.profile.providerId &&
        binding.recipientKey === target.evidence.recipientKey &&
        binding.origin === new URL(endpoint).origin
      );
    } catch {
      return false;
    }
  };
}

/**
 * Real Supabase composition after RT-009A.
 *
 * A deterministic provider is authority only inside the separate two-flag
 * fake-backend composition. Mixing it into a real accounting backend would
 * let synthetic output settle under a DB-frozen provider route, so the legacy
 * single fake-LLM mode is deliberately unsupported for the public V2 handler.
 */
export function createRealPolishRuntimeAuthorityV2(
  env: ServerEnvironment,
): RealPolishRuntimeAuthorityV2 {
  if (env.POLISH_FAKE_LLM === "true") {
    throw new Error(
      "POLISH_FAKE_LLM=true requires POLISH_FAKE_BACKEND=true for the V2 polish handler.",
    );
  }

  return Object.freeze({
    // Preserve the legacy DeepSeek target for in-flight/rollback execution
    // while admitting only the exact current combined-v2 target pair.
    runtimeTargetResolver: REAL_POLISH_RUNTIME_TARGET_RESOLVER_V2,
    runtimeTargetResolverV2: createReportedRuntimeTargetResolverV2(env),
    resolveProvider: createCodeOwnedPolishAdapterResolverV2({ env }),
  });
}
