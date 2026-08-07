// @vitest-environment jsdom

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCloudSession } from "@/components/cv-builder/hooks/use-cloud-session";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/en");
});

const sessionA = { user: { id: "user-a" } } as Session;
const sessionB = { user: { id: "user-b" } } as Session;

function createClient(initialResult: Promise<{ data: { session: Session | null }; error: Error | null }>) {
  let authCallback: ((event: string, session: Session | null) => void) | null = null;
  const unsubscribe = vi.fn();
  const auth = {
    getSession: vi.fn(() => initialResult),
    onAuthStateChange: vi.fn((callback: (event: string, session: Session | null) => void) => {
      authCallback = callback;
      return { data: { subscription: { unsubscribe } } };
    }),
  };

  return {
    auth,
    client: { auth } as unknown as SupabaseClient,
    emit(event: string, session: Session | null) {
      if (!authCallback) throw new Error("auth callback was not registered");
      authCallback(event, session);
    },
    unsubscribe,
  };
}

describe("useCloudSession", () => {
  it("initializes immediately when Supabase is unavailable", () => {
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(null);

    const { result } = renderHook(() => useCloudSession({ onError: vi.fn() }));

    expect(result.current).toMatchObject({
      cloudStatus: "idle",
      session: null,
      sessionInitialized: true,
      supabase: null,
    });
  });

  it("loads the initial session, follows auth events, and unsubscribes", async () => {
    const h = createClient(Promise.resolve({ data: { session: sessionA }, error: null }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();

    const hook = renderHook(() => useCloudSession({ onError }));
    await waitFor(() => expect(hook.result.current.session).toBe(sessionA));
    expect(hook.result.current.sessionInitialized).toBe(true);

    act(() => h.emit("SIGNED_IN", sessionB));
    expect(hook.result.current.session).toBe(sessionB);

    hook.unmount();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("surfaces redirect and initial-session errors without losing initialization", async () => {
    window.history.replaceState({}, "", "/en?error=access_denied&error_description=OAuth%20denied");
    const sessionError = new Error("session unavailable");
    const h = createClient(Promise.resolve({ data: { session: null }, error: sessionError }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();

    const { result } = renderHook(() => useCloudSession({ onError }));

    await waitFor(() => expect(result.current.sessionInitialized).toBe(true));
    expect(result.current.cloudStatus).toBe("error");
    expect(onError).toHaveBeenNthCalledWith(1, "OAuth denied");
    expect(onError).toHaveBeenNthCalledWith(2, "session unavailable");
  });

  it("ignores a late initial-session result after unmount", async () => {
    let resolveSession!: (value: { data: { session: Session | null }; error: null }) => void;
    const pending = new Promise<{ data: { session: Session | null }; error: null }>((resolve) => {
      resolveSession = resolve;
    });
    const h = createClient(pending);
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();

    const hook = renderHook(() => useCloudSession({ onError }));
    hook.unmount();
    await act(async () => resolveSession({ data: { session: sessionA }, error: null }));

    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not let a late initial session overwrite a newer auth event", async () => {
    let resolveSession!: (value: { data: { session: Session | null }; error: null }) => void;
    const pending = new Promise<{ data: { session: Session | null }; error: null }>((resolve) => {
      resolveSession = resolve;
    });
    const h = createClient(pending);
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();

    const hook = renderHook(() => useCloudSession({ onError }));
    act(() => h.emit("SIGNED_IN", sessionB));
    expect(hook.result.current.session).toBe(sessionB);

    await act(async () => resolveSession({ data: { session: sessionA }, error: null }));

    expect(hook.result.current.session).toBe(sessionB);
    expect(hook.result.current.sessionInitialized).toBe(true);
  });
});
