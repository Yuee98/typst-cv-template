import { describe, it, expect, vi } from "vitest";
import { fixtureExecutionConfiguration, fixturePrice } from "./fixtures";
import { ADAPTERS, prepareProvider, validateExecutionConfiguration } from "./provider";
import { priceSchema, usageForDatabase } from "./accounting";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";
import type { PolishInferenceRequest } from "./inference";
const env = { AI_PROVIDER_KEY_FIXTURE_1: "not-a-real-key", AI_PROVIDER_KEY_FIXTURE_2: "not-a-real-key", AI_PROVIDER_KEY_FIXTURE_3: "not-a-real-key" };
const request: PolishInferenceRequest = {
  schemaVersion: "polish_inference_request", prompt: { blocks: [
    { id: POLISH_STABLE_PROMPT_BLOCK_ID, role: "developer", stability: "stable", content: "Return JSON." },
    { id: POLISH_VARIABLE_PROMPT_BLOCK_ID, role: "user", stability: "variable", content: "User" }
  ], explicitCacheBoundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID },
  outputContract: { kind: "json_object", schemaName: "polish_items_v1", schema: {} },
  providerSubjectId: "a".repeat(64), maxOutputTokens: 100,
  promptVersion: "x", validatorVersion: "x", language: "en", targets: []
};
const run = (provider: ReturnType<typeof prepareProvider>) => provider.complete(request, { signal: new AbortController().signal, timeoutMs: 1000 });
describe("code-owned adapters and editable connections", () => {
  it.each([1, 2, 3])("accepts adapter %s with a database model and independent supplier", index => {
    const configuration = { ...fixtureExecutionConfiguration(index), endpoint_url: "https://relay.example/custom-api", credential_ref: "AI_PROVIDER_KEY_RESELLER" };
    expect(validateExecutionConfiguration(configuration, { AI_PROVIDER_KEY_RESELLER: "key" })).toEqual(configuration);
    expect(ADAPTERS[index as 1 | 2 | 3].executionContract).toBe(configuration.execution_contract);
  });
  it.each([1, 2, 3])("rejects a changed execution contract for adapter %s before sending", index => {
    const fetch = vi.fn();
    expect(() => prepareProvider({ ...fixtureExecutionConfiguration(index), execution_contract: "unrecognized-contract" }, env, fetch)).toThrow("contract");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects an unknown adapter instead of selecting a fallback", () => expect(() => prepareProvider({ ...fixtureExecutionConfiguration(), adapter_id: 4 }, env)).toThrow());
  it.each(["SUPABASE_SERVICE_ROLE_KEY", "AWS_SECRET_ACCESS_KEY", "AI_PROVIDER_KEY_", "AI_PROVIDER_KEY_wrong"])("rejects unrelated credential reference %s", credential_ref => expect(() => prepareProvider({ ...fixtureExecutionConfiguration(), credential_ref }, { [credential_ref]: "secret" })).toThrow());
  it("requires only the selected AI secret", () => {
    expect(() => prepareProvider(fixtureExecutionConfiguration(), { AI_PROVIDER_KEY_FIXTURE_1: "key" })).not.toThrow();
    expect(() => prepareProvider(fixtureExecutionConfiguration(), {})).toThrow("credential");
  });
  it("rejects extra runtime parameters instead of silently changing semantics", () => expect(() => prepareProvider({ ...fixtureExecutionConfiguration(), unexpected_parameter: true }, env)).toThrow());
  it.each([[1, "Authorization", "Bearer not-a-real-key"], [2, "api-key", "not-a-real-key"], [3, "x-goog-api-key", "not-a-real-key"]] as const)("selects protocol/authentication for adapter %s", async (index, header, value) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 302 }));
    const configuration = { ...fixtureExecutionConfiguration(index), endpoint_url: "https://relay.example/custom-api" };
    await expect(run(prepareProvider(configuration, env, fetch))).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(configuration.endpoint_url);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get(header)).toBe(value);
    expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.model).toBe(configuration.model_id);
    if (index === 1) expect(body.user).toBe(request.providerSubjectId);
    else expect(body).not.toHaveProperty("user");
  });
  it("captures key bytes once while new preparations use the rotated environment value", async () => {
    const selected = { AI_PROVIDER_KEY_FIXTURE_1: "old-key" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 401 }));
    const prepared = prepareProvider(fixtureExecutionConfiguration(), selected, fetch);
    selected.AI_PROVIDER_KEY_FIXTURE_1 = "new-key";
    await expect(run(prepared)).rejects.toThrow();
    await expect(run(prepared)).rejects.toThrow();
    await expect(run(prepareProvider(fixtureExecutionConfiguration(), selected, fetch))).rejects.toThrow();
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer old-key", "Bearer old-key", "Bearer new-key"]);
  });
});
describe("database-only accounting boundary", () => {
  it("requires four explicit nonnegative integer rates", () => {
    expect(priceSchema.parse(fixturePrice)).toEqual(fixturePrice);
    for (const field of ["input_standard_nanos_per_million", "input_cache_read_nanos_per_million", "input_cache_write_nanos_per_million", "output_nanos_per_million"]) {
      for (const value of [undefined, null, -1, 0, "-1", "01", "1.5", "9223372036854775808"]) expect(() => priceSchema.parse({ ...fixturePrice, [field]: value })).toThrow();
    }
  });
  it("serializes known token facts without pricing or adding reasoning again", () => {
    expect(usageForDatabase({ schemaVersion: "normalized_usage", inputTotalTokens: 3, inputStandardTokens: 2, inputCacheReadTokens: 1, inputCacheWriteTokens: null, outputTokens: 4, reasoningTokens: 2, cacheUsageReporting: "unavailable", usageComplete: true })).toEqual({ input_total: "3", input_standard: "2", cache_read: "1", cache_write: null, output: "4", reasoning: "2" });
  });
  it("preserves unknown usage instead of manufacturing zero facts", () => expect(usageForDatabase(null)).toEqual({ input_total: null, input_standard: null, cache_read: null, cache_write: null, output: null, reasoning: null }));
});
