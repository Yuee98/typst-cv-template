import { describe, expect, it } from "vitest";
import { ProviderRegistryError } from "./adapter-registry";
import {
  INITIAL_LEGAL_BUNDLE_VERSION,
  legalBundleContainsManifest,
  resolveProfile,
  validateProfileExecutionConfig,
} from "./profile-registry";

describe("profile registry", () => {
  it("resolves the initial DeepSeek and MiMo execution profiles", () => {
    expect(resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1")).toMatchObject({
      adapterKind: "deepseek_chat_v1",
      endpointAlias: "deepseek_official",
      credentialAlias: "deepseek_api_key",
      modelId: "deepseek-v4-flash",
      legalManifestId: "deepseek-official-2026-08-23-v1",
      calculatorKind: "linear_token_v1",
    });
    expect(resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1")).toMatchObject({
      adapterKind: "mimo_responses_v1",
      endpointAlias: "mimo_cn_official",
      credentialAlias: "mimo_api_key",
      modelId: "mimo-v2.5-pro",
      legalManifestId: "mimo-cn-2026-08-23-v1",
      calculatorKind: "linear_token_v1",
    });
  });

  it("accepts only an exact registered execution projection", () => {
    const profile = resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1");
    expect(validateProfileExecutionConfig(profile)).toEqual(profile);
    expect(() =>
      validateProfileExecutionConfig({ ...profile, endpointUrl: "http://attacker.example" }),
    ).toThrow(/unknown: endpointUrl/);
    expect(() =>
      validateProfileExecutionConfig({ ...profile, credentialAlias: "DB_ENV_VALUE" }),
    ).toThrow(/credentialAlias does not match/);
    expect(() =>
      validateProfileExecutionConfig({ ...profile, modelId: "same-family-new-snapshot" }),
    ).toThrow(/modelId does not match/);
  });

  it("rejects unknown profiles without a generic compatible fallback", () => {
    expect(() => resolveProfile("generic.openai-compatible.v1")).toThrow(
      ProviderRegistryError,
    );
  });

  it("binds the initial legal bundle to exactly the two reviewed manifests", () => {
    expect(
      legalBundleContainsManifest(
        INITIAL_LEGAL_BUNDLE_VERSION,
        "deepseek-official-2026-08-23-v1",
      ),
    ).toBe(true);
    expect(
      legalBundleContainsManifest(
        INITIAL_LEGAL_BUNDLE_VERSION,
        "mimo-cn-2026-08-23-v1",
      ),
    ).toBe(true);
    expect(legalBundleContainsManifest(INITIAL_LEGAL_BUNDLE_VERSION, "openrouter-luna-v1")).toBe(
      false,
    );
    expect(
      legalBundleContainsManifest("future-bundle", "deepseek-official-2026-08-23-v1"),
    ).toBe(false);
  });
});
