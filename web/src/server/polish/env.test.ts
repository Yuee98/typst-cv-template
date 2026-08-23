import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderEnvironmentError,
  assertFakeLlmDeploymentAllowed,
  createProviderEnvironmentResolver,
  createProviderEnvironmentResolverForTest,
  type ProviderEnvironmentSelection,
} from "./env";

const DEEPSEEK_SELECTION: ProviderEnvironmentSelection = {
  profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
  credentialAlias: "deepseek_api_key",
  endpointAlias: "deepseek_official",
};

const MIMO_SELECTION: ProviderEnvironmentSelection = {
  profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
  credentialAlias: "mimo_api_key",
  endpointAlias: "mimo_cn_official",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider environment resolver", () => {
  it("resolves the official DeepSeek and MiMo deployments through fixed aliases", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("MIMO_API_KEY", "mimo-test-key");
    vi.stubEnv("POLISH_FAKE_LLM", "false");

    const resolver = createProviderEnvironmentResolver();

    expect(resolver.resolve(DEEPSEEK_SELECTION)).toEqual({
      ...DEEPSEEK_SELECTION,
      endpointUrl: "https://api.deepseek.com/chat/completions",
      apiKey: "deepseek-test-key",
    });
    expect(resolver.resolve(MIMO_SELECTION)).toEqual({
      ...MIMO_SELECTION,
      endpointUrl: "https://api.xiaomimimo.com/v1/responses",
      apiKey: "mimo-test-key",
    });
  });

  it.each([
    [{ ...DEEPSEEK_SELECTION, profileKey: "unknown.profile" }, /unknown profile key/u],
    [{ ...DEEPSEEK_SELECTION, credentialAlias: "ATTACKER_ENV" }, /unknown credential alias/u],
    [{ ...DEEPSEEK_SELECTION, endpointAlias: "https://attacker.example/v1" }, /unknown endpoint alias/u],
    [{ ...DEEPSEEK_SELECTION, credentialAlias: "mimo_api_key" }, /does not match/u],
    [{ ...DEEPSEEK_SELECTION, endpointAlias: "mimo_cn_official" }, /does not match/u],
  ])("fails closed for unknown or mismatched DB aliases", (selection, expected) => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("MIMO_API_KEY", "mimo-test-key");
    expect(() => createProviderEnvironmentResolver().resolve(selection)).toThrow(expected);
  });

  it.each([undefined, "", " ", "\t", " key", "key "])(
    "fails closed when the registered secret is absent or malformed (%j)",
    (secret) => {
      const resolver = createProviderEnvironmentResolverForTest({
        env: { NODE_ENV: "test", DEEPSEEK_API_KEY: secret },
      });
      expect(() => resolver.resolve(DEEPSEEK_SELECTION)).toThrow(
        /registered credential is unavailable/u,
      );
    },
  );

  it("never treats a DB credential value as an environment-variable name", () => {
    const resolver = createProviderEnvironmentResolverForTest({
      env: { NODE_ENV: "test", ATTACKER_ENV: "attacker-secret" },
    });
    expect(() =>
      resolver.resolve({ ...DEEPSEEK_SELECTION, credentialAlias: "ATTACKER_ENV" }),
    ).toThrow(/unknown credential alias/u);
  });

  it("allows a controlled HTTPS endpoint registry only through the test constructor", () => {
    const resolver = createProviderEnvironmentResolverForTest({
      env: { NODE_ENV: "test", DEEPSEEK_API_KEY: "test-key" },
      endpointRegistry: {
        deepseek_official: "https://deepseek.test.invalid/v1/chat/completions",
      },
    });
    expect(resolver.resolve(DEEPSEEK_SELECTION).endpointUrl).toBe(
      "https://deepseek.test.invalid/v1/chat/completions",
    );

    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    expect(() =>
      createProviderEnvironmentResolver().resolve({
        ...DEEPSEEK_SELECTION,
        endpointAlias: "https://deepseek.test.invalid/v1/chat/completions",
      }),
    ).toThrow(/unknown endpoint alias/u);
  });

  it.each([
    "http://deepseek.test.invalid/v1",
    "https://user:password@deepseek.test.invalid/v1",
    "https://deepseek.test.invalid/v1?api_key=secret",
    "https://deepseek.test.invalid/v1#secret",
    "https://deepseek.test.invalid/v1\nlog-forgery",
    "https://deepseek.test.invalid/v1\u007flog-forgery",
  ])("rejects an unsafe test endpoint without echoing it (%j)", (endpointUrl) => {
    const resolver = createProviderEnvironmentResolverForTest({
      env: { NODE_ENV: "test", DEEPSEEK_API_KEY: "test-key" },
      endpointRegistry: { deepseek_official: endpointUrl },
    });
    let caught: unknown;
    try {
      resolver.resolve(DEEPSEEK_SELECTION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderEnvironmentError);
    expect(String(caught)).not.toContain(endpointUrl);
    expect(String(caught)).not.toContain("secret");
  });

  it("rejects unknown endpoint keys in a test registry", () => {
    expect(() =>
      createProviderEnvironmentResolverForTest({
        env: { NODE_ENV: "test" },
        endpointRegistry: {
          attacker_endpoint: "https://attacker.test.invalid/v1",
        } as never,
      }),
    ).toThrow(/unknown test endpoint alias/u);
  });

  it("does not allow the test constructor to weaken production endpoint policy", () => {
    expect(() =>
      createProviderEnvironmentResolverForTest({
        env: { NODE_ENV: "production", DEEPSEEK_API_KEY: "test-key" },
        endpointRegistry: {
          deepseek_official: "https://deepseek.test.invalid/v1",
        },
      }),
    ).toThrow(/forbidden in production/u);
  });
});

describe("fake LLM deployment guard", () => {
  it("cannot be bypassed by constructing the production environment resolver", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLISH_FAKE_LLM", "true");
    vi.stubEnv("CI", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    expect(() => createProviderEnvironmentResolver()).toThrow(/forbidden/u);
  });

  it("rejects production fake mode outside the exact CI exemption", () => {
    expect(() =>
      assertFakeLlmDeploymentAllowed({
        NODE_ENV: "production",
        POLISH_FAKE_LLM: "true",
      }),
    ).toThrow(/forbidden/u);
    expect(() =>
      assertFakeLlmDeploymentAllowed({
        NODE_ENV: "production",
        POLISH_FAKE_LLM: "true",
        CI: "1",
      }),
    ).toThrow(/forbidden/u);
  });

  it("preserves the existing exact CI=true and non-production allowances", () => {
    expect(() =>
      assertFakeLlmDeploymentAllowed({
        NODE_ENV: "production",
        POLISH_FAKE_LLM: "true",
        CI: "true",
      }),
    ).not.toThrow();
    expect(() =>
      assertFakeLlmDeploymentAllowed({
        NODE_ENV: "development",
        POLISH_FAKE_LLM: "true",
      }),
    ).not.toThrow();
  });
});
