import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminRequestClient } from "./request-client";
afterEach(() => vi.unstubAllGlobals());
describe("Admin request-scoped Supabase transport", () => {
  it("keeps the same verified bearer and cancellation signal for Auth and the read RPC", async () => {
    const calls: {
      url: string;
      headers: Headers;
      signal: AbortSignal | null | undefined;
    }[] = [];
    const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        signal: init?.signal
      });
      return Response.json(String(input).endsWith("/auth/v1/user") ? {
        id: "00000000-0000-4000-8000-000000000001"
      } : {
        context: {},
        data: null
      });
    });
    vi.stubGlobal("fetch", network);
    const controller = new AbortController();
    const client = createAdminRequestClient({
      name: "local",
      supabaseUrl: "http://127.0.0.1:54321",
      publishableKey: "public-test-key"
    }, "verified-test-token", controller.signal);
    expect((await client.auth.getUser("verified-test-token")).error).toBeNull();
    expect((await client.rpc("admin_read", {
      p_input: {
        section: "overview"
      }
    })).error).toBeNull();
    expect(calls.map(c => c.url)).toEqual(["http://127.0.0.1:54321/auth/v1/user", "http://127.0.0.1:54321/rest/v1/rpc/admin_read"]);
    for (const call of calls) {
      expect(call.headers.get("Authorization")).toBe("Bearer verified-test-token");
      expect(call.signal).toBe(controller.signal);
    }
    controller.abort();
    expect(calls.every(c => c.signal?.aborted)).toBe(true);
  });
});
