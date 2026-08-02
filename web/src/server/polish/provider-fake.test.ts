import { afterEach, describe, expect, it, vi } from "vitest";
import { PolishProviderError, type PolishProviderRequest } from "./provider";
import {
  createFakePolishProvider,
  DEFAULT_FAKE_DELAY_MS,
  FAKE_PROVIDER_CODEWORDS,
  FAKE_SLOW_EXTRA_DELAY_MS,
} from "./provider-fake";

function makeRequest(userContent: string): PolishProviderRequest {
  return {
    messages: [
      { role: "system", content: "You polish resume text." },
      { role: "user", content: userContent },
    ],
    maxOutputTokens: 1024,
  };
}

function callOptions(timeoutMs = 1000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakePolishProvider — deterministic output", () => {
  it("returns parseable JSON echoing the item ids embedded in the request", async () => {
    const provider = createFakePolishProvider();
    const request = makeRequest(
      'items: {"id":"b1","kind":"experience_bullet","text":"x"} {"id":"a2","kind":"experience_bullet","text":"y"}',
    );

    const first = await provider.complete(request, callOptions());
    const second = await provider.complete(request, callOptions());
    expect(second).toEqual(first);

    const parsed = JSON.parse(first.text) as { items: { id: string; polished: string }[] };
    expect(parsed.items.map((item) => item.id)).toEqual(["b1", "a2"]);
    for (const item of parsed.items) {
      expect(item.polished.length).toBeGreaterThan(0);
    }
    expect(first.finishReason).toBe("stop");
    expect(first.usage.promptTokens).toBeGreaterThan(0);
    expect(first.usage.uncachedReadTokens).toBe(first.usage.promptTokens);
    expect(first.usage.cachedReadTokens).toBe(0);
  });

  it("echoes each embedded id only once", async () => {
    const provider = createFakePolishProvider();
    const result = await provider.complete(
      makeRequest('{"id":"b1","text":"x"} {"id":"b1","text":"x"}'),
      callOptions(),
    );
    const parsed = JSON.parse(result.text) as { items: { id: string }[] };
    expect(parsed.items.map((item) => item.id)).toEqual(["b1"]);
  });

  it("falls back to a generic placeholder id when the request has no id fragment", async () => {
    const provider = createFakePolishProvider();
    const result = await provider.complete(makeRequest("no ids here"), callOptions());
    const parsed = JSON.parse(result.text) as { items: { id: string; polished: string }[] };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe("i0");
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

  it("SLOW resolves only after timeoutMs + extra delay", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const timeoutMs = 50;
    const promise = provider.complete(
      makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.slow}`),
      callOptions(timeoutMs),
    );
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Past timeoutMs but before the slow delay elapses: still pending.
    await vi.advanceTimersByTimeAsync(timeoutMs + 10);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(FAKE_SLOW_EXTRA_DELAY_MS);
    expect(settled).toBe(true);
    await expect(promise).resolves.toMatchObject({ finishReason: "stop" });
  });

  it("SLOW wait is interrupted by signal abort (rejects with AbortError)", async () => {
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
  });
});

describe("createFakePolishProvider — cancellation", () => {
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
