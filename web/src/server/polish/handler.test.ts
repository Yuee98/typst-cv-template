/**
 * Refuse-to-start tests for the live route wiring (unit 2.3).
 *
 * handler.ts resolves every production dependency AT MODULE SCOPE: importing
 * it with an invalid configuration must throw (failing `next build` /
 * `next start` / the first request) instead of serving degraded requests.
 * Each case re-imports the module fresh with a controlled environment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "POLISH_FAKE_LLM",
  "POLISH_FAKE_BACKEND",
  "NODE_ENV",
  "CI",
  "AI_POLISH_ENABLED",
  "DEEPSEEK_API_KEY",
  "AI_USER_ID_HMAC_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/** Imports handler.ts fresh with exactly the given environment. */
async function importHandler(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, env[key]);
  }
  return import("./handler");
}

const SUPABASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

const FAKE_SMOKE_ENV = {
  POLISH_FAKE_LLM: "true",
  POLISH_FAKE_BACKEND: "true",
  AI_POLISH_ENABLED: "true",
  NODE_ENV: "production",
  CI: "true",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handler.ts — refuse-to-start on misconfiguration", () => {
  it("throws on import when the real provider has no DEEPSEEK_API_KEY", async () => {
    await expect(
      importHandler({
        NODE_ENV: "production",
        AI_POLISH_ENABLED: "true",
        AI_USER_ID_HMAC_SECRET: "secret",
        ...SUPABASE_ENV,
      }),
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);
  });

  it("throws on import with POLISH_FAKE_LLM=true in production without the CI marker", async () => {
    await expect(
      importHandler({
        POLISH_FAKE_LLM: "true",
        NODE_ENV: "production",
        CI: undefined,
        AI_POLISH_ENABLED: "true",
      }),
    ).rejects.toThrow(/Refusing to start/);
  });

  it("throws on import when POLISH_FAKE_BACKEND=true without POLISH_FAKE_LLM", async () => {
    await expect(
      importHandler({
        POLISH_FAKE_BACKEND: "true",
        POLISH_FAKE_LLM: undefined,
        NODE_ENV: "development",
        DEEPSEEK_API_KEY: "key",
        AI_USER_ID_HMAC_SECRET: "secret",
        ...SUPABASE_ENV,
      }),
    ).rejects.toThrow(/POLISH_FAKE_LLM/);
  });

  it("throws on import when the real backend lacks Supabase env", async () => {
    await expect(
      importHandler({
        NODE_ENV: "production",
        DEEPSEEK_API_KEY: "key",
        AI_POLISH_ENABLED: "true",
        AI_USER_ID_HMAC_SECRET: "secret",
        NEXT_PUBLIC_SUPABASE_URL: undefined,
      }),
    ).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws on import when the real backend lacks SUPABASE_SERVICE_ROLE_KEY", async () => {
    await expect(
      importHandler({
        NODE_ENV: "production",
        DEEPSEEK_API_KEY: "key",
        AI_POLISH_ENABLED: "true",
        AI_USER_ID_HMAC_SECRET: "secret",
        ...SUPABASE_ENV,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      }),
    ).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("throws on import when the real backend lacks AI_USER_ID_HMAC_SECRET", async () => {
    await expect(
      importHandler({
        NODE_ENV: "production",
        DEEPSEEK_API_KEY: "key",
        AI_POLISH_ENABLED: "true",
        ...SUPABASE_ENV,
        AI_USER_ID_HMAC_SECRET: undefined,
      }),
    ).rejects.toThrow(/AI_USER_ID_HMAC_SECRET/);
  });
});

describe("handler.ts — valid configurations boot", () => {
  it("fake smoke mode (CI marker) boots and serves the full lifecycle", async () => {
    const { POST, GET } = await importHandler(FAKE_SMOKE_ENV);
    expect(typeof POST).toBe("function");
    expect(typeof GET).toBe("function");

    // Full chain through the fake backend: auth → reserve → fake LLM →
    // finalize → 200 with the frozen response shape.
    const polish = await POST(
      new Request("https://test.local/api/polish", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer ci-smoke-token",
        },
        body: JSON.stringify({
          clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
          granularity: "group",
          sectionId: "experience",
          language: "zh",
          items: [
            { id: "i0", kind: "experience_bullet", text: "负责后端服务开发，将 P99 延迟降低 40%。" },
            { id: "i1", kind: "experience_bullet", text: "建设内部平台，将部署时间缩短 30%。" },
          ],
          context: { level: 0, references: [] },
        }),
      }),
    );
    expect(polish.status).toBe(200);
    const body = (await polish.json()) as { requestId: string };
    expect(polish.headers.get("x-request-id")).toBe(body.requestId);

    const noToken = await POST(
      new Request("https://test.local/api/polish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(noToken.status).toBe(401);

    const quota = await GET(
      new Request("https://test.local/api/polish/quota", {
        headers: { authorization: "Bearer ci-smoke-token" },
      }),
    );
    expect(quota.status).toBe(200);
  });

  it("real provider + real backend boots with complete env", async () => {
    const { POST, GET } = await importHandler({
      NODE_ENV: "production",
      DEEPSEEK_API_KEY: "key",
      AI_POLISH_ENABLED: "true",
      AI_USER_ID_HMAC_SECRET: "secret",
      ...SUPABASE_ENV,
    });
    expect(typeof POST).toBe("function");
    expect(typeof GET).toBe("function");
  });

  it("local dev mode (fake LLM + real backend) boots without DEEPSEEK_API_KEY", async () => {
    const { POST } = await importHandler({
      NODE_ENV: "development",
      POLISH_FAKE_LLM: "true",
      AI_POLISH_ENABLED: "true",
      AI_USER_ID_HMAC_SECRET: "secret",
      ...SUPABASE_ENV,
    });
    expect(typeof POST).toBe("function");
  });
});
