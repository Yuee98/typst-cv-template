import { describe, expect, it } from "vitest";
import {
  ProviderRegistryError,
  resolveAdapter,
  resolveCalculator,
  resolveCredentialSecret,
  resolveEndpoint,
  validateAdapterConfig,
} from "./adapter-registry";

describe("adapter registry", () => {
  it("resolves only code-owned adapters and HTTPS endpoints", () => {
    expect(resolveAdapter("deepseek_chat_v1").wireApiKind).toBe("chat_completions_v1");
    expect(resolveAdapter("mimo_responses_v1").wireApiKind).toBe("responses_v1");
    expect(resolveEndpoint("deepseek_official").url).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(resolveEndpoint("mimo_cn_official").url).toBe(
      "https://api.xiaomimimo.com/v1/responses",
    );
  });

  it.each([
    ["adapter", () => resolveAdapter("openai_compatible")],
    ["endpoint", () => resolveEndpoint("http://localhost:9999")],
    ["calculator", () => resolveCalculator("db_supplied_calculator")],
  ])("fails closed for an unknown %s alias", (_label, resolve) => {
    expect(resolve).toThrow(ProviderRegistryError);
  });

  it("resolves credential aliases through fixed env keys and rejects missing secrets", () => {
    expect(
      resolveCredentialSecret("deepseek_api_key", {
        DEEPSEEK_API_KEY: "secret",
        ATTACKER_CONTROLLED_ENV_NAME: "wrong",
      }),
    ).toBe("secret");
    expect(() =>
      resolveCredentialSecret("deepseek_api_key", { DEEPSEEK_API_KEY: "  " }),
    ).toThrow(/unavailable/);
    expect(() =>
      resolveCredentialSecret("ATTACKER_CONTROLLED_ENV_NAME", {
        ATTACKER_CONTROLLED_ENV_NAME: "secret",
      }),
    ).toThrow(/unknown credential alias/);
  });

  it("strictly rejects unknown, missing, and unsupported adapter config", () => {
    const valid = {
      thinking: "disabled",
      structuredOutput: "json_object",
      providerSubjectField: "user_id",
    };
    expect(validateAdapterConfig("deepseek_chat_v1", valid)).toEqual(valid);
    expect(() =>
      validateAdapterConfig("deepseek_chat_v1", { ...valid, baseUrl: "http://attacker" }),
    ).toThrow(/unknown: baseUrl/);
    expect(() =>
      validateAdapterConfig("deepseek_chat_v1", {
        thinking: "disabled",
        structuredOutput: "json_object",
      }),
    ).toThrow(/missing: providerSubjectField/);
    expect(() =>
      validateAdapterConfig("deepseek_chat_v1", { ...valid, thinking: "enabled" }),
    ).toThrow(/unsupported value/);
  });
});
