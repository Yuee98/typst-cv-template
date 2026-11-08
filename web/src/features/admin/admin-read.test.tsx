// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminReadKey, invalidateAdminReads, useAdminRead, type AdminReadParams } from "./admin-read";
import { useAdminSession } from "./admin-session";
const instance1 = "00000000-0000-4000-8000-000000000001";
const instance2 = "00000000-0000-4000-8000-000000000002";
const project = "http://127.0.0.1:54321";
const clients: QueryClient[] = [];
const session = (user = "A", token = user) => ({
  access_token: token,
  user: {
    id: user
  }
}) as Session;
function context(instance = instance1, revision = "1") {
  return {
    ready: true,
    capabilities: {
      cv_schema_version: 7,
      encrypted_envelope_version: 1
    },
    environment: "LOCAL",
    database_instance_id: instance,
    contract_code: "cv_app_db_2",
    member_id: "1",
    control: {
      enabled: false,
      audience: "ALLOWLIST",
      revision,
      user_daily_limit: "20",
      global_daily_limit: "2000",
      user_minute_limit: "3"
    }
  };
}
function response(label = "row", instance = instance1, revision = "1", data: unknown = {
  records: [{
    label
  }],
  next_cursor: null
}) {
  return new Response(JSON.stringify({
    context: context(instance, revision),
    data
  }), {
    status: 200
  });
}
function auth() {
  let listener!: (event: string, value: Session | null) => void;
  const getSession = vi.fn().mockResolvedValue({
    data: {
      session: session()
    },
    error: null
  });
  const onAuthStateChange = vi.fn((callback: typeof listener) => {
    listener = callback;
    return {
      data: {
        subscription: {
          unsubscribe: vi.fn()
        }
      }
    };
  });
  return {
    client: {
      auth: {
        getSession,
        onAuthStateChange
      }
    } as unknown as SupabaseClient,
    getSession,
    onAuthStateChange,
    emit: (value: Session | null, event = "SIGNED_IN") => listener(event, value)
  };
}
function harness(initial: Partial<AdminReadParams> = {}, existingAuth = auth(), existingCache?: QueryClient) {
  const queryClient = existingCache ?? new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });
  if (!existingCache) clients.push(queryClient);
  const params: AdminReadParams = {
    section: "configurations",
    kind: "configurations",
    cursor: null,
    ...initial
  };
  const hook = renderHook(({
    next,
    source
  }: {
    next: AdminReadParams;
    source: string;
  }) => {
    const actor = useAdminSession(existingAuth.client);
    const read = useAdminRead(existingAuth.client, source, actor, next);
    return {
      actor,
      read
    };
  }, {
    initialProps: {
      next: params,
      source: project
    },
    wrapper: ({
      children
    }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  });
  return {
    ...hook,
    auth: existingAuth,
    queryClient,
    go(next: Partial<AdminReadParams>, source = project) {
      hook.rerender({
        next: {
          ...params,
          ...next
        },
        source
      });
    }
  };
}
const done = (h: ReturnType<typeof harness>) => waitFor(() => {
  expect(h.result.current.actor.ready).toBe(true);
  expect(h.result.current.read.loading).toBe(false);
  expect(h.result.current.read.result ?? h.result.current.read.error).toBeTruthy();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => {
    resolve = finish;
  });
  return {
    promise,
    resolve
  };
}
beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response()))));
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});
describe("Admin read lifetime and cache isolation", () => {
  it("loads a cold page once and retains only its canonical instance key", async () => {
    const h = harness();
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain("database_instance_id");
    expect(h.queryClient.getQueryData(adminReadKey(project, h.result.current.actor, instance1, {
      section: "configurations",
      kind: "configurations",
      cursor: null
    }))).toBeTruthy();
    expect(h.queryClient.getQueryCache().getAll().some(query => query.queryKey[5] === "bootstrap")).toBe(false);
  });
  it("uses one request per new page and revisits fresh data without rolling shared context back", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response("configurations", instance1, "1")).mockResolvedValueOnce(response("rules", instance1, "2"));
    const h = harness();
    await done(h);
    h.go({
      section: "rules"
    });
    await done(h);
    h.go({
      section: "configurations"
    });
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.result.current.read.result?.context.control.revision).toBe("2");
    expect(h.result.current.read.result?.data).toEqual({
      records: [{
        label: "configurations"
      }],
      next_cursor: null
    });
  });
  it.each(["controls"] as const)("always refreshes %s when returning", async section => {
    vi.mocked(fetch).mockImplementation(async input => response("row", instance1, "1", String(input).includes(`section=${section}`) ? null : {
      records: [],
      next_cursor: null
    }));
    const h = harness({
      section
    });
    await done(h);
    h.go({
      section: "configurations"
    });
    await done(h);
    h.go({
      section
    });
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("refetches a list after its thirty-second freshness expires", async () => {
    const h = harness();
    await done(h);
    const key = adminReadKey(project, h.result.current.actor, instance1, {
      section: "configurations",
      kind: "configurations",
      cursor: null
    });
    h.queryClient.setQueryData(key, h.queryClient.getQueryData(key), {
      updatedAt: Date.now() - 31_000
    });
    h.go({
      section: "rules"
    });
    await done(h);
    h.go({
      section: "configurations"
    });
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("separates kind, cursor, record and project keys", async () => {
    const h = harness({
      section: "rules"
    });
    await done(h);
    h.go({
      section: "rules",
      kind: "adapters"
    });
    await done(h);
    h.go({
      section: "rules",
      cursor: "next"
    });
    await done(h);
    vi.mocked(fetch).mockResolvedValueOnce(response("detail", instance1, "1", {
      id: "11"
    }));
    h.go({
      section: "rules",
      recordId: "11"
    });
    await done(h);
    h.go({
      section: "rules"
    }, "http://127.0.0.2:54321");
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain("kind=adapters");
    expect(String(vi.mocked(fetch).mock.calls[2][0])).toContain("after=next");
    expect(String(vi.mocked(fetch).mock.calls[4][0])).not.toContain("database_instance_id");
  });
  it("shares Auth across page remounts and ignores an unchanged-token event", async () => {
    const shared = auth();
    const h = harness({}, shared);
    await done(h);
    act(() => shared.emit(session()));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    h.unmount();
    const next = harness({}, shared, h.queryClient);
    await done(next);
    expect(shared.getSession).toHaveBeenCalledTimes(1);
    expect(shared.onAuthStateChange).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("clears the previous token's scope before reading under a new token", async () => {
    const h = harness();
    await done(h);
    act(() => h.auth.emit(session("A", "refreshed"), "TOKEN_REFRESHED"));
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).not.toContain("database_instance_id");
    expect(h.queryClient.getQueryCache().getAll().every(query => query.queryKey[3] === h.result.current.actor.epoch)).toBe(true);
  });
  it("clears Admin memory on signout even after leaving the Admin page", async () => {
    const h = harness();
    await done(h);
    expect(h.queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);
    h.unmount();
    act(() => h.auth.emit(null, "SIGNED_OUT"));
    expect(h.queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
  it("does not let an old page response seed scope or roll back the new page's context", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response("new", instance2, "2"));
    const h = harness();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    h.go({
      section: "rules"
    });
    await done(h);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve(response("obsolete", instance1, "1")));
    expect(h.result.current.read.result?.context.database_instance_id).toBe(instance2);
    expect(h.result.current.read.result?.context.control.revision).toBe("2");
    expect(h.queryClient.getQueryCache().getAll().some(query => query.queryKey[5] === instance1)).toBe(false);
  });
  it.each([401, 403])("clears the current actor's cached reads after HTTP %s", async status => {
    vi.mocked(fetch).mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN"
      }
    }), {
      status
    })).mockResolvedValueOnce(response("restored"));
    const h = harness();
    await done(h);
    h.go({
      section: "rules"
    });
    await done(h);
    expect(h.result.current.read.error).toBe(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN");
    expect(h.queryClient.getQueryCache().getAll()).toHaveLength(0);
    h.go({
      section: "configurations"
    });
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(fetch).mock.calls[2][0])).not.toContain("database_instance_id");
  });
  it("does not clear B's cache when A's obsolete request returns forbidden", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response("B")).mockResolvedValueOnce(response("B profiles"));
    const h = harness();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => h.auth.emit(session("B")));
    await done(h);
    await act(async () => pending.resolve(new Response(JSON.stringify({
      error: {
        code: "FORBIDDEN"
      }
    }), {
      status: 403
    })));
    h.go({
      section: "rules"
    });
    await done(h);
    h.go({
      section: "configurations"
    });
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(h.result.current.read.result?.data).toEqual({
      records: [{
        label: "B"
      }],
      next_cursor: null
    });
  });
  it("recovers an instance mismatch with exactly one unbound bootstrap", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: "CLIENT_UPDATE_REQUIRED"
      }
    }), {
      status: 409
    })).mockResolvedValueOnce(response("new instance", instance2));
    const h = harness();
    await done(h);
    h.go({
      section: "rules"
    });
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain(`database_instance_id=${instance1}`);
    expect(String(vi.mocked(fetch).mock.calls[2][0])).not.toContain("database_instance_id");
    expect(h.result.current.read.result?.context.database_instance_id).toBe(instance2);
    expect(h.queryClient.getQueryCache().getAll().some(query => query.queryKey[5] === instance1)).toBe(false);
  });
  it("stops after a second contract/instance mismatch", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      error: {
        code: "CLIENT_UPDATE_REQUIRED"
      }
    }), {
      status: 409
    }));
    const h = harness();
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.result.current.read.error).toBe("CLIENT_UPDATE_REQUIRED");
  });
  it("invalidates related lists and details after a mutation while retaining unrelated users", async () => {
    const h = harness({
      section: "rules"
    });
    await done(h);
    const key = (section: AdminReadParams["section"], recordId?: string) => adminReadKey(project, h.result.current.actor, instance1, {
      section,
      kind: "configurations",
      cursor: null,
      recordId
    });
    for (const section of ["users", "configurations", "audit"] as const) h.queryClient.setQueryData(key(section), {
      context: context(),
      data: {
        records: [],
        next_cursor: null
      }
    });
    h.queryClient.setQueryData(key("rules", "11"), {
      context: context(),
      data: {}
    });
    act(() => h.result.current.read.refreshAfterMutation());
    await done(h);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.queryClient.getQueryState(key("users"))?.isInvalidated).toBe(false);
    expect(h.queryClient.getQueryState(key("configurations"))?.isInvalidated).toBe(true);
    expect(h.queryClient.getQueryState(key("audit"))?.isInvalidated).toBe(true);
    expect(h.queryClient.getQueryState(key("rules", "11"))?.isInvalidated).toBe(true);
  });
  it("refreshes a mounted related page after an external invalidation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response("old prices")).mockResolvedValueOnce(response("new prices"));
    const h = harness({
      section: "configurations"
    });
    await done(h);
    act(() => invalidateAdminReads(h.queryClient, project, h.result.current.actor, "rules"));
    await waitFor(() => expect(h.result.current.read.result?.data).toEqual({
      records: [{
        label: "new prices"
      }],
      next_cursor: null
    }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("invalidates disclosure details, configuration selectors and dependent sections without clearing unrelated users", async () => {
    const h = harness({ section: "disclosures", kind: "documents" });
    await done(h);
    const key = (section: AdminReadParams["section"], kind: string, recordId?: string) => adminReadKey(project, h.result.current.actor, instance1, { section, kind, cursor: null, recordId });
    const affected = [key("disclosures", "documents", "3"), key("configurations", "legal_documents"), key("configurations", "configurations", "4"), key("rules", "rules"), key("controls", "controls"), key("audit", "documents")] as const;
    const untouched = [key("users", "accounts"), key("usage", "analytics")];
    for (const queryKey of [...affected, ...untouched]) h.queryClient.setQueryData(queryKey, { context: context(), data: { records: [], next_cursor: null } });
    act(() => h.result.current.read.refreshAfterMutation());
    await done(h);
    expect(affected.every(queryKey => h.queryClient.getQueryState(queryKey)?.isInvalidated)).toBe(true);
    expect(untouched.every(queryKey => !h.queryClient.getQueryState(queryKey)?.isInvalidated)).toBe(true);
  });
  it("refreshes B when an unmounted A's mutation completes after soft navigation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response("profile A")).mockResolvedValueOnce(response("old prices B")).mockResolvedValueOnce(response("updated prices B"));
    const a = harness({
      section: "rules"
    });
    await done(a);
    const completeOldMutation = a.result.current.read.refreshAfterMutation;
    a.unmount();
    const b = harness({
      section: "configurations"
    }, a.auth, a.queryClient);
    await done(b);
    act(() => completeOldMutation());
    await waitFor(() => expect(b.result.current.read.result?.data).toEqual({
      records: [{
        label: "updated prices B"
      }],
      next_cursor: null
    }));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("does not make an already-invalidated in-flight B snapshot fresh after A commits", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockResolvedValueOnce(response("profile A")).mockResolvedValueOnce(response("cached prices B")).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response("prices after A committed"));
    const a = harness({
      section: "rules"
    });
    await done(a);
    const completeOldMutation = a.result.current.read.refreshAfterMutation;
    a.unmount();
    const b = harness({
      section: "configurations"
    }, a.auth, a.queryClient);
    await done(b);
    const key = adminReadKey(project, b.result.current.actor, instance1, {
      section: "configurations",
      kind: "configurations",
      cursor: null
    });
    act(() => b.result.current.read.refreshRead());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(b.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    // Query.invalidate() emits no second notification while this flag is true.
    act(() => completeOldMutation());
    expect(b.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    await act(async () => pending.resolve(response("B snapshot read before A committed")));
    await waitFor(() => expect(b.result.current.read.result?.data).toEqual({
      records: [{
        label: "prices after A committed"
      }],
      next_cursor: null
    }));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("invalidates the same user's current epoch when a pre-refresh mutation commits late", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response("initial")).mockResolvedValueOnce(response("before commit")).mockResolvedValueOnce(response("after commit"));
    const h = harness({
      section: "rules"
    });
    await done(h);
    const complete = h.result.current.read.refreshAfterMutation;
    act(() => h.auth.emit(session("A", "new token"), "TOKEN_REFRESHED"));
    await done(h);
    act(() => complete());
    await waitFor(() => expect(h.result.current.read.result?.data).toEqual({
      records: [{
        label: "after commit"
      }],
      next_cursor: null
    }));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([instance1, instance2])("checks a late commit's instance before accepting an in-flight bootstrap (%s)", async returnedInstance => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockResolvedValueOnce(response("initial")).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response("after commit"));
    const h = harness({
      section: "rules"
    });
    await done(h);
    const complete = h.result.current.read.refreshAfterMutation;
    act(() => h.auth.emit(session("A", "new token"), "TOKEN_REFRESHED"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    act(() => complete());
    await act(async () => pending.resolve(response("in-flight snapshot", returnedInstance)));
    await waitFor(() => expect(h.result.current.read.result?.data).toEqual({
      records: [{
        label: returnedInstance === instance1 ? "after commit" : "in-flight snapshot"
      }],
      next_cursor: null
    }));
    expect(fetch).toHaveBeenCalledTimes(returnedInstance === instance1 ? 3 : 2);
  });
  it.each(["account", "returning-account", "instance"] as const)("rejects a late mutation invalidation after a different %s is active", async transition => {
    vi.mocked(fetch).mockResolvedValueOnce(response("initial"));
    const h = harness({
      section: "rules"
    });
    await done(h);
    const complete = h.result.current.read.refreshAfterMutation;
    if (transition !== "instance") {
      vi.mocked(fetch).mockResolvedValueOnce(response("other account"));
      act(() => h.auth.emit(session("B")));
      await done(h);
      if (transition === "returning-account") {
        vi.mocked(fetch).mockResolvedValueOnce(response("new A visit"));
        act(() => h.auth.emit(session("A", "new A visit token")));
        await done(h);
      }
    } else {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "CLIENT_UPDATE_REQUIRED"
        }
      }), {
        status: 409
      })).mockResolvedValueOnce(response("other instance", instance2));
      act(() => h.result.current.read.refreshRead());
      await done(h);
    }
    const calls = vi.mocked(fetch).mock.calls.length;
    act(() => complete());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it("rechecks every parallel history reader after a second commit during an already-invalidated read", async () => {
    const pendingA = deferred<Response>(), pendingB = deferred<Response>();
    let readsA = 0, readsB = 0;
    vi.mocked(fetch).mockImplementation(async input => {
      const query = new URL(String(input), "http://local.test").searchParams;
      if (query.get("section") !== "audit") return response("writer");
      if (query.get("kind") === "configurations") { readsA++; return readsA === 1 ? response("original configuration audit") : readsA === 2 ? pendingA.promise : response("configuration audit after commit"); }
      readsB++; return readsB === 1 ? response("original price audit") : readsB === 2 ? pendingB.promise : response("price audit after commit");
    });
    const shared = auth(), writer = harness({}, shared); await done(writer);
    const commit = writer.result.current.read.refreshAfterMutation, actor = writer.result.current.actor;
    writer.unmount();
    const a = harness({ section: "audit", kind: "configurations", entityId: "1" }, shared, writer.queryClient); await done(a);
    const b = harness({ section: "audit", kind: "prices", entityId: "1" }, shared, writer.queryClient); await done(b);
    act(() => invalidateAdminReads(writer.queryClient, project, actor, "configurations"));
    await waitFor(() => { expect(readsA).toBe(2); expect(readsB).toBe(2); });
    act(() => commit());
    await act(async () => pendingA.resolve(response("configuration audit snapshot before commit")));
    await waitFor(() => expect(a.result.current.read.result?.data).toEqual({ records: [{ label: "configuration audit after commit" }], next_cursor: null }));
    await act(async () => pendingB.resolve(response("price audit snapshot before commit")));
    await waitFor(() => expect(b.result.current.read.result?.data).toEqual({ records: [{ label: "price audit after commit" }], next_cursor: null }));
    expect(readsA).toBe(3); expect(readsB).toBe(3);
  });

  it("keeps commit boundaries after ordinary cache GC and removes them on owner cleanup", async () => {
    const shared = auth(), writer = harness({}, shared); await done(writer);
    const commit = writer.result.current.read.refreshAfterMutation, actor = writer.result.current.actor;
    writer.unmount();
    vi.useFakeTimers();
    try {
      act(() => commit());
      const reader = harness({ section: "rules", kind: "rules" }, shared, writer.queryClient);
      await vi.waitFor(() => { expect(reader.result.current.read.loading).toBe(false); expect(reader.result.current.read.result).toBeTruthy(); });
      reader.unmount();
      const key = adminReadKey(project, actor, instance1, { section: "rules", kind: "rules", cursor: null });
      expect(writer.queryClient.getQueryData(key)).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(301_000));
      expect(writer.queryClient.getQueryData(key)).toBeUndefined();
      expect(writer.queryClient.getQueryCache().getAll().some(query => query.queryKey[4] === "commit-epochs")).toBe(true);
      act(() => shared.emit(null, "SIGNED_OUT"));
      expect(writer.queryClient.getQueryCache().getAll().some(query => query.queryKey[4] === "commit-epochs")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

});
