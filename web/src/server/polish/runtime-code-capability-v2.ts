import { createHash } from "node:crypto";

const CODE_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/u;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

export interface RuntimeCodeCapabilityDescriptorV2 {
  readonly schemaVersion: "runtime_code_capability_v2";
  readonly codeCapabilityId: string;
  readonly gatewayKind: "direct_deepseek" | "direct_mimo";
  readonly adapterKind: "deepseek_chat_v1" | "mimo_responses_v1";
  readonly wireApiKind: "chat_completions_v1" | "responses_v1";
  readonly capabilityContractId:
    | "deepseek_chat_json_object_v1"
    | "mimo_responses_output_text_v1";
  readonly cachePolicyId:
    | "deepseek_automatic_context_cache_v1"
    | "mimo_automatic_prompt_cache_v1";
  readonly calculatorKind: "linear_token_v1";
  readonly implementationEvidenceIds: readonly string[];
  readonly descriptorSha256: string;
}

type UnhashedCapability = Omit<
  RuntimeCodeCapabilityDescriptorV2,
  "descriptorSha256"
>;

function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function runtimeCodeCapabilityPayloadV2(
  descriptor: UnhashedCapability,
): string {
  return [
    descriptor.schemaVersion,
    descriptor.codeCapabilityId,
    descriptor.gatewayKind,
    descriptor.adapterKind,
    descriptor.wireApiKind,
    descriptor.capabilityContractId,
    descriptor.cachePolicyId,
    descriptor.calculatorKind,
    ...descriptor.implementationEvidenceIds,
  ]
    .map(field)
    .join("\n");
}

export function runtimeCodeCapabilitySha256V2(
  descriptor: UnhashedCapability,
): string {
  return createHash("sha256")
    .update(runtimeCodeCapabilityPayloadV2(descriptor), "utf8")
    .digest("hex");
}

function defineCapability(
  descriptor: UnhashedCapability,
): Readonly<RuntimeCodeCapabilityDescriptorV2> {
  if (
    !CODE_ID.test(descriptor.codeCapabilityId) ||
    descriptor.implementationEvidenceIds.length === 0 ||
    new Set(descriptor.implementationEvidenceIds).size !==
      descriptor.implementationEvidenceIds.length ||
    descriptor.implementationEvidenceIds.some((id) => !CODE_ID.test(id))
  ) {
    throw new Error("invalid compiled runtime capability descriptor");
  }
  return Object.freeze({
    ...descriptor,
    implementationEvidenceIds: Object.freeze([
      ...descriptor.implementationEvidenceIds,
    ]),
    descriptorSha256: runtimeCodeCapabilitySha256V2(descriptor),
  });
}

export const COMPILED_RUNTIME_CODE_CAPABILITIES_V2 = Object.freeze([
  defineCapability({
    schemaVersion: "runtime_code_capability_v2",
    codeCapabilityId: "runtime-capability.deepseek-chat-v1.2026-09-04",
    gatewayKind: "direct_deepseek",
    adapterKind: "deepseek_chat_v1",
    wireApiKind: "chat_completions_v1",
    capabilityContractId: "deepseek_chat_json_object_v1",
    cachePolicyId: "deepseek_automatic_context_cache_v1",
    calculatorKind: "linear_token_v1",
    implementationEvidenceIds: [
      "implementation.deepseek-chat-v1.transport-and-parser.2026-09-04",
    ],
  }),
  defineCapability({
    schemaVersion: "runtime_code_capability_v2",
    codeCapabilityId: "runtime-capability.mimo-responses-v1.2026-09-04",
    gatewayKind: "direct_mimo",
    adapterKind: "mimo_responses_v1",
    wireApiKind: "responses_v1",
    capabilityContractId: "mimo_responses_output_text_v1",
    cachePolicyId: "mimo_automatic_prompt_cache_v1",
    calculatorKind: "linear_token_v1",
    implementationEvidenceIds: [
      "implementation.mimo-responses-v1.transport-and-parser.2026-09-04",
    ],
  }),
]);

export function resolveRuntimeCodeCapabilityV2(
  codeCapabilityId: string,
): Readonly<RuntimeCodeCapabilityDescriptorV2> {
  const capability = COMPILED_RUNTIME_CODE_CAPABILITIES_V2.find(
    (candidate) => candidate.codeCapabilityId === codeCapabilityId,
  );
  if (capability === undefined) {
    throw new Error("runtime code capability is not compiled into this build");
  }
  return capability;
}

export function resolveProfileRuntimeCodeCapabilityV2(
  profile: Readonly<{
    gatewayKind: string;
    adapterKind: string;
    wireApiKind: string;
    capabilityContractId: string;
    cachePolicyId: string;
    calculatorKind: string;
  }>,
): Readonly<RuntimeCodeCapabilityDescriptorV2> {
  const capability = COMPILED_RUNTIME_CODE_CAPABILITIES_V2.find(
    (candidate) =>
      candidate.gatewayKind === profile.gatewayKind &&
      candidate.adapterKind === profile.adapterKind &&
      candidate.wireApiKind === profile.wireApiKind &&
      candidate.capabilityContractId === profile.capabilityContractId &&
      candidate.cachePolicyId === profile.cachePolicyId &&
      candidate.calculatorKind === profile.calculatorKind,
  );
  if (
    capability === undefined ||
    !LOWER_HEX_64.test(capability.descriptorSha256)
  ) {
    throw new Error("profile semantics are not backed by a compiled capability");
  }
  return capability;
}
