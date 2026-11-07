import { describe, it, expect, vi } from "vitest";
import { fixtureProfile } from "./fixtures";
import { prepareProvider, validateProviderConfiguration } from "./provider";
import { calculateCost } from "./accounting";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";
const env = {
  AI_PROVIDER_KEY_DEEPSEEK_LOCAL: "not-a-real-key",
  AI_PROVIDER_KEY_MIMO_LOCAL: "not-a-real-key",
  AI_PROVIDER_KEY_GEMINI_LOCAL: "not-a-real-key"
};
describe("prepared official providers", () => {
  it.each([1, 2, 3])("supports code-owned protocol %s with database model", index => {
    expect(validateProviderConfiguration(fixtureProfile(index), env).model_id).toBe(`fixture-model-${index}`);
  });
  it.each(["http://api.deepseek.com/responses", "https://127.0.0.1/responses", "https://api.deepseek.com/responses?key=x", "https://api.deepseek.com:444/responses", "https://x@api.deepseek.com/responses", "https://api.deepseek.com/chat/completions"])("rejects unsupported target %s", endpoint_url => {
    expect(() => prepareProvider({
      ...fixtureProfile(),
      endpoint_url
    }, env)).toThrow();
  });
  it("rejects cross-provider credentials, missing selected secrets and unknown semantics", () => {
    expect(() => prepareProvider({
      ...fixtureProfile(),
      credential_ref: "AI_PROVIDER_KEY_MIMO_LOCAL"
    }, env)).toThrow();
    expect(() => prepareProvider(fixtureProfile(), {})).toThrow();
    const p = fixtureProfile();
    expect(() => prepareProvider({
      ...p,
      capability: {
        ...p.capability,
        execution_contract: "unknown"
      }
    }, env)).toThrow();
  });
  it("does not require an unselected provider credential", () => expect(() => prepareProvider(fixtureProfile(), {
    AI_PROVIDER_KEY_DEEPSEEK_LOCAL: "local"
  })).not.toThrow());
  it.each([
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    "https://generativelanguage.googleapis.com/v1/responses",
    "https://generativelanguage.googleapis.com/v1/interactions?key=unsafe",
    "https://127.0.0.1/v1/interactions"
  ])("rejects unsupported Gemini target %s", endpoint_url => {
    expect(() => prepareProvider({ ...fixtureProfile(3), endpoint_url }, env)).toThrow();
  });
  it.each([
    { store: true }, { background: true }, { thinkingLevel: "minimal" }, { sendProviderSubjectId: true }, { structuredOutput: "prompt_only" }, { previous_interaction_id: "prior" }
  ])("rejects Gemini parameter changes outside the compiled contract: %j", change => {
    const profile = fixtureProfile(3), fetchImpl = vi.fn();
    expect(() => prepareProvider({ ...profile, adapter_config: { ...profile.adapter_config, ...change } }, env, fetchImpl)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("sends exact configured model and rejects redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", {
      status: 302
    }));
    const provider = prepareProvider(fixtureProfile(), env, fetchImpl);
    await expect(provider.complete({
      schemaVersion: "polish_inference_request",
      prompt: {
        blocks: [{
          id: POLISH_STABLE_PROMPT_BLOCK_ID,
          role: "developer",
          stability: "stable",
          content: "Return JSON."
        }, {
          id: POLISH_VARIABLE_PROMPT_BLOCK_ID,
          role: "user",
          stability: "variable",
          content: "User"
        }],
        explicitCacheBoundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID
      },
      outputContract: {
        kind: "json_object",
        schemaName: "polish_items_v1",
        schema: {}
      },
      providerSubjectId: "a".repeat(64),
      maxOutputTokens: 100,
      promptVersion: "x",
      validatorVersion: "x",
      language: "en",
      targets: []
    }, {
      signal: new AbortController().signal,
      timeoutMs: 1000
    })).rejects.toThrow();
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      redirect: "error"
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.model).toBe("fixture-model-1");
    expect(body.user).toBe("a".repeat(64));
    expect(body.reasoning).toEqual({
      effort: "none"
    });
    expect(body.text).toEqual({
      format: {
        type: "json_object"
      }
    });
    expect(body).not.toHaveProperty("user_id");
  });
  it("rejects obsolete capability and adapter parameters before transmission", () => {
    const profile = fixtureProfile();
    const fetchImpl = vi.fn();
    for (const capability of [{
      ...profile.capability,
      code: "DEEPSEEK_CHAT"
    }, {
      ...profile.capability,
      adapter_kind: "deepseek_chat_v1"
    }, {
      ...profile.capability,
      wire_api_kind: "chat_completions_v1"
    }]) expect(() => prepareProvider({
      ...profile,
      capability
    }, env, fetchImpl)).toThrow();
    expect(() => prepareProvider({
      ...profile,
      adapter_config: {
        thinking: "disabled",
        structuredOutput: "json_object",
        providerSubjectField: "user_id"
      }
    }, env, fetchImpl)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
describe("exact native currency costs", () => {
  const usage = {
    schemaVersion: "normalized_usage" as const,
    inputTotalTokens: 3,
    inputCacheReadTokens: 1,
    inputCacheWriteTokens: null,
    inputStandardTokens: 2,
    outputTokens: 4,
    reasoningTokens: 2,
    cacheUsageReporting: "unavailable" as const,
    usageComplete: true
  };
  const price = {
    currency: "CNY",
    calculator_kind: "linear_token_v1" as const,
    parameters: {},
    components: {
      INPUT_STANDARD: "1000000",
      INPUT_CACHE_READ: "100000",
      INPUT_CACHE_WRITE: "0",
      OUTPUT: "2000000"
    }
  };
  it("counts cache and reasoning exactly once and rounds only aggregate", () => expect(calculateCost(usage, price)).toEqual({
    estimated: "11",
    known: "11",
    reasons: []
  }));
  it("preserves lower bound if cache-write usage is unknown", () => expect(calculateCost(usage, {
    ...price,
    components: {
      ...price.components,
      INPUT_CACHE_WRITE: "1"
    }
  })).toMatchObject({
    estimated: null,
    known: "11"
  }));
  it("does not truncate bigint overflow", () => expect(calculateCost({
    ...usage,
    inputTotalTokens: Number.MAX_SAFE_INTEGER,
    inputStandardTokens: Number.MAX_SAFE_INTEGER - 1
  }, {
    ...price,
    components: {
      ...price.components,
      INPUT_STANDARD: "9223372036854775807"
    }
  })).toMatchObject({
    estimated: null,
    reasons: ["COST_OVERFLOW"]
  }));
});
describe("compiled capability identity", () => {
  it("rejects a descriptor digest mismatch even when semantic fields still match", () => {
    const profile = fixtureProfile();
    const fetchImpl = vi.fn();
    expect(() => prepareProvider({
      ...profile,
      capability: {
        ...profile.capability,
        descriptor_digest: "0".repeat(64)
      }
    }, env, fetchImpl)).toThrow("descriptor digest");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
