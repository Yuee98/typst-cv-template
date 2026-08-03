import { afterEach, describe, expect, it, vi } from "vitest";
import { PolishProviderError, type PolishProviderRequest } from "./provider";
import {
  createFakePolishProvider,
  DEFAULT_FAKE_DELAY_MS,
  FAKE_PROVIDER_CODEWORDS,
  FAKE_SLOW_EXTRA_DELAY_MS,
} from "./provider-fake";

const DEFAULT_TARGETS = [{ id: "i0", text: "原始文本 i0，含 40% 与 v1.4。" }] as const;

function makeRequest(
  userContent: string,
  targets: ReadonlyArray<{ id: string; text: string }> = DEFAULT_TARGETS,
): PolishProviderRequest {
  return {
    messages: [
      { role: "system", content: "You polish resume text." },
      { role: "user", content: userContent },
    ],
    maxOutputTokens: 1024,
    providerUserId: "hmac-sha256-hex-pseudonymous-id",
    targets,
  };
}

function callOptions(timeoutMs = 1000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakePolishProvider — deterministic output", () => {
  it("echoes each target's original text unchanged, in order", async () => {
    const provider = createFakePolishProvider();
    const targets = [
      { id: "b1", text: "负责后端服务开发，将接口 P99 延迟降低 40%。" },
      { id: "a2", text: "Built the .NET billing pipeline (v1.4)." },
    ];
    const request = makeRequest("polish these items", targets);

    const first = await provider.complete(request, callOptions());
    const second = await provider.complete(request, callOptions());
    expect(second).toEqual(first);

    // Unchanged originals always survive the language / protected-span /
    // length validation pipeline.
    const parsed = JSON.parse(first.text) as { items: { id: string; polished: string }[] };
    expect(parsed.items).toEqual(targets.map((target) => ({ id: target.id, polished: target.text })));
    expect(first.finishReason).toBe("stop");
    expect(first.usage.promptTokens).toBeGreaterThan(0);
    expect(first.usage.uncachedReadTokens).toBe(first.usage.promptTokens);
    expect(first.usage.cachedReadTokens).toBe(0);
  });

  it("takes ids and texts from structured targets, never from the prompt strings", async () => {
    const provider = createFakePolishProvider();
    // The prompt content contains look-alike id fragments that must NOT leak
    // into the output.
    const result = await provider.complete(
      makeRequest('items: {"id":"zz","text":"decoy"}', [{ id: "k1", text: "真正的原文。" }]),
      callOptions(),
    );
    const parsed = JSON.parse(result.text) as { items: { id: string; polished: string }[] };
    expect(parsed.items).toEqual([{ id: "k1", polished: "真正的原文。" }]);
  });

  it("returns an empty items array when targets is empty", async () => {
    const provider = createFakePolishProvider();
    const result = await provider.complete(makeRequest("no targets", []), callOptions());
    expect(JSON.parse(result.text)).toEqual({ items: [] });
  });
});

describe("createFakePolishProvider — codewords", () => {
  it("FAIL_UPSTREAM rejects with PolishProviderError(UPSTREAM_ERROR)", async () => {
    const provider = createFakePolishProvider();
    const promise = provider.complete(
      makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.failUpstream}`),
      callOptions(),
    );
    await expect(promise).rejects.toBeInstanceOf(PolishProviderError);
    await expect(promise).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_ERROR",
    });
  });

  it("FAIL_JSON resolves with text that is not parseable JSON", async () => {
    const provider = createFakePolishProvider();
    const result = await provider.complete(
      makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.failJson}`),
      callOptions(),
    );
    expect(result.finishReason).toBe("stop");
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it("SLOW rejects with PolishProviderError(UPSTREAM_TIMEOUT) at the fake's own timeoutMs", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const timeoutMs = 50;
    const promise = provider.complete(
      makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.slow}`),
      callOptions(timeoutMs),
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_TIMEOUT",
    });

    // Past timeoutMs the fake's own timeout must fire even though the
    // simulated latency (timeoutMs + extra) has not elapsed.
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(PolishProviderError);
  });
});

describe("createFakePolishProvider — timeout ownership", () => {
  it("enforces timeoutMs as a hard bound on the normal path (no SLOW codeword)", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const timeoutMs = DEFAULT_FAKE_DELAY_MS - 1;
    const promise = provider.complete(makeRequest("normal"), callOptions(timeoutMs));
    const assertion = expect(promise).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_FAKE_DELAY_MS + FAKE_SLOW_EXTRA_DELAY_MS);
    await assertion;
  });

  it("caller abort rejects with AbortError, not UPSTREAM_TIMEOUT", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const controller = new AbortController();
    const promise = provider.complete(makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.slow}`), {
      signal: controller.signal,
      timeoutMs: 50,
    });
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    // Ownership matters: a caller abort must not be normalized into a
    // provider transport error.
    await expect(promise).rejects.not.toBeInstanceOf(PolishProviderError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const provider = createFakePolishProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete(makeRequest("anything"), {
        signal: controller.signal,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createFakePolishProvider — simulated latency", () => {
  it("honors the configured default delay", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const promise = provider.complete(makeRequest("normal"), callOptions());
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_FAKE_DELAY_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(promise).resolves.toMatchObject({ finishReason: "stop" });
  });
});
