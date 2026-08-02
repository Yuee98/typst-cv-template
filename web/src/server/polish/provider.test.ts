import { afterEach, describe, expect, it, vi } from "vitest";
import { getPolishProvider, PolishProviderError } from "./provider";

describe("getPolishProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the fake provider when POLISH_FAKE_LLM=true outside production", () => {
    const provider = getPolishProvider({ POLISH_FAKE_LLM: "true", NODE_ENV: "development" });
    expect(typeof provider.complete).toBe("function");
  });

  it("reads process.env by default and returns a working fake", async () => {
    vi.stubEnv("POLISH_FAKE_LLM", "true");
    const provider = getPolishProvider();
    const result = await provider.complete(
      {
        messages: [{ role: "user", content: "polish please" }],
        maxOutputTokens: 100,
        providerUserId: "hmac-sha256-hex-pseudonymous-id",
        targets: [{ id: "k1", text: "原始文本 k1" }],
      },
      { signal: new AbortController().signal, timeoutMs: 500 },
    );
    expect(JSON.parse(result.text)).toEqual({
      items: [{ id: "k1", polished: "原始文本 k1" }],
    });
  });

  it("throws when the real provider is misconfigured (missing DEEPSEEK_API_KEY)", () => {
    const base = { AI_USER_ID_HMAC_SECRET: "s" };
    const options = { userId: "u" };
    expect(() =>
      getPolishProvider({ ...base, POLISH_FAKE_LLM: undefined, NODE_ENV: "development" }, options),
    ).toThrow(/DEEPSEEK_API_KEY/);
    expect(() =>
      getPolishProvider({ ...base, POLISH_FAKE_LLM: "false", NODE_ENV: "test" }, options),
    ).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("returns the DeepSeek provider for a non-fake configuration", () => {
    const provider = getPolishProvider(
      {
        NODE_ENV: "production",
        DEEPSEEK_API_KEY: "k",
        AI_USER_ID_HMAC_SECRET: "s",
      },
      { userId: "u" },
    );
    expect(typeof provider.complete).toBe("function");
  });

  it("refuses to start with POLISH_FAKE_LLM=true in production", () => {
    expect(() =>
      getPolishProvider({ POLISH_FAKE_LLM: "true", NODE_ENV: "production" }),
    ).toThrow(/Refusing to start/);
  });
});

describe("PolishProviderError", () => {
  it("carries optional structured metadata (providerRequestId, upstreamStatus)", () => {
    const error = new PolishProviderError("UPSTREAM_ERROR", "upstream HTTP failure", {
      providerRequestId: "req-abc",
      upstreamStatus: 503,
    });
    expect(error.name).toBe("PolishProviderError");
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.providerRequestId).toBe("req-abc");
    expect(error.upstreamStatus).toBe(503);
  });

  it("leaves metadata undefined when not provided", () => {
    const error = new PolishProviderError("UPSTREAM_TIMEOUT", "hard timeout");
    expect(error.providerRequestId).toBeUndefined();
    expect(error.upstreamStatus).toBeUndefined();
  });
});
