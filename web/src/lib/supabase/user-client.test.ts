import { afterEach, describe, expect, it, vi } from "vitest";
import { bindSupabaseUser, registerClient } from "./user-client";
const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
function original() {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: {
          session: {
            access_token: "captured-token-A",
            user: {
              id: userA
            }
          }
        },
        error: null
      }),
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: {
            id: userA
          }
        },
        error: null
      })
    }
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("operation account binding", () => {
  it("keeps the captured bearer when the shared browser account changes", async () => {
    const source = original();
    registerClient(source as never, "http://127.0.0.1:54321", "public-key");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true
    }), {
      headers: {
        "Content-Type": "application/json"
      }
    }));
    vi.stubGlobal("fetch", fetcher);
    const bound = await bindSupabaseUser(source as never, userA);
    source.auth.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: "later-token-B",
          user: {
            id: userB
          }
        }
      },
      error: null
    });
    const {
      error
    } = await bound.rpc("ai_quota", {
      p_input: {}
    });
    expect(error).toBeNull();
    const call = fetcher.mock.calls[0];
    expect(new Headers(call[1].headers).get("Authorization")).toBe("Bearer captured-token-A");
    expect(call[1].cache).toBe("no-store");
    expect(source.auth.getUser).toHaveBeenCalledWith("captured-token-A");
  });
  it("rejects a changed account before any new database operation", async () => {
    const source = original();
    registerClient(source as never, "http://127.0.0.1:54321", "public-key");
    await expect(bindSupabaseUser(source as never, userB)).rejects.toThrow(/account changed/);
    expect(source.auth.getUser).not.toHaveBeenCalled();
  });
  it("requires an explicitly registered connection and forbids reassigning a client", async () => {
    const source = original();
    await expect(bindSupabaseUser(source as never, userA)).rejects.toThrow(/registered connection/);
    expect(source.auth.getSession).not.toHaveBeenCalled();
    registerClient(source as never, "http://127.0.0.1:54321", "public-key");
    expect(() => registerClient(source as never, "http://127.0.0.1:54325", "public-key")).toThrow(/cannot change/);
  });
});
