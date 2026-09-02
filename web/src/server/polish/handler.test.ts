/**
 * Refuse-to-start tests for the live route wiring (unit 2.3).
 *
 * handler.ts resolves every production dependency AT MODULE SCOPE: importing
 * it with an invalid configuration must throw (failing `next build` /
 * `next start` / the first request) instead of serving degraded requests.
 * Each case re-imports the module fresh with a controlled environment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  polishAvailabilityResponseSchema,
  polishErrorResponseSchema,
} from "@/lib/polish/contract";
import { FAKE_V2_EXPECTED_ROUTE, FAKE_V2_POLICY_VERSION_ID } from "./backend-fake";

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

type HandlerModule = Awaited<ReturnType<typeof importHandler>>;

async function expectDeploymentDisabled({
  POST,
  GET,
  AVAILABILITY_GET,
}: HandlerModule): Promise<void> {
  const routes = [
    [
      "POST",
      () =>
        POST(
          new Request("https://test.local/api/polish", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        ),
    ],
    ["quota", () => GET(new Request("https://test.local/api/polish/quota"))],
    [
      "availability",
      () => AVAILABILITY_GET(new Request("https://test.local/api/polish/availability")),
    ],
  ] as const;

  for (const [label, call] of routes) {
    const response = await call();
    const body = polishErrorResponseSchema.parse(await response.json());
    expect(response.status, label).toBe(503);
    expect(response.headers.get("cache-control"), label).toContain("no-store");
    expect(response.headers.get("x-request-id"), label).toBe(body.requestId);
    expect(response.headers.get("retry-after"), label).toBe("300");
    expect(body.error.code, label).toBe("AI_DISABLED");
  }
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
  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["false", "false"],
    ["uppercase", "TRUE"],
    ["numeric", "1"],
  ] as const)(
    "blocks every real route before auth when the deployment flag is %s",
    async (_label, value) => {
      const handlers = await importHandler({
        NODE_ENV: "production",
        AI_POLISH_ENABLED: value,
      });
      await expectDeploymentDisabled(handlers);
    },
  );

  it("throws on import with POLISH_FAKE_LLM=true in production without the CI marker", async () => {
    await expect(
      importHandler({
        POLISH_FAKE_LLM: "true",
        NODE_ENV: "production",
        CI: undefined,
        AI_POLISH_ENABLED: "true",
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it("throws on import when POLISH_FAKE_BACKEND=true without POLISH_FAKE_LLM", async () => {
    await expect(
      importHandler({
        POLISH_FAKE_BACKEND: "true",
        POLISH_FAKE_LLM: undefined,
        NODE_ENV: "development",
        AI_POLISH_ENABLED: "true",
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
    const { POST, GET, AVAILABILITY_GET } = await importHandler(FAKE_SMOKE_ENV);
    expect(typeof POST).toBe("function");
    expect(typeof GET).toBe("function");
    expect(typeof AVAILABILITY_GET).toBe("function");

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
          expectedRoute: FAKE_V2_EXPECTED_ROUTE,
        }),
      }),
    );
    expect(polish.status).toBe(200);
    const body = (await polish.json()) as { requestId: string };
    expect(polish.headers.get("x-request-id")).toBe(body.requestId);

    const routeChanged = await POST(
      new Request("https://test.local/api/polish", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer ci-smoke-token",
        },
        body: JSON.stringify({
          clientRequestId: "123e4567-e89b-42d3-a456-426614174001",
          granularity: "item",
          sectionId: "experience",
          language: "zh",
          items: [
            { id: "i0", kind: "experience_bullet", text: "负责后端服务开发。" },
          ],
          context: { level: 0, references: [] },
          expectedRoute: { ...FAKE_V2_EXPECTED_ROUTE, configGeneration: "1" },
        }),
      }),
    );
    expect(routeChanged.status).toBe(409);
    expect(
      polishErrorResponseSchema.parse(await routeChanged.json()).error.code,
    ).toBe("AI_ROUTE_CHANGED");

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

    const availability = await AVAILABILITY_GET(
      new Request("https://test.local/api/polish/availability", {
        headers: { authorization: "Bearer ci-smoke-token" },
      }),
    );
    expect(availability.status).toBe(200);
    const availabilityBody = await availability.json();
    expect(polishAvailabilityResponseSchema.safeParse(availabilityBody).success).toBe(true);
    expect(availabilityBody).toMatchObject({
      availability: {
        enabled: true,
        configGeneration: FAKE_V2_EXPECTED_ROUTE.configGeneration,
        routingPolicyVersionId: FAKE_V2_POLICY_VERSION_ID,
        profileVersionId: FAKE_V2_EXPECTED_ROUTE.profileVersionId,
        legalBundleVersion: FAKE_V2_EXPECTED_ROUTE.legalBundleVersion,
        runtimeContractId: FAKE_V2_EXPECTED_ROUTE.runtimeContractId,
        runtimeContractSha256: FAKE_V2_EXPECTED_ROUTE.runtimeContractSha256,
        displayDisclosure: {
          key: "deepseek-official-v1",
          providerName: "DeepSeek",
          modelName: "DeepSeek V4 Flash",
        },
        termsAccepted: true,
      },
    });
  });

  it("real provider + real backend boots with complete env", async () => {
    const { POST, GET, AVAILABILITY_GET } = await importHandler({
      NODE_ENV: "production",
      DEEPSEEK_API_KEY: "key",
      AI_POLISH_ENABLED: "true",
      AI_USER_ID_HMAC_SECRET: "secret",
      ...SUPABASE_ENV,
    });
    expect(typeof POST).toBe("function");
    expect(typeof GET).toBe("function");
    expect(typeof AVAILABILITY_GET).toBe("function");
    const quotaWithoutToken = await GET(
      new Request("https://test.local/api/polish/quota"),
    );
    expect(quotaWithoutToken.status).toBe(401);
    const postWithoutToken = await POST(
      new Request("https://test.local/api/polish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(postWithoutToken.status).toBe(401);
    const availabilityWithoutToken = await AVAILABILITY_GET(
      new Request("https://test.local/api/polish/availability"),
    );
    expect(availabilityWithoutToken.status).toBe(401);
  });

  it.each([
    ["development", undefined],
    ["production", "true"],
  ] as const)(
    "rejects fake inference with a real backend in %s/CI=%s",
    async (nodeEnv, ci) => {
      await expect(
        importHandler({
          NODE_ENV: nodeEnv,
          CI: ci,
          POLISH_FAKE_LLM: "true",
          POLISH_FAKE_BACKEND: undefined,
          AI_POLISH_ENABLED: "true",
          AI_USER_ID_HMAC_SECRET: "secret",
          DEEPSEEK_API_KEY: undefined,
          ...SUPABASE_ENV,
        }),
      ).rejects.toThrow(/requires POLISH_FAKE_BACKEND=true/);
    },
  );

  it("gives the fake backend the same pre-auth deployment gate", async () => {
    const handlers = await importHandler({
      ...FAKE_SMOKE_ENV,
      AI_POLISH_ENABLED: "false",
    });
    await expectDeploymentDisabled(handlers);
  });
});
