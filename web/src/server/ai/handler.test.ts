import { describe, it, expect, afterEach, vi } from "vitest";
import { polishExpectedRouteFromAvailability, polishAvailabilityResponseSchema } from "@/lib/polish/contract";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
describe("current HTTP runtime", () => {
  it("does not initialize auth or DB when deployment gate is disabled", async () => {
    vi.stubEnv("AI_POLISH_ENABLED", "false");
    const h = await import("../polish/handler");
    for (const method of [h.POST, h.GET, h.AVAILABILITY_GET]) {
      const r = await method(request("/api/polish"));
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({
        error: {
          code: "UNAVAILABLE"
        }
      });
    }
  });
  it("serves authenticated safe choices, selected execution and no duplicate transmission", async () => {
    vi.stubEnv("AI_POLISH_ENABLED", "true");
    vi.stubEnv("POLISH_FAKE_BACKEND", "true");
    vi.stubEnv("POLISH_FAKE_LLM", "true");
    const h = await import("../polish/handler");
    expect((await h.GET(request("/api/polish/quota"))).status).toBe(401);
    const headers = {
      authorization: "Bearer local-test",
      "content-type": "application/json"
    };
    const available = await h.AVAILABILITY_GET(request("/api/polish/availability", {
      headers
    }));
    expect(available.headers.get("cache-control")).toBe("private, no-store");
    const {
      availability
    } = polishAvailabilityResponseSchema.parse(await available.json());
    expect(availability.options).toHaveLength(2);
    expect(JSON.stringify(availability)).not.toContain("credential_ref");
    const payload = {
      clientRequestId: crypto.randomUUID(),
      granularity: "item",
      sectionId: "profile",
      language: "zh",
      items: [{
        id: "i0",
        kind: "profile",
        text: "五年后端开发经验，专注高并发分布式系统。"
      }],
      context: {
        level: 0,
        references: []
      },
      expectedRoute: polishExpectedRouteFromAvailability(availability, availability.options[1].optionId)
    };
    const r = await h.POST(request("/api/polish", {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      quota: {
        remaining: 19
      }
    });
    const replay = await h.POST(request("/api/polish", {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    }));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        reason: "ALREADY_FINALIZED"
      }
    });
    const malformed = await h.POST(request("/api/polish", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        expectedRoute: {
          schemaVersion: "expected_route_v1"
        }
      })
    }));
    expect(malformed.status).toBe(400);
  });
  it.each([
    ["VERCEL_ENV", "preview"], ["VERCEL_ENV", "production"],
    ["ADMIN_ENVIRONMENT", "preview"], ["ADMIN_ENVIRONMENT", "production"],
  ])("refuses fake mode with CI=true and %s=%s", async (name, value) => {
    vi.stubEnv("AI_POLISH_ENABLED", "true");
    vi.stubEnv("POLISH_FAKE_BACKEND", "true");
    vi.stubEnv("POLISH_FAKE_LLM", "true");
    vi.stubEnv("CI", "true");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("ADMIN_ENVIRONMENT", "local");
    vi.stubEnv(name, value);
    await expect(import("../polish/handler")).rejects.toThrow("hosted");
  });
  it("refuses unpaired fake mode and production fake configuration", async () => {
    vi.stubEnv("AI_POLISH_ENABLED", "true");
    vi.stubEnv("POLISH_FAKE_BACKEND", "true");
    vi.stubEnv("POLISH_FAKE_LLM", "false");
    await expect(import("../polish/handler")).rejects.toThrow("together");
    vi.resetModules();
    vi.stubEnv("POLISH_FAKE_LLM", "true");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "false");
    await expect(import("../polish/handler")).rejects.toThrow("forbidden");
  });
});
