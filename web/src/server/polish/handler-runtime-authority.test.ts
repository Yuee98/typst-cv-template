import { afterEach, describe, expect, it, vi } from "vitest";

import { createRealPolishRuntimeAuthorityV2 } from "./handler-runtime-authority";
import { resolveProfile } from "./profile-registry";
import {
  DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1,
} from "./service-runtime-contract-v1";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("keeps handler activation DeepSeek-only while exposing reviewed code-owned adapters", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      DEEPSEEK_API_KEY: undefined,
      MIMO_API_KEY: "test-only-mimo-key",
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
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(false);
    expect(() =>
      authority.resolveProvider(
        resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1"),
      ),
    ).toThrow(/credential deepseek_api_key is unavailable/);
    expect(
      authority.resolveProvider(
        resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1"),
      ),
    ).toMatchObject({ kind: "mimo_responses_v1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
