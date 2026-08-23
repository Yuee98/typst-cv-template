import {
  CREDENTIAL_ALIASES,
  ENDPOINT_ALIASES,
  ProviderRegistryError,
  resolveCredentialSecret,
  resolveEndpoint,
  type CredentialAlias,
  type EndpointAlias,
} from "./adapter-registry";
import {
  PROFILE_KEYS,
  resolveProfile,
  type ProfileKey,
} from "./profile-registry";

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProviderEnvironmentSelection {
  readonly profileKey: string;
  readonly credentialAlias: string;
  readonly endpointAlias: string;
}

export interface ResolvedProviderEnvironment {
  readonly profileKey: ProfileKey;
  readonly credentialAlias: CredentialAlias;
  readonly endpointAlias: EndpointAlias;
  readonly endpointUrl: string;
  readonly apiKey: string;
}

export interface ProviderEnvironmentResolver {
  resolve(selection: ProviderEnvironmentSelection): ResolvedProviderEnvironment;
}

export class ProviderEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderEnvironmentError";
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function isRegisteredProfileKey(value: string): value is ProfileKey {
  return (PROFILE_KEYS as readonly string[]).includes(value);
}

function isRegisteredCredentialAlias(value: string): value is CredentialAlias {
  return (CREDENTIAL_ALIASES as readonly string[]).includes(value);
}

function isRegisteredEndpointAlias(value: string): value is EndpointAlias {
  return (ENDPOINT_ALIASES as readonly string[]).includes(value);
}

function assertSafeEndpoint(endpointUrl: string, endpointAlias: EndpointAlias): string {
  if (CONTROL_CHARACTERS.test(endpointUrl)) {
    throw new ProviderEnvironmentError(`registered endpoint ${endpointAlias} is invalid`);
  }

  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new ProviderEnvironmentError(`registered endpoint ${endpointAlias} is invalid`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ProviderEnvironmentError(`registered endpoint ${endpointAlias} is invalid`);
  }

  return endpointUrl;
}

/**
 * Preserve the existing fake-provider deployment ceiling at every new runtime
 * resolution seam. The CI exemption intentionally matches provider.ts exactly.
 */
export function assertFakeLlmDeploymentAllowed(env: ServerEnvironment): void {
  if (
    env.POLISH_FAKE_LLM === "true" &&
    env.NODE_ENV === "production" &&
    env.CI !== "true"
  ) {
    throw new ProviderEnvironmentError(
      "POLISH_FAKE_LLM=true is forbidden with NODE_ENV=production outside CI",
    );
  }
}

function createResolver(
  env: ServerEnvironment,
  endpointOverrides: Readonly<Partial<Record<EndpointAlias, string>>> | undefined,
): ProviderEnvironmentResolver {
  assertFakeLlmDeploymentAllowed(env);

  return Object.freeze({
    resolve(selection: ProviderEnvironmentSelection): ResolvedProviderEnvironment {
      if (!isRegisteredProfileKey(selection.profileKey)) {
        throw new ProviderEnvironmentError("unknown profile key");
      }
      if (!isRegisteredCredentialAlias(selection.credentialAlias)) {
        throw new ProviderEnvironmentError("unknown credential alias");
      }
      if (!isRegisteredEndpointAlias(selection.endpointAlias)) {
        throw new ProviderEnvironmentError("unknown endpoint alias");
      }

      const profile = resolveProfile(selection.profileKey);
      if (selection.credentialAlias !== profile.credentialAlias) {
        throw new ProviderEnvironmentError(
          "credential alias does not match the code-owned profile",
        );
      }
      if (selection.endpointAlias !== profile.endpointAlias) {
        throw new ProviderEnvironmentError(
          "endpoint alias does not match the code-owned profile",
        );
      }

      const endpointUrl = assertSafeEndpoint(
        endpointOverrides?.[selection.endpointAlias] ??
          resolveEndpoint(selection.endpointAlias).url,
        selection.endpointAlias,
      );

      let apiKey: string;
      try {
        apiKey = resolveCredentialSecret(selection.credentialAlias, env);
      } catch (error) {
        if (error instanceof ProviderRegistryError) {
          throw new ProviderEnvironmentError("registered credential is unavailable");
        }
        throw error;
      }
      if (apiKey !== apiKey.trim()) {
        throw new ProviderEnvironmentError("registered credential is unavailable");
      }

      return Object.freeze({
        profileKey: profile.profileKey,
        credentialAlias: profile.credentialAlias,
        endpointAlias: profile.endpointAlias,
        endpointUrl,
        apiKey,
      });
    },
  });
}

/** Production resolver: process env plus code-owned official endpoints only. */
export function createProviderEnvironmentResolver(): ProviderEnvironmentResolver {
  return createResolver(process.env, undefined);
}

export interface ProviderEnvironmentTestOptions {
  readonly env: ServerEnvironment;
  readonly endpointRegistry?: Readonly<Partial<Record<EndpointAlias, string>>>;
}

function assertTestResolverAllowed(
  actualRuntimeEnv: ServerEnvironment,
  injectedEnv: ServerEnvironment,
): void {
  if (
    actualRuntimeEnv.NODE_ENV === "production" ||
    injectedEnv.NODE_ENV === "production"
  ) {
    throw new ProviderEnvironmentError(
      "test provider environment resolver is forbidden in production",
    );
  }
}

/**
 * Explicit unit/integration-test seam. It cannot be constructed in production,
 * so custom endpoints never expand the production deployment ceiling.
 */
export function createProviderEnvironmentResolverForTest(
  options: ProviderEnvironmentTestOptions,
): ProviderEnvironmentResolver {
  // The actual process environment is an uninjectable ceiling: a caller may
  // provide synthetic test env values, but cannot use them to disguise a
  // production process and enable custom endpoints.
  assertTestResolverAllowed(process.env, options.env);
  for (const alias of Object.keys(options.endpointRegistry ?? {})) {
    if (!isRegisteredEndpointAlias(alias)) {
      throw new ProviderEnvironmentError("unknown test endpoint alias");
    }
  }
  return createResolver(options.env, options.endpointRegistry);
}
