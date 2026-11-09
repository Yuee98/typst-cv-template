"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { QueryClient } from "@tanstack/react-query";
export type AdminSession = Readonly<{
  session: Session | null;
  epoch: number;
  principalEpoch: number;
  ready: boolean;
  error: boolean;
}>;
const initial: AdminSession = {
  session: null,
  epoch: 0,
  principalEpoch: 0,
  ready: false,
  error: false
};
const absent: AdminSession = {
  ...initial,
  ready: true
};
const stores = new WeakMap<SupabaseClient, ReturnType<typeof createStore>>();
function createStore(client: SupabaseClient) {
  let state = initial;
  let started = false;
  let observed = false;
  const listeners = new Set<() => void>();
  const registered = new WeakMap<QueryClient, Set<string>>();
  const caches = new Set<{
    cache: WeakRef<QueryClient>;
    project: string;
  }>();
  function update(session: Session | null, error = false) {
    const principalChanged = state.session?.user.id !== session?.user.id;
    const changed = state.session?.user.id !== session?.user.id || state.session?.access_token !== session?.access_token;
    if (state.ready && !changed && state.error === error) return;
    state = {
      session,
      epoch: state.epoch + Number(changed),
      principalEpoch: state.principalEpoch + Number(principalChanged),
      ready: true,
      error
    };
    if (changed) for (const entry of caches) {
      const cache = entry.cache.deref();
      if (!cache) {
        caches.delete(entry);
        continue;
      }
      const predicate = {
        predicate: (query: {
          queryKey: readonly unknown[];
        }) => query.queryKey[0] === "admin" && query.queryKey[1] === entry.project && (query.queryKey[2] !== session?.user.id || query.queryKey[3] !== state.epoch)
      };
      void cache.cancelQueries(predicate);
      cache.removeQueries(predicate);
    }
    for (const listener of listeners) listener();
  }
  return {
    snapshot: () => state,
    registerCache(cache: QueryClient, project: string) {
      let projects = registered.get(cache);
      if (!projects) {
        projects = new Set();
        registered.set(cache, projects);
      }
      if (projects.has(project)) return;
      projects.add(project);
      caches.add({
        cache: new WeakRef(cache),
        project
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!started) {
        started = true;
        // One subscription survives Admin page remounts during soft navigation.
        client.auth.onAuthStateChange((_event, session) => {
          observed = true;
          update(session);
        });
        void client.auth.getSession().then(({
          data,
          error
        }) => {
          if (!observed) update(error ? null : data.session, Boolean(error));
        }).catch(() => {
          if (!observed) update(null, true);
        });
      }
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
function storeFor(client: SupabaseClient) {
  let store = stores.get(client);
  if (!store) {
    store = createStore(client);
    stores.set(client, store);
  }
  return store;
}
export function isCurrentAdminSession(client: SupabaseClient, session: AdminSession) {
  return storeFor(client).snapshot() === session;
}
export function currentAdminSession(client: SupabaseClient) {
  return storeFor(client).snapshot();
}
export function registerAdminCache(client: SupabaseClient, cache: QueryClient, project: string) {
  storeFor(client).registerCache(cache, project);
}
export function useAdminSession(client: SupabaseClient | null): AdminSession {
  const store = useMemo(() => client ? storeFor(client) : null, [client]);
  return useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.snapshot ?? (() => absent), () => initial);
}
