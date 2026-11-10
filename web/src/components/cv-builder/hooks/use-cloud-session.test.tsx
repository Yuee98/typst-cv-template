// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudSession } from "@/components/cv-builder/hooks/use-cloud-session";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { captureEncryptionPasswordOwner, loadEncryptionPassword, loadTrustDevice, storeEncryptionPassword, storeTrustDevice } from "@/lib/cv/encryption-storage";
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: vi.fn()
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/en");
});
const sessionA = {
  user: {
    id: "user-a"
  }
} as Session;
const sessionB = {
  user: {
    id: "user-b"
  }
} as Session;
function createClient(initialResult: Promise<{
  data: {
    session: Session | null;
  };
  error: Error | null;
}>) {
  let authCallback: ((event: string, session: Session | null) => void) | null = null;
  const unsubscribe = vi.fn();
  const auth = {
    getSession: vi.fn(() => initialResult),
    onAuthStateChange: vi.fn((callback: (event: string, session: Session | null) => void) => {
      authCallback = callback;
      return {
        data: {
          subscription: {
            unsubscribe
          }
        }
      };
    })
  };
  const rpc = vi.fn<() => Promise<{ data: unknown; error: Error | null }>>(async () => ({
    data: {
      ready: true,
      contract_code: "cv_app_db_2",
      database_instance_id: "00000000-0000-4000-8000-000000000001"
    },
    error: null
  }));
  return {
    auth,
    client: {
      auth,
      rpc
    } as unknown as SupabaseClient,
    rpc,
    emit(event: string, session: Session | null) {
      if (!authCallback) throw new Error("auth callback was not registered");
      authCallback(event, session);
    },
    unsubscribe
  };
}
describe("useCloudSession", () => {
  it.each(["sessionStorage", "localStorage"] as const)("still adopts peer sign-out and tries the other storage when %s is inaccessible", async failingStorage => {
    const h = createClient(Promise.resolve({ data: { session: sessionA }, error: null }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({ onError }));
    await waitFor(() => expect(hook.result.current.session).toBe(sessionA));
    await storeEncryptionPassword("user-a", "encrypted-a", "synthetic-a-passphrase", true);
    const storages = { sessionStorage: window.sessionStorage, localStorage: window.localStorage };
    const ownsPassword = captureEncryptionPasswordOwner("user-a");
    const attempted: string[] = [];
    const ownersAtStorageAccess: boolean[] = [];
    for (const name of ["sessionStorage", "localStorage"] as const) {
      vi.spyOn(window, name, "get").mockImplementation(() => {
        attempted.push(name);
        ownersAtStorageAccess.push(ownsPassword());
        if (name === failingStorage) throw new DOMException("Synthetic storage unavailable", "SecurityError");
        return storages[name];
      });
    }
    act(() => h.emit("SIGNED_OUT", null));
    expect(hook.result.current.session).toBeNull();
    expect(hook.result.current.cloudStatus).toBe("idle");
    expect(attempted).toEqual(["sessionStorage", "localStorage"]);
    expect(ownersAtStorageAccess).toEqual([false, false]);
    expect(ownsPassword()).toBe(false);
    const accessibleStorage = storages[failingStorage === "sessionStorage" ? "localStorage" : "sessionStorage"];
    expect(Object.keys(accessibleStorage).filter(key => key.endsWith(":user-a:encrypted-a"))).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });
  it.each(["length", "removeItem"] as const)("still adopts a direct account switch when clearing the old storage throws from %s", async failure => {
    const h = createClient(Promise.resolve({ data: { session: sessionA }, error: null }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({ onError }));
    await waitFor(() => expect(hook.result.current.session).toBe(sessionA));
    await storeEncryptionPassword("user-a", "encrypted-a", "synthetic-a-passphrase", true);
    const blocked = window.sessionStorage;
    const accessible = window.localStorage;
    const ownsPassword = captureEncryptionPasswordOwner("user-a");
    if (failure === "length") {
      const length = Object.getOwnPropertyDescriptor(Storage.prototype, "length")!.get!;
      vi.spyOn(Storage.prototype, "length", "get").mockImplementation(function (this: Storage) {
        if (this === blocked) throw new DOMException("Synthetic enumeration failure", "SecurityError");
        return length.call(this) as number;
      });
    } else {
      const remove = Storage.prototype.removeItem;
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
        if (this === blocked) throw new DOMException("Synthetic removal failure", "SecurityError");
        remove.call(this, key);
      });
    }
    act(() => h.emit("SIGNED_IN", sessionB));
    expect(hook.result.current.session).toBe(sessionB);
    expect(ownsPassword()).toBe(false);
    expect(Object.keys(accessible).filter(key => key.endsWith(":user-a:encrypted-a"))).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });
  it("ignores an old initial context failure after a newer auth event", async () => {
    const h = createClient(Promise.resolve({ data: { session: sessionA }, error: null }));
    let rejectContext!: (error: Error) => void;
    h.rpc.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectContext = reject; }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({ onError }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    act(() => h.emit("SIGNED_IN", sessionB));
    await act(async () => rejectContext(new Error("obsolete initial context failure")));
    expect(hook.result.current.session).toBe(sessionB);
    expect(hook.result.current.cloudStatus).toBe("idle");
    expect(onError).not.toHaveBeenCalled();
  });
  it("ignores a callback already captured before the old subscription was removed", async () => {
    const h = createClient(Promise.resolve({ data: { session: sessionA }, error: null }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const hook = renderHook(({ onError }) => useCloudSession({ onError }), { initialProps: { onError: vi.fn() } });
    await waitFor(() => expect(hook.result.current.session).toBe(sessionA));
    // auth-js _notifyAllSubscribers snapshots its subscription list before
    // dispatch, so unsubscribing cannot invalidate a callback already captured.
    const oldCallback = h.auth.onAuthStateChange.mock.calls[0][0];
    hook.rerender({ onError: vi.fn() });
    act(() => h.emit("SIGNED_IN", sessionB));
    await storeEncryptionPassword("user-b", "encrypted-b", "synthetic-b-passphrase", false);
    act(() => oldCallback("SIGNED_OUT", null));
    expect(hook.result.current.session).toBe(sessionB);
    await expect(loadEncryptionPassword("user-b", "encrypted-b")).resolves.toBe("synthetic-b-passphrase");
  });
  it.each([false, true])("clears this peer tab's cached password before the same user signs back in (remember device: %s)", async rememberDevice => {
    const h = createClient(Promise.resolve({ data: { session: sessionA }, error: null }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({ onError }));
    await waitFor(() => expect(hook.result.current.session).toBe(sessionA));
    await storeEncryptionPassword("user-a", "encrypted-a", "synthetic-a-passphrase", rememberDevice);
    await storeEncryptionPassword("user-b", "encrypted-b", "synthetic-b-passphrase", true);
    storeTrustDevice("user-a", rememberDevice);
    await expect(loadEncryptionPassword("user-a", "encrypted-a")).resolves.toBe("synthetic-a-passphrase");

    // The SDK delivers a peer tab's sign-out; this tab never calls our signOut action.
    act(() => {
      h.emit("SIGNED_OUT", null);
      expect([...Object.keys(window.sessionStorage), ...Object.keys(window.localStorage)].filter(key => key.endsWith(":user-a:encrypted-a"))).toEqual([]);
      h.emit("SIGNED_IN", sessionA);
    });

    expect(hook.result.current.session).toBe(sessionA);
    await expect(loadEncryptionPassword("user-a", "encrypted-a")).resolves.toBeNull();
    await expect(loadEncryptionPassword("user-b", "encrypted-b")).resolves.toBe("synthetic-b-passphrase");
    expect(loadTrustDevice("user-a")).toBe(rememberDevice);
    expect(onError).not.toHaveBeenCalled();
  });
  it("preserves the current owner's password on duplicate sign-in and token refresh, but clears it on a direct account switch", async () => {
    const h = createClient(Promise.resolve({ data: { session: sessionA }, error: null }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({ onError }));
    await waitFor(() => expect(hook.result.current.session).toBe(sessionA));
    await storeEncryptionPassword("user-a", "encrypted-a", "synthetic-a-passphrase", false);
    act(() => { h.emit("SIGNED_IN", sessionA); h.emit("TOKEN_REFRESHED", { ...sessionA }); });
    await expect(loadEncryptionPassword("user-a", "encrypted-a")).resolves.toBe("synthetic-a-passphrase");
    act(() => h.emit("SIGNED_IN", sessionB));
    await expect(loadEncryptionPassword("user-a", "encrypted-a")).resolves.toBeNull();
  });
  it("initializes immediately when Supabase is unavailable", () => {
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(null);
    const {
      result
    } = renderHook(() => useCloudSession({
      onError: vi.fn()
    }));
    expect(result.current).toMatchObject({
      cloudStatus: "idle",
      session: null,
      sessionInitialized: true,
      supabase: null
    });
  });
  it("loads the initial session, follows auth events, and unsubscribes", async () => {
    const h = createClient(Promise.resolve({
      data: {
        session: sessionA
      },
      error: null
    }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({
      onError
    }));
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
    const h = createClient(Promise.resolve({
      data: {
        session: null
      },
      error: sessionError
    }));
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const {
      result
    } = renderHook(() => useCloudSession({
      onError
    }));
    await waitFor(() => expect(result.current.sessionInitialized).toBe(true));
    expect(result.current.cloudStatus).toBe("error");
    expect(onError).toHaveBeenNthCalledWith(1, "OAuth denied");
    expect(onError).toHaveBeenNthCalledWith(2, "session unavailable");
  });
  it("ignores a late initial-session result after unmount", async () => {
    let resolveSession!: (value: {
      data: {
        session: Session | null;
      };
      error: null;
    }) => void;
    const pending = new Promise<{
      data: {
        session: Session | null;
      };
      error: null;
    }>(resolve => {
      resolveSession = resolve;
    });
    const h = createClient(pending);
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({
      onError
    }));
    hook.unmount();
    await act(async () => resolveSession({
      data: {
        session: sessionA
      },
      error: null
    }));
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
  it("does not let a late initial session overwrite a newer auth event", async () => {
    let resolveSession!: (value: {
      data: {
        session: Session | null;
      };
      error: null;
    }) => void;
    const pending = new Promise<{
      data: {
        session: Session | null;
      };
      error: null;
    }>(resolve => {
      resolveSession = resolve;
    });
    const h = createClient(pending);
    vi.mocked(getSupabaseBrowserClient).mockReturnValue(h.client);
    const onError = vi.fn();
    const hook = renderHook(() => useCloudSession({
      onError
    }));
    act(() => h.emit("SIGNED_IN", sessionB));
    expect(hook.result.current.session).toBe(sessionB);
    await act(async () => resolveSession({
      data: {
        session: sessionA
      },
      error: null
    }));
    expect(hook.result.current.session).toBe(sessionB);
    expect(hook.result.current.sessionInitialized).toBe(true);
  });
});
