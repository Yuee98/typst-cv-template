import { z } from "zod";
import { createHash } from "node:crypto";
import { createDeepSeekResponsesTransport } from "./deepseek";
import { createMimoResponsesTransport } from "./mimo";
import { createGeminiInteractionsTransport } from "./gemini";
import type { PolishInferenceRequest, PolishInferenceResult } from "./inference";
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const capabilitySchema = z.strictObject({
  code: z.enum(["DEEPSEEK_RESPONSES", "MIMO_RESPONSES", "GEMINI_INTERACTIONS"]),
  adapter_kind: z.enum(["deepseek_responses_v1", "mimo_responses_v1", "gemini_interactions_v1"]),
  wire_api_kind: z.enum(["responses_v1", "interactions_v1"]),
  execution_contract: z.literal("cv_polish_1"),
  calculator_kind: z.literal("linear_token_v1"),
  cache_policy: z.enum(["automatic", "none"]),
  descriptor_digest: digest
});
export const providerProfileSchema = z.strictObject({
  provider_code: z.enum(["DEEPSEEK", "MIMO", "GEMINI"]),
  capability: capabilitySchema,
  endpoint_url: z.string().url(),
  credential_ref: z.string().min(1),
  model_id: z.string().min(1).max(200),
  adapter_config: z.record(z.string(), z.unknown()),
  config_digest: digest
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export interface InferenceProvider {
  complete(request: PolishInferenceRequest, options: {
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<PolishInferenceResult>;
}
const rules = {
  DEEPSEEK: {
    code: "DEEPSEEK_RESPONSES",
    adapter: "deepseek_responses_v1",
    wire: "responses_v1",
    cache: "automatic",
    endpoint: "https://api.deepseek.com/responses",
    config: {
      reasoningEffort: "none",
      structuredOutput: "json_object",
      providerSubjectField: "user"
    }
  },
  MIMO: {
    code: "MIMO_RESPONSES",
    adapter: "mimo_responses_v1",
    wire: "responses_v1",
    cache: "none",
    endpoint: "https://api.xiaomimimo.com/v1/responses",
    config: {
      reasoningEffort: "none",
      structuredOutput: "prompt_only",
      sendProviderSubjectId: false
    }
  },
  GEMINI: {
    code: "GEMINI_INTERACTIONS",
    adapter: "gemini_interactions_v1",
    wire: "interactions_v1",
    cache: "automatic",
    endpoint: "https://generativelanguage.googleapis.com/v1/interactions",
    config: { thinkingLevel: "low", thinkingSummaries: "none", structuredOutput: "json_schema", sendProviderSubjectId: false, store: false, background: false }
  }
} as const;
/** PostgreSQL jsonb::text canonicalizes these flat ASCII descriptors by key length then byte order. */
function descriptorDigest(value: Record<string, string>): string {
  const text = `{${Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}}`;
  return createHash("sha256").update(text).digest("hex");
}
export const COMPILED_CAPABILITIES = Object.freeze(Object.fromEntries(Object.entries(rules).map(([provider, rule]) => {
  const descriptor = {
    code: rule.code,
    adapter_kind: rule.adapter,
    wire_api_kind: rule.wire,
    execution_contract: "cv_polish_1",
    calculator_kind: "linear_token_v1",
    cache_policy: rule.cache
  };
  return [provider, Object.freeze({
    ...descriptor,
    descriptor_digest: descriptorDigest(descriptor)
  })];
})) as Record<"DEEPSEEK" | "MIMO" | "GEMINI", Readonly<{
  code: string;
  adapter_kind: string;
  wire_api_kind: string;
  execution_contract: string;
  calculator_kind: string;
  cache_policy: string;
  descriptor_digest: string;
}>>);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}`;
  return JSON.stringify(value);
}
/** Exact code semantics; models and credential names remain database configuration. */
export function validateProviderConfiguration(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env): ProviderProfile {
  const profile = providerProfileSchema.parse(value);
  const rule = rules[profile.provider_code];
  const c = profile.capability;
  if (c.code !== rule.code || c.adapter_kind !== rule.adapter || c.wire_api_kind !== rule.wire || c.cache_policy !== rule.cache) throw new Error("Unsupported execution capability");
  if (c.descriptor_digest !== COMPILED_CAPABILITIES[profile.provider_code].descriptor_digest) throw new Error("Unsupported capability descriptor digest");
  // Exact URLs reject credentials, query strings, alternate ports, private IPs and redirects.
  if (profile.endpoint_url !== rule.endpoint) throw new Error("Unsupported provider endpoint");
  if (!new RegExp(`^AI_PROVIDER_KEY_${profile.provider_code}_[A-Z0-9_]+$`).test(profile.credential_ref)) throw new Error("Invalid credential reference");
  if (!env[profile.credential_ref]?.trim()) throw new Error("Selected credential unavailable");
  if (canonical(profile.adapter_config) !== canonical(rule.config)) throw new Error("Unsupported adapter parameters");
  return profile;
}
/** Secrets are captured only after a frozen database profile passes all safety checks. */
export function prepareProvider(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl: typeof fetch = fetch): InferenceProvider {
  const profile = validateProviderConfiguration(value, env);
  const options = {
    endpoint: profile.endpoint_url,
    apiKey: env[profile.credential_ref]!.trim(),
    modelId: profile.model_id,
    fetch: fetchImpl
  };
  const transports = {
    DEEPSEEK: () => createDeepSeekResponsesTransport(options),
    MIMO: () => createMimoResponsesTransport(options),
    GEMINI: () => createGeminiInteractionsTransport(options)
  };
  const transport = transports[profile.provider_code]();
  return Object.freeze({
    complete: transport.complete.bind(transport)
  });
}
export function configurationDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
