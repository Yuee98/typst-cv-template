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
  entityId?: string;
  limit?: number;
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
const freshFor = (section: AdminSection) => ["controls"].includes(section) ? 0 : 30_000;
const ownerKey = (project: string, actor: AdminSession) => ["admin", project, actor.session?.user.id ?? "signed-out", actor.epoch] as const;
const scopeKey = (project: string, actor: AdminSession) => [...ownerKey(project, actor), "scope"] as const;
const commitEpochPrefix = (project: string, actor: AdminSession) => [...ownerKey(project, actor), "commit-epochs"] as const;
const commitEpochKey = (project: string, actor: AdminSession, instanceId: string) => [...commitEpochPrefix(project, actor), instanceId] as const;
type CommitEpochs = Partial<Record<AdminSection, number>>;
export function adminReadKey(project: string, actor: AdminSession, instanceId: string | null, params: AdminReadParams) {
  return [...ownerKey(project, actor), "read", instanceId ?? "bootstrap", params.section, params.kind, params.cursor ?? "", params.recordId ?? "", params.entityId ?? "", params.limit ?? 25] as const;
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
  if (["controls"].includes(params.section) && result.data !== null) throw new Error("UNAVAILABLE");
  const data = ["controls"].includes(params.section) ? null : params.section === "usage" && params.kind === "analytics" ? adminAnalyticsSchema.parse(result.data) : params.recordId ? adminRecordSchema.parse(result.data) : adminPageSchema.parse(result.data);
  return {
    context: result.context,
    data
  };
}
const related: Record<AdminSection, AdminSection[]> = {
  configurations: ["configurations", "rules", "controls", "usage", "audit"],
  rules: ["rules", "configurations", "controls", "audit"],
  controls: ["controls", "users", "audit"],
  usage: ["usage", "audit"],
  users: ["users", "controls", "audit"],
  audit: ["audit"]
};
export function invalidateAdminReads(queryClient: QueryClient, project: string, actor: AdminSession, section: AdminSection) {
  void queryClient.invalidateQueries({
    queryKey: ownerKey(project, actor),
    predicate: query => query.queryKey[4] === "read" && related[section].includes(query.queryKey[6] as AdminSection)
  });
}
export function useAdminRead(client: SupabaseClient | null, project: string, actor: AdminSession, params: AdminReadParams, enabled = true) {
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
    if (!enabled || !client || !actor.session) return;
    let active = true;
    let inFlight: readonly unknown[] | null = null;
    const current = () => active && isCurrentAdminSession(client, actor);
    const requested = JSON.parse(signature) as AdminReadParams;
    const initialScope = queryClient.getQueryData<Scope>(scopeKey(project, actor));
    const initialData = initialScope ? queryClient.getQueryData<AdminRead>(adminReadKey(project, actor, initialScope.instanceId, requested)) : undefined;
    async function load(retried = false): Promise<AdminRead> {
      const observedEpochs = queryClient.getQueriesData<CommitEpochs>({ queryKey: commitEpochPrefix(project, actor) });
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
            if (requested.section !== "controls") query.set("kind", requested.kind);
            if (requested.recordId) query.set("id", requested.recordId);else if (requested.section !== "controls" && !(requested.section === "usage" && requested.kind === "analytics")) {
              query.set("limit", String(requested.limit ?? 25));
              if (requested.cursor) query.set("after", requested.cursor);
            }
            if (requested.section === "usage" && requested.kind === "analytics") query.set("days", "7");
            if (requested.entityId) query.set("entity_id", requested.entityId);
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
        const instanceId = result.context.database_instance_id;
        const observedEpoch = observedEpochs.find(([key]) => key[5] === instanceId)?.[1]?.[requested.section] ?? 0;
        const currentEpoch = queryClient.getQueryData<CommitEpochs>(commitEpochKey(project, actor, instanceId))?.[requested.section] ?? 0;
        if (currentEpoch > observedEpoch) {
          // Every reader independently verifies its own start boundary. One
          // completed read cannot consume another in-flight read's commit.
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
  }, [client, project, actor, signature, refresh, queryClient, enabled]);
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
    // Six bounded section counters per instance, scoped to this actor epoch.
    // Retain them until owner cleanup so parallel readers cannot consume them.
    queryClient.setQueryData<CommitEpochs>(commitEpochKey(project, latestActor, scope.instanceId), previous => {
      const next = { ...previous };
      for (const affected of related[section]) next[affected] = (previous?.[affected] ?? 0) + 1;
      return next;
    });
    if (!latestScope) return;
    invalidateAdminReads(queryClient, project, latestActor, section);
    if (latestActor === actor) refreshRead();
  }, [client, queryClient, project, actor, signature, refreshRead, scope]);
  const visible = state.owner === actor && state.params === signature ? state : null;
  return {
    result: visible?.result ?? cachedResult,
    error: visible?.error ?? null,
    loading: enabled && (visible?.loading ?? Boolean(actor.session)),
    refreshRead,
    refreshAfterMutation
  };
}
