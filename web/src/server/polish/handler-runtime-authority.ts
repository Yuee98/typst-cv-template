import {
  createCodeOwnedPolishAdapterResolverV2,
  type PolishAdapterResolverV2,
} from "./lifecycle-v2";
import { type RuntimeTargetResolverV1 } from "./lifecycle-v2-contract";
import {
  createProviderSecretResolver,
  prepareProviderTransportV2,
  validateProviderCredentialBinding,
  validateProviderEndpoint,
} from "./provider-binding-v2";
import { createPreparedProviderExecutionV2 } from "./prepared-provider-execution-v2";
import { validateProfileExecutionConfigV2 } from "./profile-execution-v2";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V2,
  type RuntimeExecutionTargetV2,
  type RuntimeTargetResolverV2,
} from "./execution-snapshot-v2";
import { resolveAdminEnvironment } from "../admin/environment";
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

function matchesRuntimeConfigReceipt(
  target: RuntimeExecutionTargetV2,
  environment: ReturnType<typeof resolveAdminEnvironment>,
): boolean {
  const receipt = target.runtimeConfigReceipt;
  return (
    receipt.environment === environment.name &&
    receipt.projectRef === environment.projectRef &&
    receipt.runtimeContractId === target.runtimeContractId &&
    receipt.runtimeTargetId === target.evidence.runtimeTargetId &&
    receipt.runtimeTargetSha256 === target.evidence.runtimeTargetSha256 &&
    receipt.profileVersionId === target.profileVersionId &&
    receipt.priceVersionId === target.evidence.priceVersionId &&
    receipt.providerId === target.profile.providerId &&
    receipt.codeCapabilityId === target.evidence.codeCapabilityId &&
    receipt.codeCapabilitySha256 === target.evidence.codeCapabilitySha256 &&
    receipt.legalBundleVersion === target.legalBundleVersion &&
    receipt.legalManifestId === target.evidence.legalManifestId &&
    receipt.displayDisclosureKey === target.evidence.displayDisclosureKey
  );
}

/**
 * Admission is based on the immutable database receipt plus the code-owned
 * adapter/recipient/credential policy. There is no deployment-wide identity
 * or short-lived validation report in the request path.
 */
export function createReportedRuntimeTargetResolverV2(
  env: ServerEnvironment,
): RuntimeTargetResolverV2 {
  let environment: ReturnType<typeof resolveAdminEnvironment>;
  try {
    environment = resolveAdminEnvironment(env);
  } catch {
    return EMPTY_RUNTIME_TARGET_RESOLVER_V2;
  }
  const resolveSecret = createProviderSecretResolver(env);
  return (target: RuntimeExecutionTargetV2): boolean => {
    try {
      validateProviderEndpoint(target.profile);
      validateProviderCredentialBinding(target.profile, {
        providerId: target.evidence.providerId,
        recipientKey: target.evidence.recipientKey,
      });
      resolveSecret(target.profile.credentialEnvName);
      return matchesRuntimeConfigReceipt(target, environment);
    } catch {
      return false;
    }
  };
}

/**
 * Real Supabase composition after RT-009A. A deterministic provider is
 * authority only inside the separate two-flag fake-backend composition.
 */
export function createRealPolishRuntimeAuthorityV2(
  env: ServerEnvironment,
  options: { fetch?: typeof fetch } = {},
): RealPolishRuntimeAuthorityV2 {
  if (env.POLISH_FAKE_LLM === "true") {
    throw new Error(
      "POLISH_FAKE_LLM=true requires POLISH_FAKE_BACKEND=true for the V2 polish handler.",
    );
  }

  const resolveLegacyProvider = createCodeOwnedPolishAdapterResolverV2({ env });
  const resolveSecret = createProviderSecretResolver(env);
  const environment = (() => {
    try {
      return resolveAdminEnvironment(env);
    } catch {
      return undefined;
    }
  })();

  return Object.freeze({
    runtimeTargetResolver: REAL_POLISH_RUNTIME_TARGET_RESOLVER_V2,
    runtimeTargetResolverV2: createReportedRuntimeTargetResolverV2(env),
    resolveProvider: ((profile, target) => {
      if (profile.schemaVersion === "profile_execution_config_v2") {
        if (
          target === undefined ||
          target.profile !== profile ||
          environment === undefined ||
          !matchesRuntimeConfigReceipt(target, environment)
        ) {
          throw new Error("v2 provider authority target is required");
        }
        const validatedProfile = validateProfileExecutionConfigV2(profile);
        const prepared = prepareProviderTransportV2({
          profile: validatedProfile,
          recipient: {
            providerId: target.evidence.providerId,
            recipientKey: target.evidence.recipientKey,
          },
          resolveSecret,
        });
        return createPreparedProviderExecutionV2(prepared, options.fetch);
      }
      return resolveLegacyProvider(profile, target);
    }) satisfies PolishAdapterResolverV2,
  });
}
