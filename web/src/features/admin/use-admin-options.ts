"use client";

import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminRecord } from "@/lib/admin/contract";
import type { AdminSession } from "./admin-session";
import { useAdminRead } from "./admin-read";

/** Paginated selectors reuse the same isolated read cache as business pages. */
export function useAdminOptions(client: SupabaseClient, project: string, actor: AdminSession, kind: "adapters" | "legal_documents" | "configurations", enabled: boolean) {
  const actorOwner = `${project}:${actor.session?.user.id ?? ""}:${actor.epoch}`;
  const [page, setPage] = useState<{
    actor: string;
    cursor: string | null;
  }>({
    actor: actorOwner,
    cursor: null
  });
  if (page.actor !== actorOwner) setPage({
    actor: actorOwner,
    cursor: null
  });
  const cursor = page.actor === actorOwner ? page.cursor : null;
  const read = useAdminRead(client, project, actor, {
    section: "configurations",
    kind,
    cursor,
    limit: 100
  }, enabled);
  const owner = `${actorOwner}:${read.result?.context.database_instance_id ?? "unknown"}`;
  const [accumulated, setAccumulated] = useState<{
    owner: string;
    data: unknown;
    records: AdminRecord[];
  } | null>(null);
  const data = read.result?.data as {
    records: AdminRecord[];
    next_cursor: string | null;
  } | undefined;
  let records = accumulated?.owner === owner ? accumulated.records : [];
  if (enabled && data && !read.loading && !read.error && (accumulated?.owner !== owner || accumulated.data !== data)) {
    const previous = cursor && accumulated?.owner === owner ? accumulated.records : [];
    const merged = new Map([...previous, ...data.records].map(record => [String(record.id ?? record.document_id), record]));
    records = [...merged.values()];
    setAccumulated({
      owner,
      data,
      records
    });
  }
  return {
    ...read,
    records: enabled ? records : [],
    hasMore: Boolean(data?.next_cursor),
    loadMore: () => {
      if (data?.next_cursor && !read.loading) setPage({
        actor: actorOwner,
        cursor: data.next_cursor
      });
    }
  };
}
