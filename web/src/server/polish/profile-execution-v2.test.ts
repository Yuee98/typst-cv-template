import { describe, expect, it } from "vitest";
import fixtures from "../../../test/fixtures/profile-execution-v2.json";
import { validateVersionedProfileExecutionConfig } from "./profile-execution-v2";
import { resolveProfile } from "./profile-registry";

describe("versioned execution configuration", () => {
  it("preserves frozen v1 tuples and accepts synthetic models only with supported v2 semantics", () => {
    for (const key of ["deepseek.official.deepseek-v4-flash.chat.v1", "mimo.cn.mimo-v2.5-pro.responses.v1"] as const) {
      const old = resolveProfile(key);
      expect(validateVersionedProfileExecutionConfig(old)).toEqual(old);
    }
    for (const fixture of Object.values(fixtures)) expect(validateVersionedProfileExecutionConfig(fixture)).toEqual(fixture);
  });
  it.each([
    { schemaVersion: "unknown" }, { schemaVersion: "profile_execution_config_v1" },
    { credentialAlias: "deepseek_api_key" }, { endpointAlias: "deepseek_official" },
    { credentialEnvName: "SUPABASE_SERVICE_ROLE_KEY" }, { credentialEnvName: "AI_PROVIDER_KEY_" },
    { adapterKind: "unimplemented" }, { wireApiKind: "responses_v1" },
    { capabilityContractId: "mimo_responses_output_text_v1" }, { cachePolicyId: "mimo_automatic_prompt_cache_v1" },
    { calculatorKind: "openai_gpt56_v1" }, { modelId: "unsafe\nmodel" },
    { config: { ...fixtures.deepseek.config, thinking: "enabled" } },
  ])("rejects a mixed, malformed or unsupported tuple without v1 fallback: %j", (override) => {
    expect(() => validateVersionedProfileExecutionConfig({ ...fixtures.deepseek, ...override })).toThrow();
  });
  it("keeps different model/destination identities even when adapter config is identical", () => {
    const first = validateVersionedProfileExecutionConfig(fixtures.deepseek);
    const second = validateVersionedProfileExecutionConfig({ ...fixtures.deepseek, profileKey: "deepseek.successor", modelId: "second-model", credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK_SECONDARY" });
    expect(first.config).toEqual(second.config);
    expect(first).not.toEqual(second);
  });
});
