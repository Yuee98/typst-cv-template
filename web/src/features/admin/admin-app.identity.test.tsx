// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStateListeners: Array<(event: string, session: unknown) => void> = [];
const authClient = {
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(
      (listener: (event: string, session: unknown) => void) => {
        authStateListeners.push(listener);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    ),
    signOut: vi.fn(async () => ({ error: null })),
    signInWithPassword: vi.fn(),
    signInWithOAuth: vi.fn(),
  },
};

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: () => authClient,
}));
vi.mock("@/components/layout/toolbar/theme-toggle", () => ({
  ThemeToggle: () => <span />,
}));

import AdminApp from "./admin-app";

const session = (token: string) => ({
  access_token: token,
  user: { id: token, email: `${token}@example.test` },
});
const context = (projectRef: string) => ({
  schemaVersion: "admin_context_v1",
  actor: {
    userId: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.test",
    revision: "1",
  },
  environment: {
    name: "local",
    projectRef,
    controlPlaneMode: "jwt_v1",
    revision: "1",
  },
  features: {
    aiEnabled: true,
    globalDailyLimit: 10,
    allowlistedUsers: 1,
    configGeneration: "1",
    activePolicyVersionId: null,
    currentLegalBundle: "bundle-v1",
  },
  capabilities: { writes: false },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  authStateListeners.length = 0;
  authClient.auth.getSession.mockResolvedValue({
    data: { session: session("A") },
  });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminApp identity boundaries", () => {
  it("surfaces an initial session restoration failure", async () => {
    authClient.auth.getSession.mockRejectedValueOnce(new Error("storage unavailable"));
    render(<AdminApp locale="en" />);
    await waitFor(() =>
      expect(
        screen.getByText(
          "The admin service is temporarily unavailable. Try again later.",
        ),
      ).toBeTruthy(),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts GitHub OAuth from the clean Admin root", async () => {
    authClient.auth.getSession.mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    authClient.auth.signInWithOAuth.mockResolvedValueOnce({ error: null });
    window.history.replaceState(
      null,
      "",
      "/en/admin/users?search=admin%40example.test&after=cursor#private",
    );

    render(<AdminApp locale="en" section="users" />);
    await screen.findByText("Administrator sign in");
    screen.getByRole("button", { name: "Continue with GitHub" }).click();

    await waitFor(() =>
      expect(authClient.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: "github",
        options: { redirectTo: `${window.location.origin}/en/admin` },
      }),
    );
  });

  it("does not paint an overview response after signout", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    render(<AdminApp locale="en" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    act(() => authStateListeners[0]("SIGNED_OUT", null));
    await act(async () =>
      pending.resolve(
        new Response(JSON.stringify(context("account-A")), { status: 200 }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("account-A")).toBeNull();
    expect(screen.getByText("Administrator sign in")).toBeTruthy();
  });

  it("ignores account A response and paints only account B response", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.mocked(fetch)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<AdminApp locale="en" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => authStateListeners[0]("SIGNED_IN", session("B")));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () =>
      first.resolve(
        new Response(JSON.stringify(context("account-A")), { status: 200 }),
      ),
    );
    expect(screen.queryByText("account-A")).toBeNull();
    await act(async () =>
      second.resolve(
        new Response(JSON.stringify(context("account-B")), { status: 200 }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/account-B/)).toBeTruthy());
    expect(screen.queryByText("account-A")).toBeNull();
  });
});
