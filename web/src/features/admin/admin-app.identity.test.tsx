// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
const authStateListeners: Array<(event: string, session: unknown) => void> = [];
const authClient = {
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn((listener: (event: string, session: unknown) => void) => {
      authStateListeners.push(listener);
      return {
        data: {
          subscription: {
            unsubscribe: vi.fn()
          }
        }
      };
    }),
    signOut: vi.fn(async () => ({
      error: null
    })),
    signInWithPassword: vi.fn(),
    signInWithOAuth: vi.fn()
  }
};
let browserClient = {
  ...authClient
};
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: () => browserClient,
  getSupabaseConfig: () => ({
    url: "http://127.0.0.1:54321"
  })
}));
vi.mock("./security-settings", () => ({
  AdminSecuritySettings: () => {
    const [message, setMessage] = useState("");
    return <div><button onClick={() => setMessage("TOTP verified and session refreshed.")}>Complete test MFA</button>{message && <p>{message}</p>}</div>;
  }
}));
import AdminApp from "./admin-app";
const clients: QueryClient[] = [];
function renderAdmin(element: ReactNode, existingCache?: QueryClient) {
  const client = existingCache ?? new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });
  if (!existingCache) clients.push(client);
  const view = render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return {
    ...view,
    cache: client,
    rerender: (next: ReactNode) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>)
  };
}
const session = (token: string) => ({
  access_token: token,
  user: {
    id: token,
    email: `${token}@example.test`
  }
});
const context = (account: string) => ({
  ready: true,
  capabilities: [],
  environment: "LOCAL",
  database_instance_id: "00000000-0000-4000-8000-000000000001",
  contract_code: "cv_app_db_1",
  member_id: account === "account-A" ? "adm_AAAAAAAAAAAA" : "adm_BBBBBBBBBBBB",
  aal: "aal1",
  control: {
    enabled: false,
    active_policy_version_id: null,
    audience: "ALLOWLIST",
    generation: "1",
    close_cycle: "1",
    revision: "1",
    user_daily_limit: "20",
    global_daily_limit: "2000",
    user_minute_limit: "3"
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {
    promise,
    resolve
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  browserClient = {
    ...authClient
  };
  authStateListeners.length = 0;
  authClient.auth.getSession.mockResolvedValue({
    data: {
      session: session("A")
    }
  });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});
describe("AdminApp identity boundaries", () => {
  it("mounts an already-cached page with the existing shared Auth and QueryClient", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      context: context("account-A"),
      data: {
        records: [{
          label: "Cached profile"
        }],
        next_cursor: null
      }
    })));
    const first = renderAdmin(<AdminApp locale="en" section="profiles" />);
    await screen.findByText("Cached profile");
    first.unmount();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderAdmin(<AdminApp locale="en" section="profiles" />, first.cache)).not.toThrow();
    await screen.findByText("Cached profile");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains the same user's security state across a real token refresh", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      context: context("account-A"),
      data: null
    }))).mockReturnValueOnce(pending.promise);
    renderAdmin(<AdminApp locale="en" />);
    await screen.findByText(/adm_AAAAAAAAAAAA/);
    fireEvent.click(screen.getByRole("button", {
      name: "Complete test MFA"
    }));
    act(() => authStateListeners[0]("TOKEN_REFRESHED", {
      ...session("A"),
      access_token: "renewed-A"
    }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("TOTP verified and session refreshed.")).toBeTruthy();
    await act(async () => pending.resolve(new Response(JSON.stringify({
      context: {
        ...context("account-A"),
        aal: "aal2"
      },
      data: null
    }))));
    await screen.findByRole("button", {
      name: "Complete test MFA"
    });
    expect(screen.getByText("TOTP verified and session refreshed.")).toBeTruthy();
  });
  it.each(["same-user", "different-user", "different-instance"] as const)("keeps input drafts only for the same user and instance after token refresh (%s)", async transition => {
    const pending = deferred<Response>();
    const data = {
      records: [],
      next_cursor: null
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      context: context("account-A"),
      data
    }))).mockReturnValueOnce(pending.promise);
    renderAdmin(<AdminApp locale="en" section="profiles" />);
    const input = await screen.findByLabelText(/^name$/i);
    fireEvent.change(input, {
      target: {
        value: "Unsubmitted profile name"
      }
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: {
        value: "Keep this local reason"
      }
    });
    act(() => authStateListeners[0]("TOKEN_REFRESHED", transition === "different-user" ? session("B") : {
      ...session("A"),
      access_token: "renewed-A"
    }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    if (transition === "same-user") {
      const hiddenInput = screen.getByLabelText(/^name$/i) as HTMLInputElement;
      expect(hiddenInput.value).toBe("Unsubmitted profile name");
      expect(hiddenInput.matches(":disabled")).toBe(true);
      expect(hiddenInput.closest("section[hidden]")).toBeTruthy();
    }
    const next = context(transition === "different-user" ? "account-B" : "account-A");
    if (transition === "different-instance") next.database_instance_id = "00000000-0000-4000-8000-000000000002";
    await act(async () => pending.resolve(new Response(JSON.stringify({
      context: next,
      data
    }))));
    await screen.findByRole("button", {
      name: "Submit"
    });
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe(transition === "same-user" ? "Unsubmitted profile name" : "");
    expect((screen.getByLabelText("Reason") as HTMLInputElement).value).toBe(transition === "same-user" ? "Keep this local reason" : "");
  });
  it("discards a retained form after the refreshed actor is denied", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      context: context("account-A"),
      data: {
        records: [],
        next_cursor: null
      }
    }))).mockReturnValueOnce(pending.promise);
    renderAdmin(<AdminApp locale="en" section="profiles" />);
    fireEvent.change(await screen.findByLabelText(/^name$/i), {
      target: {
        value: "Private unsubmitted name"
      }
    });
    act(() => authStateListeners[0]("TOKEN_REFRESHED", {
      ...session("A"),
      access_token: "renewed-A"
    }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve(new Response(JSON.stringify({
      error: {
        code: "FORBIDDEN"
      }
    }), {
      status: 403
    })));
    await screen.findByText("FORBIDDEN");
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();
    expect(screen.queryByDisplayValue("Private unsubmitted name")).toBeNull();
  });
  it("surfaces an initial session restoration failure", async () => {
    authClient.auth.getSession.mockRejectedValueOnce(new Error("storage unavailable"));
    renderAdmin(<AdminApp locale="en" />);
    await waitFor(() => expect(screen.getByText("The admin service is temporarily unavailable. Try again later.")).toBeTruthy());
    expect(fetch).not.toHaveBeenCalled();
  });
  it("starts GitHub OAuth from the clean Admin root", async () => {
    authClient.auth.getSession.mockResolvedValueOnce({
      data: {
        session: null
      },
      error: null
    });
    authClient.auth.signInWithOAuth.mockResolvedValueOnce({
      error: null
    });
    window.history.replaceState(null, "", "/en/admin/users?search=admin%40example.test&after=cursor#private");
    renderAdmin(<AdminApp locale="en" section="users" />);
    await screen.findByText("Administrator sign in");
    screen.getByRole("button", {
      name: "Continue with GitHub"
    }).click();
    await waitFor(() => expect(authClient.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/en/admin`
      }
    }));
  });
  it("does not paint an overview response after signout", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    renderAdmin(<AdminApp locale="en" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    act(() => authStateListeners[0]("SIGNED_OUT", null));
    await act(async () => pending.resolve(new Response(JSON.stringify({
      context: context("account-A"),
      data: null
    }), {
      status: 200
    })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText(/adm_AAAAAAAAAAAA/g)).toBeNull();
    expect(screen.getByText("Administrator sign in")).toBeTruthy();
  });
  it("ignores account A response and paints only account B response", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderAdmin(<AdminApp locale="en" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => authStateListeners[0]("SIGNED_IN", session("B")));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve(new Response(JSON.stringify({
      context: context("account-A"),
      data: null
    }), {
      status: 200
    })));
    expect(screen.queryByText(/adm_AAAAAAAAAAAA/g)).toBeNull();
    await act(async () => second.resolve(new Response(JSON.stringify({
      context: context("account-B"),
      data: null
    }), {
      status: 200
    })));
    await waitFor(() => expect(screen.getByText(/adm_BBBBBBBBBBBB/g)).toBeTruthy());
    expect(screen.queryByText(/adm_AAAAAAAAAAAA/g)).toBeNull();
  });
  it("resets section-specific kind and cursor when soft navigation reuses the component", async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const query = new URL(String(input), window.location.origin).searchParams;
      return new Response(JSON.stringify({
        context: context("account-A"),
        data: {
          records: [{
            label: `${query.get("section")}-${query.get("kind")}`
          }],
          next_cursor: "cursor-1"
        }
      }), {
        status: 200
      });
    });
    const view = renderAdmin(<AdminApp locale="en" section="users" />);
    await screen.findByText("users-accounts");
    fireEvent.click(screen.getByRole("button", {
      name: "Next page"
    }));
    await waitFor(() => expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain("after=cursor-1"));
    fireEvent.change(screen.getByLabelText("Record kind"), {
      target: {
        value: "members"
      }
    });
    await screen.findByText("users-members");
    view.rerender(<AdminApp locale="en" section="profiles" />);
    await screen.findByText("profiles-versions");
    expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).not.toContain("after=");
    expect((screen.getByLabelText("Record kind") as HTMLSelectElement).value).toBe("versions");
    const calls = vi.mocked(fetch).mock.calls.length;
    view.rerender(<AdminApp locale="en" section="users" />);
    await screen.findByText("users-accounts");
    expect((screen.getByLabelText("Record kind") as HTMLSelectElement).value).toBe("accounts");
    expect(fetch).toHaveBeenCalledTimes(calls);
    const editorLink = screen.getByRole("link", {
      name: "Back to editor"
    });
    expect(editorLink.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(editorLink.getAttribute("href")).toBe("/en");
  });
});
