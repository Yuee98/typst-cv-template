export const ADAPTER_KINDS = ["deepseek_chat_v1", "mimo_responses_v1"] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export const ENDPOINT_ALIASES = ["deepseek_official", "mimo_cn_official"] as const;
export type EndpointAlias = (typeof ENDPOINT_ALIASES)[number];

export const CREDENTIAL_ALIASES = ["deepseek_api_key", "mimo_api_key"] as const;
export type CredentialAlias = (typeof CREDENTIAL_ALIASES)[number];

export const CAPABILITY_CONTRACT_IDS = [
  "deepseek_chat_json_object_v1",
  "mimo_responses_output_text_v1",
] as const;
export type CapabilityContractId = (typeof CAPABILITY_CONTRACT_IDS)[number];

export const CACHE_POLICY_IDS = [
  "deepseek_automatic_context_cache_v1",
  "mimo_automatic_prompt_cache_v1",
] as const;
export type CachePolicyId = (typeof CACHE_POLICY_IDS)[number];

export const LEGAL_MANIFEST_IDS = [
  "deepseek-official-2026-08-23-v1",
  "mimo-cn-2026-08-23-v1",
] as const;
export type LegalManifestId = (typeof LEGAL_MANIFEST_IDS)[number];

export const CALCULATOR_KINDS = ["linear_token_v1", "openai_gpt56_v1"] as const;
export type CalculatorKind = (typeof CALCULATOR_KINDS)[number];

export const DISPLAY_DISCLOSURE_KEYS = ["deepseek-official-v1", "mimo-cn-v1"] as const;
export type DisplayDisclosureKey = (typeof DISPLAY_DISCLOSURE_KEYS)[number];

export type WireApiKind = "chat_completions_v1" | "responses_v1";
export type GatewayKind = "direct_deepseek" | "direct_mimo" | "openrouter";

export interface DeepSeekChatAdapterConfig {
  thinking: "disabled";
  structuredOutput: "json_object";
  providerSubjectField: "user_id";
}

export interface MimoResponsesAdapterConfig {
  reasoningEffort: "none";
  structuredOutput: "prompt_only";
  sendProviderSubjectId: false;
}

export type RegisteredAdapterConfig =
  | DeepSeekChatAdapterConfig
  | MimoResponsesAdapterConfig;

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

interface AdapterRegistration {
  readonly kind: AdapterKind;
  readonly wireApiKind: WireApiKind;
  readonly validateConfig: (value: unknown) => RegisteredAdapterConfig;
}

interface EndpointRegistration {
  readonly alias: EndpointAlias;
  readonly url: string;
}

interface CredentialRegistration {
  readonly alias: CredentialAlias;
  readonly envKey: "DEEPSEEK_API_KEY" | "MIMO_API_KEY";
}

interface CapabilityRegistration {
  readonly id: CapabilityContractId;
  readonly wireApiKind: WireApiKind;
  readonly nativeDeveloperRole: boolean;
  readonly outputMode: "json_object" | "prompt_only";
  readonly providerSubjectField: "user_id" | null;
}

interface CachePolicyRegistration {
  readonly id: CachePolicyId;
  readonly mode: "automatic";
  readonly cacheWriteReporting: "unavailable";
}

interface LegalManifestRegistration {
  readonly id: LegalManifestId;
  readonly providerName: "DeepSeek" | "MiMo";
}

interface CalculatorRegistration {
  readonly kind: CalculatorKind;
  readonly requiredComponents: readonly (
    | "input_standard"
    | "input_cache_read"
    | "input_cache_write"
    | "output"
  )[];
}

interface DisplayDisclosureRegistration {
  readonly key: DisplayDisclosureKey;
  readonly providerName: "DeepSeek" | "MiMo";
  readonly modelName: "DeepSeek V4 Flash" | "MiMo V2.5 Pro";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderRegistryError(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new ProviderRegistryError(
      `${label} keys mismatch (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"})`,
    );
  }
}

function validateDeepSeekConfig(value: unknown): DeepSeekChatAdapterConfig {
  assertRecord(value, "deepseek_chat_v1 config");
  assertExactKeys(
    value,
    ["thinking", "structuredOutput", "providerSubjectField"],
    "deepseek_chat_v1 config",
  );
  if (
    value.thinking !== "disabled" ||
    value.structuredOutput !== "json_object" ||
    value.providerSubjectField !== "user_id"
  ) {
    throw new ProviderRegistryError("deepseek_chat_v1 config contains an unsupported value");
  }
  return {
    thinking: "disabled",
    structuredOutput: "json_object",
    providerSubjectField: "user_id",
  };
}

function validateMimoConfig(value: unknown): MimoResponsesAdapterConfig {
  assertRecord(value, "mimo_responses_v1 config");
  assertExactKeys(
    value,
    ["reasoningEffort", "structuredOutput", "sendProviderSubjectId"],
    "mimo_responses_v1 config",
  );
  if (
    value.reasoningEffort !== "none" ||
    value.structuredOutput !== "prompt_only" ||
    value.sendProviderSubjectId !== false
  ) {
    throw new ProviderRegistryError("mimo_responses_v1 config contains an unsupported value");
  }
  return {
    reasoningEffort: "none",
    structuredOutput: "prompt_only",
    sendProviderSubjectId: false,
  };
}

const ADAPTER_REGISTRY: Record<AdapterKind, AdapterRegistration> = {
  deepseek_chat_v1: {
    kind: "deepseek_chat_v1",
    wireApiKind: "chat_completions_v1",
    validateConfig: validateDeepSeekConfig,
  },
  mimo_responses_v1: {
    kind: "mimo_responses_v1",
    wireApiKind: "responses_v1",
    validateConfig: validateMimoConfig,
  },
};

const ENDPOINT_REGISTRY: Record<EndpointAlias, EndpointRegistration> = {
  deepseek_official: {
    alias: "deepseek_official",
    url: "https://api.deepseek.com/chat/completions",
  },
  mimo_cn_official: {
    alias: "mimo_cn_official",
    url: "https://api.xiaomimimo.com/v1/responses",
  },
};

const CREDENTIAL_REGISTRY: Record<CredentialAlias, CredentialRegistration> = {
  deepseek_api_key: { alias: "deepseek_api_key", envKey: "DEEPSEEK_API_KEY" },
  mimo_api_key: { alias: "mimo_api_key", envKey: "MIMO_API_KEY" },
};

const CAPABILITY_REGISTRY: Record<CapabilityContractId, CapabilityRegistration> = {
  deepseek_chat_json_object_v1: {
    id: "deepseek_chat_json_object_v1",
    wireApiKind: "chat_completions_v1",
    nativeDeveloperRole: false,
    outputMode: "json_object",
    providerSubjectField: "user_id",
  },
  mimo_responses_output_text_v1: {
    id: "mimo_responses_output_text_v1",
    wireApiKind: "responses_v1",
    // The checked-at MiMo packet does not freeze a native developer-role
    // guarantee. Keep this conservative so the adapter cannot rely on it.
    nativeDeveloperRole: false,
    outputMode: "prompt_only",
    providerSubjectField: null,
  },
};

const CACHE_POLICY_REGISTRY: Record<CachePolicyId, CachePolicyRegistration> = {
  deepseek_automatic_context_cache_v1: {
    id: "deepseek_automatic_context_cache_v1",
    mode: "automatic",
    cacheWriteReporting: "unavailable",
  },
  mimo_automatic_prompt_cache_v1: {
    id: "mimo_automatic_prompt_cache_v1",
    mode: "automatic",
    cacheWriteReporting: "unavailable",
  },
};

const LEGAL_MANIFEST_REGISTRY: Record<LegalManifestId, LegalManifestRegistration> = {
  "deepseek-official-2026-08-23-v1": {
    id: "deepseek-official-2026-08-23-v1",
    providerName: "DeepSeek",
  },
  "mimo-cn-2026-08-23-v1": {
    id: "mimo-cn-2026-08-23-v1",
    providerName: "MiMo",
  },
};

const CALCULATOR_REGISTRY: Record<CalculatorKind, CalculatorRegistration> = {
  linear_token_v1: {
    kind: "linear_token_v1",
    requiredComponents: ["input_standard", "input_cache_read", "output"],
  },
  openai_gpt56_v1: {
    kind: "openai_gpt56_v1",
    requiredComponents: [
      "input_standard",
      "input_cache_read",
      "input_cache_write",
      "output",
    ],
  },
};

const DISPLAY_DISCLOSURE_REGISTRY: Record<
  DisplayDisclosureKey,
  DisplayDisclosureRegistration
> = {
  "deepseek-official-v1": {
    key: "deepseek-official-v1",
    providerName: "DeepSeek",
    modelName: "DeepSeek V4 Flash",
  },
  "mimo-cn-v1": {
    key: "mimo-cn-v1",
    providerName: "MiMo",
    modelName: "MiMo V2.5 Pro",
  },
};

// Resolvers intentionally return canonical registrations. Deep-freeze every
// registry and nested array so a caller cannot mutate that shared identity and
// poison later resolutions at runtime (TypeScript readonly is not sufficient).
for (const registry of [
  ADAPTER_REGISTRY,
  ENDPOINT_REGISTRY,
  CREDENTIAL_REGISTRY,
  CAPABILITY_REGISTRY,
  CACHE_POLICY_REGISTRY,
  LEGAL_MANIFEST_REGISTRY,
  CALCULATOR_REGISTRY,
  DISPLAY_DISCLOSURE_REGISTRY,
]) {
  deepFreeze(registry);
}

function resolveRegistered<T>(registry: Record<string, T>, id: string, label: string): T {
  const entry = registry[id];
  if (entry === undefined) {
    throw new ProviderRegistryError(`unknown ${label}: ${id}`);
  }
  return entry;
}

export function resolveAdapter(kind: string): AdapterRegistration {
  return resolveRegistered(ADAPTER_REGISTRY, kind, "adapter kind");
}

export function validateAdapterConfig(
  kind: string,
  config: unknown,
): RegisteredAdapterConfig {
  return resolveAdapter(kind).validateConfig(config);
}

export function resolveEndpoint(alias: string): EndpointRegistration {
  const endpoint = resolveRegistered(ENDPOINT_REGISTRY, alias, "endpoint alias");
  const parsed = new URL(endpoint.url);
  if (parsed.protocol !== "https:") {
    throw new ProviderRegistryError(`registered endpoint ${alias} is not HTTPS`);
  }
  return endpoint;
}

export function resolveCredential(alias: string): CredentialRegistration {
  return resolveRegistered(CREDENTIAL_REGISTRY, alias, "credential alias");
}

/** Resolve a secret only through a code-owned alias; DB values never become env names. */
export function resolveCredentialSecret(
  alias: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const registration = resolveCredential(alias);
  const value = env[registration.envKey];
  if (value === undefined || value.trim().length === 0) {
    throw new ProviderRegistryError(`registered credential ${alias} is unavailable`);
  }
  return value;
}

export function resolveCapability(id: string): CapabilityRegistration {
  return resolveRegistered(CAPABILITY_REGISTRY, id, "capability contract");
}

export function resolveCachePolicy(id: string): CachePolicyRegistration {
  return resolveRegistered(CACHE_POLICY_REGISTRY, id, "cache policy");
}

export function resolveLegalManifest(id: string): LegalManifestRegistration {
  return resolveRegistered(LEGAL_MANIFEST_REGISTRY, id, "legal manifest");
}

export function resolveCalculator(kind: string): CalculatorRegistration {
  return resolveRegistered(CALCULATOR_REGISTRY, kind, "calculator kind");
}

export function resolveDisplayDisclosure(key: string): DisplayDisclosureRegistration {
  return resolveRegistered(DISPLAY_DISCLOSURE_REGISTRY, key, "display disclosure");
}
