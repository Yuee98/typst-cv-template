import { describe, expect, it, vi } from "vitest";
import context from "../../../test/fixtures/admin-contract-v1.json";
import { handleAdminGet } from "./handler";
import { resolveAdminEnvironment } from "./environment";

const environment = {
  name: "local" as const,
  projectRef: "local",
  supabaseUrl: "http://127.0.0.1:54321",
  publishableKey: "public-test-key",
};
function setup(data: unknown = context, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const getUser = vi
    .fn()
    .mockResolvedValue({
      data: { user: { id: context.actor.userId } },
      error: null,
    });
  const client = vi.fn().mockReturnValue({ rpc, auth: { getUser } });
  return {
    rpc,
    getUser,
    client,
    deps: { environment: () => environment, client },
  };
}
const request = (query = "", token = "user-jwt") =>
  new Request(`https://site.test/api/admin${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

describe("Admin read HTTP boundary", () => {
  it("verifies and carries the same bearer into a per-request client", async () => {
    const { deps, client, getUser, rpc } = setup();
    const response = await handleAdminGet(request(), deps);
    expect(client).toHaveBeenCalledWith(environment, "user-jwt");
    expect(getUser).toHaveBeenCalledWith("user-jwt");
    expect(rpc).toHaveBeenCalledWith("admin_get_context_v1", {
      p_environment: "local",
      p_project_ref: "local",
    });
    expect(await response.json()).toEqual(context);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization");
  });
  it("does not query for an absent or invalid session", async () => {
    const { deps, getUser, rpc } = setup();
    expect(
      (await handleAdminGet(new Request("https://site.test/api/admin"), deps))
        .status,
    ).toBe(401);
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "expired" },
    });
    expect((await handleAdminGet(request(), deps)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    "?section=users&limit=101",
    "?section=users&limit=1&limit=2",
    "?section=sql",
    "?section=users&id=bad",
    "?section=users&after=bad",
    "?section=users&search=" + "x".repeat(101),
    "?section=overview&limit=1",
    "?secret=anything",
  ])("rejects unbounded/unknown query %s", async (query) => {
    const { deps, rpc } = setup();
    expect((await handleAdminGet(request(query), deps)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("fails closed on unexpected fields and does not echo raw DB errors", async () => {
    const unsafe = setup({ ...context, secret: "hidden-value" });
    const response = await handleAdminGet(request(), unsafe.deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("hidden-value");
    const upstream = setup(null, {
      code: "P0001",
      message: "SQL and credential hidden-value",
    });
    expect(
      await (await handleAdminGet(request(), upstream.deps)).json(),
    ).toEqual({ error: { code: "UNAVAILABLE" } });
  });
  it("preserves current authorization and environment denials from DB", async () => {
    for (const message of ["FORBIDDEN", "ENVIRONMENT_MISMATCH"]) {
      const { deps } = setup(null, { code: "42501", message });
      const response = await handleAdminGet(request(), deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: message } });
    }
  });
});

describe("deployment environment", () => {
  const env = {
    ADMIN_ENVIRONMENT: "local",
    NEXT_PUBLIC_SUPABASE_URL: environment.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public",
  };
  it("requires explicit environment and exact local/hosted project identity", () => {
    expect(resolveAdminEnvironment(env).projectRef).toBe("local");
    for (const override of [
      { ADMIN_ENVIRONMENT: undefined },
      { ADMIN_ENVIRONMENT: "production" },
      { VERCEL: "1", VERCEL_ENV: "production" },
      { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:9999" },
      { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co.attacker.test" },
      { NEXT_PUBLIC_SUPABASE_URL: "http://secret@127.0.0.1:54321" },
    ])
      expect(() => resolveAdminEnvironment({ ...env, ...override })).toThrow();
    expect(
      resolveAdminEnvironment({
        ...env,
        ADMIN_ENVIRONMENT: "preview",
        NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      }).projectRef,
    ).toBe("abc");
  });
});
