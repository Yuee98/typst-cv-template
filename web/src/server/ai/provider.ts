import { z } from "zod";
import { createDeepSeekResponsesTransport } from "./deepseek";
import { createMimoResponsesTransport } from "./mimo";
import { createGeminiInteractionsTransport } from "./gemini";
import { createInferenceFetch, validateEndpoint } from "./outbound";
import type { PolishInferenceRequest, PolishInferenceResult } from "./inference";

/** IDs and contracts are code-owned protocol semantics, never supplier identity. */
export const ADAPTERS = Object.freeze({
  1: Object.freeze({ name: "DeepSeek Responses", executionContract: "deepseek_responses_v1", create: createDeepSeekResponsesTransport }),
  2: Object.freeze({ name: "MiMo Responses", executionContract: "mimo_responses_v1", create: createMimoResponsesTransport }),
  3: Object.freeze({ name: "Gemini Interactions", executionContract: "gemini_interactions_v1", create: createGeminiInteractionsTransport })
});
export const executionConfigurationSchema = z.strictObject({
  adapter_id: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  execution_contract: z.string().min(1),
  endpoint_url: z.string().min(1),
  credential_ref: z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]+$/),
  model_id: z.string().min(1).max(200)
});
export type ExecutionConfiguration = z.infer<typeof executionConfigurationSchema>;
export interface InferenceProvider {
  complete(request: PolishInferenceRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<PolishInferenceResult>;
}
export class MissingProviderCredentialError extends Error {
  constructor() { super("Selected credential unavailable"); }
}
export function validateExecutionConfiguration(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env): ExecutionConfiguration {
  const configuration = executionConfigurationSchema.parse(value);
  if (configuration.execution_contract !== ADAPTERS[configuration.adapter_id].executionContract) throw new Error("Unsupported execution contract");
  validateEndpoint(configuration.endpoint_url);
  if (!env[configuration.credential_ref]?.trim()) throw new MissingProviderCredentialError();
  return configuration;
}
/** Actual key bytes are captured here once; the database freezes only the reference. */
export function prepareProvider(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl?: typeof fetch, onTransmit?: () => void): InferenceProvider {
  const configuration = validateExecutionConfiguration(value, env);
  const transport = ADAPTERS[configuration.adapter_id].create({
    endpoint: configuration.endpoint_url,
    apiKey: env[configuration.credential_ref]!.trim(),
    modelId: configuration.model_id,
    fetch: createInferenceFetch({ fetch: fetchImpl, onTransmit })
  });
  return Object.freeze({ complete: transport.complete.bind(transport) });
}
