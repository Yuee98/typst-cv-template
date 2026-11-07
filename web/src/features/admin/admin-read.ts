"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminReadResponseSchema, adminAnalyticsSchema, adminErrorSchema, adminPageSchema, adminRecordSchema, type AdminContext, type AdminSection } from "@/lib/admin/contract";
import { currentAdminSession, isCurrentAdminSession, registerAdminCache, type AdminSession } from "./admin-session";
export type AdminReadParams = {
  section: AdminSection;
  kind: string;
  cursor: string | null;
  recordId?: string;
};
export type AdminRead = {
  context: AdminContext;
  data: unknown;
};
type Scope = {
  instanceId: string;
  context: AdminContext;
};
type ReadState = {
  owner: AdminSession;
  params: string;
  result: AdminRead | null;
  error: string | null;
  loading: boolean;
};
class ReadError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}
const freshFor = (section: AdminSection) => ["overview", "controls"].includes(section) ? 0 : 30_000;
const ownerKey = (project: string, actor: AdminSession) => ["admin", project, actor.session?.user.id ?? "signed-out", actor.epoch] as const;
const scopeKey = (project: string, actor: AdminSession) => [...ownerKey(project, actor), "scope"] as const;
const pendingInvalidationsKey = (project: string, actor: AdminSession) => [...ownerKey(project, actor), "pending-invalidations"] as const;
type PendingInvalidation = {
  instanceId: string;
  section: AdminSection;
};
export function adminReadKey(project: string, actor: AdminSession, instanceId: string | null, params: AdminReadParams) {
  return [...ownerKey(project, actor), "read", instanceId ?? "bootstrap", params.section, params.kind, params.cursor ?? "", params.recordId ?? ""] as const;
}
function clearOwner(queryClient: QueryClient, project: string, actor: AdminSession) {
  const queryKey = ownerKey(project, actor);
  void queryClient.cancelQueries({
    queryKey
  });
  queryClient.removeQueries({
    queryKey
  });
}
function parseRead(raw: unknown, params: AdminReadParams): AdminRead {
  const result = adminReadResponseSchema.parse(raw);
  if (["overview", "controls"].includes(params.section) && result.data !== null) throw new Error("UNAVAILABLE");
  const data = ["overview", "controls"].includes(params.section) ? null : params.section === "analytics" ? adminAnalyticsSchema.parse(result.data) : params.recordId ? adminRecordSchema.parse(result.data) : adminPageSchema.parse(result.data);
  return {
    context: result.context,
    data
  };
}
const related: Record<AdminSection, AdminSection[]> = {
  overview: ["overview", "controls", "audit"],
  controls: ["overview", "controls", "users", "audit"],
  users: ["overview", "controls", "users", "audit"],
  providers: ["overview", "controls", "providers", "profiles", "prices", "policies", "audit"],
  profiles: ["overview", "controls", "profiles", "prices", "policies", "audit"],
  prices: ["overview", "controls", "prices", "profiles", "policies", "audit"],
  policies: ["overview", "controls", "policies", "audit"],
  analytics: ["overview", "controls", "analytics", "audit"],
  audit: ["overview", "controls", "audit"]
};
export function invalidateAdminReads(queryClient: QueryClient, project: string, actor: AdminSession, section: AdminSection) {
  void queryClient.invalidateQueries({
    queryKey: ownerKey(project, actor),
    predicate: query => query.queryKey[4] === "read" && related[section].includes(query.queryKey[6] as AdminSection)
  });
}
export function useAdminRead(client: SupabaseClient | null, project: string, actor: AdminSession, params: AdminReadParams) {
  const queryClient = useQueryClient();
  const signature = JSON.stringify(params);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<ReadState>({
    owner: actor,
    params: signature,
    result: null,
    error: null,
    loading: false
  });
  const scope = queryClient.getQueryData<Scope>(scopeKey(project, actor));
  const cached = scope ? queryClient.getQueryData<AdminRead>(adminReadKey(project, actor, scope.instanceId, params)) : undefined;
  const cachedResult = useMemo(() => cached && scope ? {
    ...cached,
    context: scope.context
  } : null, [cached, scope]);
  useEffect(() => {
    if (client) registerAdminCache(client, queryClient, project);
    const obsolete = {
      predicate: (query: {
        queryKey: readonly unknown[];
      }) => query.queryKey[0] === "admin" && query.queryKey[1] === project && (query.queryKey[2] !== actor.session?.user.id || query.queryKey[3] !== actor.epoch)
    };
    void queryClient.cancelQueries(obsolete);
    queryClient.removeQueries(obsolete);
    if (!client || !actor.session) return;
    let active = true;
    let inFlight: readonly unknown[] | null = null;
    const current = () => active && isCurrentAdminSession(client, actor);
    const requested = JSON.parse(signature) as AdminReadParams;
    const initialScope = queryClient.getQueryData<Scope>(scopeKey(project, actor));
    const initialData = initialScope ? queryClient.getQueryData<AdminRead>(adminReadKey(project, actor, initialScope.instanceId, requested)) : undefined;
    async function load(retried = false): Promise<AdminRead> {
      const observedInvalidations = queryClient.getQueryData<PendingInvalidation[]>(pendingInvalidationsKey(project, actor)) ?? [];
      const before = queryClient.getQueryData<Scope>(scopeKey(project, actor));
      const key = adminReadKey(project, actor, before?.instanceId ?? null, requested);
      inFlight = key;
      try {
        let fetched = false;
        const result = await queryClient.fetchQuery({
          queryKey: key,
          staleTime: freshFor(requested.section),
          gcTime: 5 * 60_000,
          retry: false,
          queryFn: async ({
            signal
          }) => {
            fetched = true;
            const query = new URLSearchParams({
              section: requested.section
            });
            if (["users", "profiles", "policies"].includes(requested.section)) query.set("kind", requested.kind);
            if (requested.recordId) query.set("id", requested.recordId);else if (!["overview", "controls", "analytics"].includes(requested.section)) {
              query.set("limit", "25");
              if (requested.cursor) query.set("after", requested.cursor);
            }
            if (requested.section === "analytics") query.set("days", "7");
            if (before) query.set("database_instance_id", before.instanceId);
            const response = await fetch(`/api/admin?${query}`, {
              signal,
              cache: "no-store",
              headers: {
                Authorization: `Bearer ${actor.session!.access_token}`
              }
            });
            if (!current() || signal.aborted) throw new DOMException("Obsolete Admin read", "AbortError");
            const raw: unknown = await response.json();
            if (!current() || signal.aborted) throw new DOMException("Obsolete Admin read", "AbortError");
            if (!response.ok) throw new ReadError(adminErrorSchema.parse(raw).error.code, response.status);
            return parseRead(raw, requested);
          }
        });
        if (!current()) throw new DOMException("Obsolete Admin read", "AbortError");
        const latest = queryClient.getQueryData<Scope>(scopeKey(project, actor));
        if (latest && latest.instanceId !== result.context.database_instance_id && latest.instanceId !== before?.instanceId) {
          throw new DOMException("Obsolete Admin instance", "AbortError");
        }
        if (!fetched) return {
          ...result,
          context: latest?.context ?? result.context
        };
        if (before && result.context.database_instance_id !== before.instanceId) throw new ReadError("CLIENT_UPDATE_REQUIRED", 409);
        const pending = queryClient.getQueryData<PendingInvalidation[]>(pendingInvalidationsKey(project, actor)) ?? [];
        queryClient.removeQueries({
          queryKey: pendingInvalidationsKey(project, actor),
          exact: true
        });
        if (pending.some(entry => !observedInvalidations.includes(entry) && entry.instanceId === result.context.database_instance_id && related[entry.section].includes(requested.section))) {
          // This bootstrap read began before the same-instance write committed.
          // Discard its old snapshot; a different instance never takes this path.
          queryClient.removeQueries({
            queryKey: key,
            exact: true
          });
          return load(retried);
        }
        queryClient.setQueryData(scopeKey(project, actor), {
          instanceId: result.context.database_instance_id,
          context: result.context
        });
        if (!before) {
          queryClient.setQueryData(adminReadKey(project, actor, result.context.database_instance_id, requested), result);
          queryClient.removeQueries({
            queryKey: key,
            exact: true
          });
        }
        return result;
      } catch (error) {
        if (!current()) throw error;
        if (error instanceof ReadError && [401, 403].includes(error.status)) clearOwner(queryClient, project, actor);
        if (error instanceof ReadError && error.code === "CLIENT_UPDATE_REQUIRED" && !retried) {
          clearOwner(queryClient, project, actor);
          return load(true);
        }
        throw error;
      }
    }
    // fetchQuery has no QueryObserver. A mounted read must explicitly react to
    // invalidation by another page's late mutation, as well as its own actions.
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (!current() || event.type !== "updated" || event.action.type !== "invalidate") return;
      const latest = queryClient.getQueryData<Scope>(scopeKey(project, actor));
      const key = adminReadKey(project, actor, latest?.instanceId ?? null, requested);
      if (JSON.stringify(event.query.queryKey) === JSON.stringify(key)) setRefresh(value => value + 1);
    });
    queueMicrotask(() => {
      if (!current()) return;
      setState({
        owner: actor,
        params: signature,
        result: initialData ? {
          ...initialData,
          context: initialScope!.context
        } : null,
        error: null,
        loading: true
      });
      void load().then(result => {
        if (current()) setState({
          owner: actor,
          params: signature,
          result,
          error: null,
          loading: false
        });
      }).catch(error => {
        if (current()) setState({
          owner: actor,
          params: signature,
          result: null,
          error: error instanceof Error ? error.message : "UNAVAILABLE",
          loading: false
        });
      });
    });
    return () => {
      active = false;
      unsubscribe();
      if (inFlight) void queryClient.cancelQueries({
        queryKey: inFlight,
        exact: true
      });
    };
  }, [client, project, actor, signature, refresh, queryClient]);
  const refreshRead = useCallback(() => {
    const latest = queryClient.getQueryData<Scope>(scopeKey(project, actor));
    void queryClient.invalidateQueries({
      queryKey: adminReadKey(project, actor, latest?.instanceId ?? null, JSON.parse(signature) as AdminReadParams),
      exact: true
    });
    setRefresh(value => value + 1);
  }, [queryClient, project, actor, signature]);
  const refreshAfterMutation = useCallback(() => {
    if (!client || !actor.session || !scope) return;
    const latestActor = currentAdminSession(client);
    if (latestActor.session?.user.id !== actor.session.user.id || latestActor.principalEpoch !== actor.principalEpoch) return;
    const latestScope = queryClient.getQueryData<Scope>(scopeKey(project, latestActor));
    const section = (JSON.parse(signature) as AdminReadParams).section;
    if (latestScope && latestScope.instanceId !== scope.instanceId) return;
    // Commit boundaries must survive repeated invalidate() calls while a read
    // is already invalidated. Keep only instance/section provenance, never data.
    queryClient.setQueryData<PendingInvalidation[]>(pendingInvalidationsKey(project, latestActor), current => [...(current ?? []), {
      instanceId: scope.instanceId,
      section
    }]);
    if (!latestScope) return;
    invalidateAdminReads(queryClient, project, latestActor, section);
    if (latestActor === actor) refreshRead();
  }, [client, queryClient, project, actor, signature, refreshRead, scope]);
  const visible = state.owner === actor && state.params === signature ? state : null;
  return {
    result: visible?.result ?? cachedResult,
    error: visible?.error ?? null,
    loading: visible?.loading ?? Boolean(actor.session),
    refreshRead,
    refreshAfterMutation
  };
}
