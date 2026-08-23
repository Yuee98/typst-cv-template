import { describe, expect, it } from "vitest";
import { ProviderRegistryError } from "./adapter-registry";
import {
  POLISH_OUTPUT_SCHEMA_VERSION,
  POLISH_PROMPT_TEMPLATE_ID,
  PromptCachePolicyError,
  resolvePromptCachePolicy,
} from "./cache-policy";
import {
  buildPolishPromptBlocks,
  POLISH_PROMPT_VERSION,
  POLISH_STABLE_PROMPT_BLOCK_ID,
  type PolishPromptInput,
} from "./prompt";

const PROFILE_VERSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function makeInput(overrides: Partial<PolishPromptInput> = {}): PolishPromptInput {
  return {
    language: "zh",
    sectionId: "experience",
    granularity: "item",
    items: [{ id: "cv-item-id", kind: "experience_bullet", text: "private CV text" }],
    contextLevel: 0,
    references: [],
    ...overrides,
  };
}

function resolve(
  cachePolicyId:
    | "deepseek_automatic_context_cache_v1"
    | "mimo_automatic_prompt_cache_v1" = "deepseek_automatic_context_cache_v1",
) {
  const input = makeInput();
  return resolvePromptCachePolicy({
    cachePolicyId,
    profileVersionId: PROFILE_VERSION_ID,
    language: input.language,
    prompt: buildPolishPromptBlocks(input),
  });
}

describe("resolvePromptCachePolicy", () => {
  it.each([
    "deepseek_automatic_context_cache_v1",
    "mimo_automatic_prompt_cache_v1",
  ] as const)("resolves the reviewed automatic policy %s", (cachePolicyId) => {
    expect(resolve(cachePolicyId)).toEqual({
      schemaVersion: "prompt_cache_policy_decision_v1",
      cachePolicyId,
      mode: "automatic",
      cacheWriteReporting: "unavailable",
      boundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID,
      upstreamCacheParameters: null,
      cacheKeyMaterial: {
        schemaVersion: "prompt_cache_key_material_v1",
        profileVersionId: PROFILE_VERSION_ID,
        promptVersion: POLISH_PROMPT_VERSION,
        outputSchemaVersion: POLISH_OUTPUT_SCHEMA_VERSION,
        templateId: POLISH_PROMPT_TEMPLATE_ID,
        locale: "zh",
      },
    });
  });

  it("keeps cache key material free of CV, user, request, target, and style values", () => {
    const sensitiveValues = [
      "private-user-id",
      "private-request-id",
      "private-target-id",
      "private CV text",
      "private custom style",
    ];
    const input = makeInput({
      items: [{ id: sensitiveValues[2], kind: "experience_bullet", text: sensitiveValues[3] }],
      styleInstruction: sensitiveValues[4],
    });
    const decision = resolvePromptCachePolicy({
      cachePolicyId: "mimo_automatic_prompt_cache_v1",
      profileVersionId: PROFILE_VERSION_ID,
      language: input.language,
      prompt: buildPolishPromptBlocks(input),
    });
    const serializedMaterial = JSON.stringify(decision.cacheKeyMaterial);

    for (const value of sensitiveValues) {
      expect(serializedMaterial).not.toContain(value);
    }
    expect(decision).not.toHaveProperty("targets");
    expect(decision.upstreamCacheParameters).toBeNull();
  });

  it("does not mutate or pad a short prompt to chase a provider token threshold", () => {
    const input = makeInput({
      sectionId: "x",
      items: [{ id: "i", kind: "experience_bullet", text: "短句" }],
    });
    const prompt = buildPolishPromptBlocks(input);
    const before = structuredClone(prompt);

    const decision = resolvePromptCachePolicy({
      cachePolicyId: "deepseek_automatic_context_cache_v1",
      profileVersionId: PROFILE_VERSION_ID,
      language: input.language,
      prompt,
    });

    expect(prompt).toEqual(before);
    expect(decision.upstreamCacheParameters).toBeNull();
    expect(JSON.stringify(prompt)).not.toMatch(/padding|minimum.{0,8}tokens/i);
  });

  it("fails closed for an unknown or future cache policy", () => {
    expect(() =>
      resolvePromptCachePolicy({
        cachePolicyId: "gpt_explicit_cache_v1",
        profileVersionId: PROFILE_VERSION_ID,
        language: "zh",
        prompt: buildPolishPromptBlocks(makeInput()),
      }),
    ).toThrow(ProviderRegistryError);
  });

  it("rejects a stable block containing request-derived content", () => {
    const prompt = buildPolishPromptBlocks(makeInput());
    prompt.blocks[0] = { ...prompt.blocks[0], content: `${prompt.blocks[0].content}\nprivate CV text` };

    expect(() =>
      resolvePromptCachePolicy({
        cachePolicyId: "deepseek_automatic_context_cache_v1",
        profileVersionId: PROFILE_VERSION_ID,
        language: "zh",
        prompt,
      }),
    ).toThrow("stable prompt prefix does not match the code-owned template");
  });

  it("rejects a missing, shifted, or user-derived boundary", () => {
    const prompt = buildPolishPromptBlocks(makeInput());

    expect(() =>
      resolvePromptCachePolicy({
        cachePolicyId: "deepseek_automatic_context_cache_v1",
        profileVersionId: PROFILE_VERSION_ID,
        language: "zh",
        prompt: { blocks: prompt.blocks },
      }),
    ).toThrow("cache boundary must follow the final stable prompt block");
    expect(() =>
      resolvePromptCachePolicy({
        cachePolicyId: "deepseek_automatic_context_cache_v1",
        profileVersionId: PROFILE_VERSION_ID,
        language: "zh",
        prompt: { ...prompt, explicitCacheBoundaryAfter: prompt.blocks[1].id },
      }),
    ).toThrow("cache boundary must follow the final stable prompt block");
  });

  it("rejects a non-profile UUID instead of admitting arbitrary key material", () => {
    const prompt = buildPolishPromptBlocks(makeInput());
    expect(() =>
      resolvePromptCachePolicy({
        cachePolicyId: "deepseek_automatic_context_cache_v1",
        profileVersionId: "private-user-id",
        language: "zh",
        prompt,
      }),
    ).toThrow(PromptCachePolicyError);
  });

  it("canonicalizes a profile UUID before using it as key material", () => {
    const input = makeInput();
    const decision = resolvePromptCachePolicy({
      cachePolicyId: "deepseek_automatic_context_cache_v1",
      profileVersionId: PROFILE_VERSION_ID.toUpperCase(),
      language: input.language,
      prompt: buildPolishPromptBlocks(input),
    });

    expect(decision.cacheKeyMaterial.profileVersionId).toBe(PROFILE_VERSION_ID);
  });

  it("binds the stable template to the declared locale", () => {
    expect(() =>
      resolvePromptCachePolicy({
        cachePolicyId: "mimo_automatic_prompt_cache_v1",
        profileVersionId: PROFILE_VERSION_ID,
        language: "en",
        prompt: buildPolishPromptBlocks(makeInput({ language: "zh" })),
      }),
    ).toThrow("stable prompt prefix does not match the code-owned template");
  });
});
