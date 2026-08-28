import { afterEach, describe, expect, it, vi } from "vitest";

import { createRealPolishRuntimeAuthorityV2 } from "./handler-runtime-authority";
import { resolveProfile } from "./profile-registry";
import {
  DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1_SHA256,
  DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1_SHA256,
} from "./service-runtime-contract-v1";

const SUPERSEDED_COMBINED_CONTRACT_ID =
  "runtime.deepseek-v2-mimo-v2.5-pro.v1";
const SUPERSEDED_COMBINED_CONTRACT_SHA256 =
  "049fc8e626fc87656fa8bfda86951782f9e715b2728c09d765f24ff89e633b8d";

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

  it("admits legacy DeepSeek and both exact combined-v2 targets", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      DEEPSEEK_API_KEY: "test-only-deepseek-key",
      MIMO_API_KEY: "test-only-mimo-key",
    });

    expect(
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    expect(
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    expect(
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    expect(
      authority.resolveProvider(
        resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1"),
      ),
    ).toMatchObject({ kind: "deepseek_chat_v1" });
    expect(
      authority.resolveProvider(
        resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1"),
      ),
    ).toMatchObject({ kind: "mimo_responses_v1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "superseded DeepSeek target",
      DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
    ],
    ["superseded MiMo target", DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1],
  ])("rejects the old combined-v1 pair for %s", (_label, target) => {
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
    });
    const superseded = {
      ...structuredClone(target),
      runtimeContractId: SUPERSEDED_COMBINED_CONTRACT_ID,
      runtimeContractSha256: SUPERSEDED_COMBINED_CONTRACT_SHA256,
    };

    expect(authority.runtimeTargetResolver(superseded)).toBe(false);
  });

  it.each([
    [
      "current ID with superseded hash",
      DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
      DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1.runtimeContractId,
      SUPERSEDED_COMBINED_CONTRACT_SHA256,
    ],
    [
      "superseded ID with current hash",
      DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
      SUPERSEDED_COMBINED_CONTRACT_ID,
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1_SHA256,
    ],
    [
      "legacy ID with combined-v2 hash",
      DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
      DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1.runtimeContractId,
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1_SHA256,
    ],
    [
      "combined-v2 ID with legacy hash",
      DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
      DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1.runtimeContractId,
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1_SHA256,
    ],
  ])("rejects %s", (_label, target, runtimeContractId, runtimeContractSha256) => {
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
    });
    expect(
      authority.runtimeTargetResolver({
        ...structuredClone(target),
        runtimeContractId,
        runtimeContractSha256,
      }),
    ).toBe(false);
  });

  it("rejects crossed target/profile/route tuples and unknown targets", () => {
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
    });
    const crossedProfile = {
      ...structuredClone(DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      profileKey: DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1.profileKey,
    };
    const crossedRoute = {
      ...structuredClone(DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      routeDescriptor: structuredClone(
        DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1.routeDescriptor,
      ),
    };
    const unknown = {
      ...structuredClone(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      runtimeContractId: "runtime.unknown.v1",
    };

    expect(authority.runtimeTargetResolver(crossedProfile)).toBe(false);
    expect(authority.runtimeTargetResolver(crossedRoute)).toBe(false);
    expect(authority.runtimeTargetResolver(unknown)).toBe(false);
  });

  it("fails a selected route with a missing credential without provider substitution", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mimoOnly = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      MIMO_API_KEY: "test-only-mimo-key",
    });
    const deepSeekOnly = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      DEEPSEEK_API_KEY: "test-only-deepseek-key",
    });

    expect(() =>
      mimoOnly.resolveProvider(
        resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1"),
      ),
    ).toThrow(/credential deepseek_api_key is unavailable/u);
    expect(() =>
      deepSeekOnly.resolveProvider(
        resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1"),
      ),
    ).toThrow(/credential mimo_api_key is unavailable/u);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
