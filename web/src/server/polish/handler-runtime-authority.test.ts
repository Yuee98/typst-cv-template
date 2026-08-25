import { describe, expect, it } from "vitest";

import { createRealPolishRuntimeAuthorityV2 } from "./handler-runtime-authority";
import { PolishAdapterUnavailableV2Error } from "./lifecycle-v2";
import { resolveProfile } from "./profile-registry";
import {
  DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1,
} from "./service-runtime-contract-v1";

describe("real V2 handler runtime authority", () => {
  it.each([
    ["development", undefined],
    ["production", "true"],
  ] as const)(
    "rejects single-flag fake inference with the real backend in %s/CI=%s",
    (nodeEnv, ci) => {
      expect(() =>
        createRealPolishRuntimeAuthorityV2({
          NODE_ENV: nodeEnv,
          CI: ci,
          POLISH_FAKE_LLM: "true",
          POLISH_FAKE_BACKEND: undefined,
        }),
      ).toThrow(/requires POLISH_FAKE_BACKEND=true/);
    },
  );

  it("pins the real backend to reviewed DeepSeek attestation and code-owned adapters", () => {
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      DEEPSEEK_API_KEY: undefined,
    });

    expect(authority.runtimeTargetResolver).toBe(
      DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1,
    );
    expect(
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    expect(
      authority.runtimeTargetResolver({
        ...structuredClone(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
        profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
      }),
    ).toBe(false);
    expect(() =>
      authority.resolveProvider(
        resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1"),
      ),
    ).toThrow(/credential deepseek_api_key is unavailable/);
    expect(() =>
      authority.resolveProvider(
        resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1"),
      ),
    ).toThrow(PolishAdapterUnavailableV2Error);
  });
});
