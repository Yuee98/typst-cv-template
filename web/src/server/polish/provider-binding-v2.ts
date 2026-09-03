import "server-only";
import { isIP } from "node:net";
import { z } from "zod";
import { credentialEnvNameSchema, validateProfileExecutionConfigV2, type ProfileExecutionConfigV2 } from "./profile-execution-v2";

const codeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/);
const manifestSchema = z.strictObject({
  schemaVersion: z.literal("ai_provider_bindings_v1"),
  revision: codeId,
  bindings: z.array(z.strictObject({
    credentialEnvName: credentialEnvNameSchema,
    providerId: z.string().uuid(),
    recipientKey: codeId,
    origin: z.string().max(300),
  })).min(1).max(100),
});
export type ProviderBindingManifest = z.infer<typeof manifestSchema>;

export class ProviderBindingError extends Error {
  constructor() { super("Provider destination or credential binding is unavailable"); }
}

const OFFICIAL_DESTINATIONS = {
  deepseek_chat_v1: { origin: "https://api.deepseek.com", path: "/chat/completions", recipient: "deepseek" },
  mimo_responses_v1: { origin: "https://api.xiaomimimo.com", path: "/v1/responses", recipient: "xiaomi-mimo" },
} as const;

/** Shared canonicalization for authoring validation and every actual send.
 * This release admits exact existing official origins only. It does not claim
 * one DNS lookup makes arbitrary custom domains safe against rebinding. */
export function validateProviderEndpoint(profile: ProfileExecutionConfigV2): string {
  try {
    const url = new URL(profile.endpointUrl);
    const policy = OFFICIAL_DESTINATIONS[profile.adapterKind];
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.port || isIP(url.hostname.replace(/^\[|\]$/g, ""))
      || url.href !== profile.endpointUrl || url.origin !== policy.origin || url.pathname !== policy.path) {
      throw new ProviderBindingError();
    }
    return url.href;
  } catch { throw new ProviderBindingError(); }
}

export function parseProviderBindingManifest(value: unknown): ProviderBindingManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new ProviderBindingError();
  const names = new Set<string>();
  for (const binding of parsed.data.bindings) {
    if (names.has(binding.credentialEnvName)) throw new ProviderBindingError();
    names.add(binding.credentialEnvName);
    const official = Object.values(OFFICIAL_DESTINATIONS).find(policy => policy.origin === binding.origin);
    if (!official || official.recipient !== binding.recipientKey) throw new ProviderBindingError();
  }
  return parsed.data;
}

/** A captured namespace, never arbitrary DB indexing of process.env. */
export function createProviderSecretResolver(env: Readonly<Record<string, string | undefined>>) {
  const secrets = new Map<string, string>();
  for (const name of Object.keys(env)) {
    if (!credentialEnvNameSchema.safeParse(name).success) continue;
    const value = env[name];
    if (value && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value)) secrets.set(name, value);
  }
  return (name: string): string => {
    if (!credentialEnvNameSchema.safeParse(name).success || !secrets.has(name)) throw new ProviderBindingError();
    return secrets.get(name)!;
  };
}

export interface PreparedProviderTransportV2 {
  readonly profile: ProfileExecutionConfigV2;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly runtimeBuildId: string;
  readonly bindingManifestRevision: string;
}
const preparedTransports = new WeakSet<object>();

export function assertPreparedProviderTransportV2(value: PreparedProviderTransportV2): void {
  if (!preparedTransports.has(value) || value.endpoint !== validateProviderEndpoint(value.profile)) throw new ProviderBindingError();
}

/** recipient is obtained from validated DB legal/target evidence, not mutable
 * Provider defaults or browser input. Build/report checks precede this step. */
export function prepareProviderTransportV2(input: {
  profile: unknown;
  recipient: { providerId: string; recipientKey: string };
  manifest: unknown;
  expectedManifestRevision: string;
  runtimeBuildId: string;
  resolveSecret: (name: string) => string;
}): PreparedProviderTransportV2 {
  const profile = validateProfileExecutionConfigV2(input.profile);
  const endpoint = validateProviderEndpoint(profile);
  const manifest = parseProviderBindingManifest(input.manifest);
  const binding = manifest.bindings.find(item => item.credentialEnvName === profile.credentialEnvName);
  if (!binding || binding.providerId !== profile.providerId || input.recipient.providerId !== profile.providerId
    || binding.recipientKey !== input.recipient.recipientKey || binding.origin !== new URL(endpoint).origin
    || manifest.revision !== input.expectedManifestRevision
    || !/^[a-z0-9][a-z0-9._:-]{0,199}$/.test(input.runtimeBuildId)) throw new ProviderBindingError();
  const apiKey = input.resolveSecret(profile.credentialEnvName);
  const prepared = Object.freeze({ profile, endpoint, apiKey, runtimeBuildId: input.runtimeBuildId, bindingManifestRevision: manifest.revision });
  preparedTransports.add(prepared);
  return prepared;
}
