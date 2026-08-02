import { afterEach, describe, expect, it, vi } from "vitest";
import { getPolishProvider } from "./provider";

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
      { messages: [{ role: "user", content: '{"id":"k1","text":"x"}' }], maxOutputTokens: 100 },
      { signal: new AbortController().signal, timeoutMs: 500 },
    );
    expect(JSON.parse(result.text)).toEqual({
      items: [{ id: "k1", polished: "[FAKE] polished k1" }],
    });
  });

  it("throws when no provider is configured (real provider not wired yet)", () => {
    expect(() =>
      getPolishProvider({ POLISH_FAKE_LLM: undefined, NODE_ENV: "development" }),
    ).toThrow(/wired yet/);
    expect(() => getPolishProvider({ POLISH_FAKE_LLM: "false", NODE_ENV: "test" })).toThrow(
      /wired yet/,
    );
  });

  it("refuses to start with POLISH_FAKE_LLM=true in production", () => {
    expect(() =>
      getPolishProvider({ POLISH_FAKE_LLM: "true", NODE_ENV: "production" }),
    ).toThrow(/Refusing to start/);
  });
});
