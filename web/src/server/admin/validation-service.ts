import "server-only";

import { z } from "zod";
import {
  adminValidationReportSchema,
  type AdminValidationReport,
} from "@/lib/admin/contract";
import {
  createProviderSecretResolver,
  validateProviderEndpoint,
  validateProviderCredentialBinding,
} from "../polish/provider-binding-v2";
import {
  resolveProfileRuntimeCodeCapabilityV2,
  resolveRuntimeCodeCapabilityV2,
} from "../polish/runtime-code-capability-v2";
import { validateProfileExecutionConfigV2 } from "../polish/profile-execution-v2";
import { resolveAdminEnvironment } from "./environment";
import { createServerAdminClient } from "../supabase/admin-client";

const codeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const uuid = z.string().uuid();

const candidateSchema = z.strictObject({
  schemaVersion: z.literal("admin_config_validation_candidate_v3"),
  environment: z.enum(["local", "preview", "production"]),
  profileExecutionConfig: z.strictObject({
    schemaVersion: z.literal("profile_execution_config_v2"),
    profileKey: codeId,
    providerId: uuid,
    gatewayKind: z.enum(["direct_deepseek", "direct_mimo"]),
    adapterKind: z.enum(["deepseek_chat_v1", "mimo_responses_v1"]),
    wireApiKind: z.enum(["chat_completions_v1", "responses_v1"]),
    endpointUrl: z.string().min(10).max(512),
    credentialEnvName: z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$/u),
    modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u),
    capabilityContractId: codeId,
    cachePolicyId: codeId,
    legalManifestId: codeId,
    calculatorKind: z.literal("linear_token_v1"),
    displayDisclosureKey: codeId,
    config: z.unknown(),
  }),
  runtimeTarget: z.strictObject({
    runtimeContractId: codeId,
    runtimeTargetId: codeId,
    runtimeTargetSha256: sha256,
    profileVersionId: uuid,
    priceVersionId: uuid,
    providerId: uuid,
    recipientKey: codeId,
    codeCapabilityId: codeId,
    codeCapabilitySha256: sha256,
    legalBundleVersion: codeId,
    legalManifestId: codeId,
    displayDisclosureKey: codeId,
  }),
});
export type AdminValidationCandidate = z.infer<typeof candidateSchema>;

export interface ValidationProducerInput {
  runtimeContractId: string;
  runtimeTargetId: string;
}

export type ValidationProducerEnvironment = Readonly<Record<string, string | undefined>>;

interface RpcClient {
  rpc(functionName: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export class ValidationProducerError extends Error {
  constructor(message = "Runtime validation could not be produced") {
    super(message);
    this.name = "ValidationProducerError";
  }
}

function parseInput(input: ValidationProducerInput): ValidationProducerInput {
  const parsed = z.strictObject({
    runtimeContractId: codeId,
    runtimeTargetId: codeId,
  }).safeParse(input);
  if (!parsed.success) throw new ValidationProducerError();
  return parsed.data;
}

export function observedConfigChecks(
  candidate: AdminValidationCandidate,
  env: ValidationProducerEnvironment,
): {
  endpointPolicy: boolean;
  credentialBinding: boolean;
  credentialConfigured: boolean;
  compiledCapability: boolean;
  observedCodeCapabilitySha256: string;
} {
  const profile = validateProfileExecutionConfigV2(candidate.profileExecutionConfig);
  const endpointPolicy = (() => {
    try {
      validateProviderEndpoint(profile);
      return true;
    } catch {
      return false;
    }
  })();
  let credentialBinding = false;
  try {
    validateProviderCredentialBinding(profile, {
      providerId: candidate.runtimeTarget.providerId,
      recipientKey: candidate.runtimeTarget.recipientKey,
    });
    credentialBinding = true;
  } catch { /* A failed policy check is recorded without exposing credentials. */ }
  let compiledCapability = false;
  let observedCodeCapabilitySha256 = "0".repeat(64);
  try {
    const compiled = resolveProfileRuntimeCodeCapabilityV2(profile);
    const targetCapability = resolveRuntimeCodeCapabilityV2(
      candidate.runtimeTarget.codeCapabilityId,
    );
    compiledCapability =
      compiled.codeCapabilityId === targetCapability.codeCapabilityId &&
      compiled.descriptorSha256 === candidate.runtimeTarget.codeCapabilitySha256;
    observedCodeCapabilitySha256 = compiled.descriptorSha256;
  } catch {
    compiledCapability = false;
  }
  // Do not construct the secret resolver until the candidate has passed every
  // non-secret compatibility check. A rejected target must not be able to
  // probe whether any provider key is configured.
  let credentialConfigured = false;
  if (endpointPolicy && credentialBinding && compiledCapability) {
    try {
      createProviderSecretResolver(env)(profile.credentialEnvName);
      credentialConfigured = true;
    } catch {
      credentialConfigured = false;
    }
  }
  return {
    endpointPolicy,
    credentialBinding,
    credentialConfigured,
    compiledCapability,
    observedCodeCapabilitySha256,
  };
}

export async function produceAdminValidationReport(
  input: ValidationProducerInput,
  dependencies: {
    environment?: ValidationProducerEnvironment;
    client?: RpcClient;
  } = {},
): Promise<AdminValidationReport> {
  const request = parseInput(input);
  const environment = dependencies.environment ?? process.env;
  const identity = resolveAdminEnvironment(environment);
  const client = dependencies.client ?? createServerAdminClient();
  const candidateResult = await client.rpc("get_admin_config_validation_candidate_v2", {
    p_runtime_contract_id: request.runtimeContractId,
    p_runtime_target_id: request.runtimeTargetId,
  });
  if (candidateResult.error) throw new ValidationProducerError();
  const candidate = candidateSchema.parse(candidateResult.data);
  if (
    candidate.environment !== identity.name ||
    candidate.runtimeTarget.runtimeContractId !== request.runtimeContractId ||
    candidate.runtimeTarget.runtimeTargetId !== request.runtimeTargetId
  ) {
    throw new ValidationProducerError();
  }
  let checks;
  try {
    checks = observedConfigChecks(candidate, environment);
  } catch {
    throw new ValidationProducerError();
  }
  const reportResult = await client.rpc("record_admin_config_validation_report_v2", {
    p_runtime_contract_id: request.runtimeContractId,
    p_runtime_target_id: request.runtimeTargetId,
    p_observed_code_capability_sha256: checks.observedCodeCapabilitySha256,
    p_endpoint_policy_valid: checks.endpointPolicy,
    p_credential_binding_valid: checks.credentialBinding,
    p_credential_configured: checks.credentialConfigured,
    p_compiled_capability_valid: checks.compiledCapability,
  });
  if (reportResult.error) throw new ValidationProducerError();
  const report = adminValidationReportSchema.parse(reportResult.data);
  const now = Date.now();
  if (
    Date.parse(report.checkedAt) > now + 30_000 ||
    Date.parse(report.expiresAt) <= now
  ) {
    throw new ValidationProducerError();
  }
  if (
    report.checks.endpointPolicy !== checks.endpointPolicy ||
    report.checks.credentialBinding !== checks.credentialBinding ||
    report.checks.credentialConfigured !== checks.credentialConfigured ||
    report.checks.compiledCapability !== checks.compiledCapability
  ) {
    throw new ValidationProducerError();
  }
  const expected = {
    environment: identity.name,
    runtimeContractId: candidate.runtimeTarget.runtimeContractId,
    runtimeTargetId: candidate.runtimeTarget.runtimeTargetId,
    runtimeTargetSha256: candidate.runtimeTarget.runtimeTargetSha256,
    profileVersionId: candidate.runtimeTarget.profileVersionId,
    priceVersionId: candidate.runtimeTarget.priceVersionId,
    providerId: candidate.runtimeTarget.providerId,
    codeCapabilityId: candidate.runtimeTarget.codeCapabilityId,
    codeCapabilitySha256: candidate.runtimeTarget.codeCapabilitySha256,
    legalBundleVersion: candidate.runtimeTarget.legalBundleVersion,
    legalManifestId: candidate.runtimeTarget.legalManifestId,
    displayDisclosureKey: candidate.runtimeTarget.displayDisclosureKey,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (report[key as keyof typeof expected] !== value) {
      throw new ValidationProducerError();
    }
  }
  return report;
}

export { candidateSchema as adminValidationCandidateSchema };
