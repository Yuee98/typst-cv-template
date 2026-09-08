import "server-only";
import { isIP } from "node:net";
import { credentialEnvNameSchema, validateProfileExecutionConfigV2, type ProfileExecutionConfigV2 } from "./profile-execution-v2";

export class ProviderBindingError extends Error {
  constructor() { super("Provider destination or credential binding is unavailable"); }
}

const OFFICIAL_DESTINATIONS = {
  deepseek_chat_v1: {
    origin: "https://api.deepseek.com",
    path: "/chat/completions",
    recipient: "deepseek",
    credentialEnvName: /^AI_PROVIDER_KEY_DEEPSEEK_[A-Z0-9_]{1,150}$/u,
  },
  mimo_responses_v1: {
    origin: "https://api.xiaomimimo.com",
    path: "/v1/responses",
    recipient: "xiaomi-mimo",
    credentialEnvName: /^AI_PROVIDER_KEY_MIMO_[A-Z0-9_]{1,150}$/u,
  },
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

/**
 * Shared by Admin validation and request execution. The recipient comes from
 * DB-frozen legal evidence, while the accepted key namespace comes from the
 * code-owned adapter policy.
 */
export function validateProviderCredentialBinding(
  value: unknown,
  recipient: { providerId: string; recipientKey: string },
): void {
  const profile = validateProfileExecutionConfigV2(value);
  const policy = OFFICIAL_DESTINATIONS[profile.adapterKind];
  if (
    recipient.providerId !== profile.providerId ||
    recipient.recipientKey !== policy.recipient ||
    !policy.credentialEnvName.test(profile.credentialEnvName)
  ) throw new ProviderBindingError();
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
}
const preparedTransports = new WeakSet<object>();

export function assertPreparedProviderTransportV2(value: PreparedProviderTransportV2): void {
  const policy = OFFICIAL_DESTINATIONS[value.profile.adapterKind];
  if (
    !preparedTransports.has(value) ||
    value.endpoint !== validateProviderEndpoint(value.profile) ||
    !policy.credentialEnvName.test(value.profile.credentialEnvName)
  ) throw new ProviderBindingError();
}

/**
 * The database selects the profile, but code limits every actual send to the
 * adapter's approved recipient, exact official endpoint, and credential
 * namespace. This keeps DB-configured fields flexible without allowing a
 * crossed Provider key or arbitrary process.env access.
 */
export function prepareProviderTransportV2(input: {
  profile: unknown;
  recipient: { providerId: string; recipientKey: string };
  resolveSecret: (name: string) => string;
}): PreparedProviderTransportV2 {
  const profile = validateProfileExecutionConfigV2(input.profile);
  const endpoint = validateProviderEndpoint(profile);
  const policy = OFFICIAL_DESTINATIONS[profile.adapterKind];
  validateProviderCredentialBinding(profile, input.recipient);
  if (new URL(endpoint).origin !== policy.origin) throw new ProviderBindingError();
  const apiKey = input.resolveSecret(profile.credentialEnvName);
  const prepared = Object.freeze({ profile, endpoint, apiKey });
  preparedTransports.add(prepared);
  return prepared;
}
