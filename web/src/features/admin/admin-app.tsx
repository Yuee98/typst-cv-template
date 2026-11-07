"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { adminContextSchema, adminPageSchema, adminRecordSchema, adminAnalyticsSchema, adminErrorSchema, type AdminContext, type AdminRecord, type AdminSection, ADMIN_SECTIONS } from "@/lib/admin/contract";
import { adminMessages, type AdminMessages } from "./messages";
import { adminNavigationPath, adminOAuthRedirectUrl } from "./navigation";
import { AdminSecuritySettings } from "./security-settings";
import { AdminRecordActions } from "./record-actions";
import { AdminRuntimeControls } from "./runtime-controls";
export function localizedAdminValue(value: unknown, locale: string, t: AdminMessages) {
  if (typeof value === "boolean") return value ? t.yes : t.no;
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toLocaleString(locale);
  return String(value);
}
export function buildAdminQuery(query: {
  after: string;
  limit: number;
}) {
  const params = new URLSearchParams();
  if (query.after) params.set("after", query.after);
  if (query.limit !== 25) params.set("limit", String(query.limit));
  return params.size ? `?${params}` : "";
}
export default function AdminApp({
  locale,
  section = "overview",
  recordId
}: {
  locale: "zh" | "en";
  section?: AdminSection;
  recordId?: string;
}) {
  const t = adminMessages[locale];
  const client = useMemo(() => getSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [credentials, setCredentials] = useState({
    email: "",
    password: ""
  });
  const [context, setContext] = useState<AdminContext | null>(null);
  const [records, setRecords] = useState<AdminRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [recordKind, setRecordKind] = useState(section === "users" ? "accounts" : "versions");
  const [analytics, setAnalytics] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const principal = useRef<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    let observed = false;
    void client.auth.getSession().then(({
      data,
      error
    }) => {
      if (alive && !observed) {
        if (error) setError(t.unavailable);else {
          principal.current = data.session?.user.id ?? null;
          setSession(data.session);
        }
      }
    }).catch(() => {
      if (alive && !observed) setError(t.unavailable);
    });
    const {
      data
    } = client.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      observed = true;
      generation.current++;
      const nextPrincipal = next?.user.id ?? null;
      if (principal.current !== nextPrincipal) {
        setContext(null);
        setRecords([]);
        setAnalytics(null);
      }
      principal.current = nextPrincipal;
      setSession(next);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [client, t.unavailable]);
  const load = useCallback(async () => {
    if (!session) return;
    const seq = ++generation.current;
    setBusy(true);
    setError(null);
    const get = async (path: string) => {
      const response = await fetch(`/api/admin?${path}`, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${session.access_token}`
        }
      });
      const raw: unknown = await response.json();
      if (!response.ok) throw new Error(adminErrorSchema.parse(raw).error.code);
      return raw;
    };
    try {
      const current = adminContextSchema.parse(await get("section=overview"));
      let rows: AdminRecord[] = [];
      let next: string | null = null;
      let aggregate: Record<string, unknown> | null = null;
      if (section === "analytics") aggregate = adminAnalyticsSchema.parse(await get("section=analytics&days=7"));else if (!["overview", "controls"].includes(section)) {
        const query = new URLSearchParams({
          section
        });
        if (["profiles", "policies", "users"].includes(section)) query.set("kind", recordKind);
        if (recordId) query.set("id", recordId);else {
          query.set("limit", "25");
          if (cursor) query.set("after", cursor);
        }
        const raw = await get(query.toString());
        if (recordId) rows = [adminRecordSchema.parse(raw)];else {
          const page = adminPageSchema.parse(raw);
          rows = page.records;
          next = page.next_cursor;
        }
      }
      if (seq !== generation.current) return;
      setContext(current);
      setRecords(rows);
      setNextCursor(next);
      setAnalytics(aggregate);
    } catch (err) {
      if (seq === generation.current) {
        setContext(null);
        setRecords([]);
        setAnalytics(null);
        setError(err instanceof Error ? err.message : t.loadFailed);
      }
    } finally {
      if (seq === generation.current) setBusy(false);
    }
  }, [session, section, recordId, cursor, recordKind, t.loadFailed]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
    };
  }, [load, refresh]);
  async function signIn() {
    if (!client) return;
    setBusy(true);
    const {
      error
    } = await client.auth.signInWithPassword(credentials);
    setCredentials({
      email: credentials.email,
      password: ""
    });
    if (error) setError(error.message);
    setBusy(false);
  }
  if (!client) return <main className="space-y-4 p-8"><a href={`/${locale}`} referrerPolicy="no-referrer" className="underline">{t.backToEditor}</a><p>{t.noConfiguration}</p></main>;
  if (!session) return <main className="mx-auto max-w-md space-y-4 p-8"><a href={`/${locale}`} referrerPolicy="no-referrer" className="underline">{t.backToEditor}</a><h1 className="text-xl font-semibold">{t.loginTitle}</h1><Input aria-label={t.email} type="email" value={credentials.email} onChange={e => setCredentials({
      ...credentials,
      email: e.target.value
    })} /><Input aria-label={t.password} type="password" value={credentials.password} onChange={e => setCredentials({
      ...credentials,
      password: e.target.value
    })} /><Button disabled={busy} onClick={() => void signIn()}>{t.signIn}</Button><Button variant="secondary" onClick={() => void client.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: adminOAuthRedirectUrl(window.location.origin, locale)
      }
    })}>{t.github}</Button>{error && <p role="alert">{error}</p>}</main>;
  const selected = recordId ? records[0] : null;
  return <main className="min-h-screen space-y-5 bg-background p-4 text-foreground md:p-8"><header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{t.brand}</h1><div className="flex gap-3"><a href={`/${locale}`} referrerPolicy="no-referrer" className="underline">{t.backToEditor}</a><Button variant="secondary" onClick={() => void client.auth.signOut()}>{t.signOut}</Button></div></header><nav className="flex flex-wrap gap-3">{ADMIN_SECTIONS.map(item => <a key={item} href={adminNavigationPath(locale, item) ?? undefined} aria-current={section === item ? "page" : undefined} className={section === item ? "font-semibold underline" : "text-foreground-muted"}>{t[item]}</a>)}</nav><Button variant="secondary" disabled={busy} onClick={() => setRefresh(n => n + 1)}>{locale === "zh" ? "刷新" : "Refresh"}</Button>{error && <p role="alert">{error}</p>}
 {context && <><p className="text-sm text-foreground-muted">{t.environment}: {context.environment} · {context.database_instance_id} · {context.member_id}</p>
 {section === "overview" && <><dl className="grid gap-3 sm:grid-cols-2">{Object.entries(context.control).map(([key, value]) => <div key={key}><dt className="text-sm capitalize text-foreground-muted">{key.replaceAll("_", " ")}</dt><dd>{localizedAdminValue(value, locale, t)}</dd></div>)}</dl><AdminSecuritySettings client={client} t={t} /></>}
 {section === "controls" && <AdminRuntimeControls context={context} accessToken={session.access_token} locale={locale} onCommitted={() => setRefresh(n => n + 1)} />}
 {section === "analytics" && analytics && <dl className="space-y-4">{Object.entries(analytics).map(([key, value]) => <div key={key}><dt className="font-medium capitalize">{key.replaceAll("_", " ")}</dt><dd className="whitespace-pre-wrap break-all text-sm">{localizedAdminValue(value, locale, t)}</dd></div>)}</dl>}
 {!["overview", "controls", "analytics"].includes(section) && <>{["profiles", "policies", "users"].includes(section) && !recordId && <select aria-label="Record kind" className="rounded border p-2" value={recordKind} onChange={event => {
          setRecordKind(event.target.value);
          setCursor(null);
        }}>{section === "users" ? <><option value="accounts">{locale === "zh" ? "账户" : "Accounts"}</option><option value="members">{locale === "zh" ? "管理员资格" : "Administrators"}</option></> : <><option value="versions">{locale === "zh" ? "配置版本" : "Versions"}</option><option value="identities">{locale === "zh" ? "配置身份" : "Identities"}</option></>}</select>}<div className="space-y-3">{records.map((record, index) => <article key={String(record.external_id ?? record.id ?? index)} className="rounded border border-border p-4"><dl className="grid gap-3 md:grid-cols-2">{Object.entries(record).map(([key, value]) => <div key={key}><dt className="text-xs capitalize text-foreground-muted">{key.replaceAll("_", " ")}</dt><dd className="whitespace-pre-wrap break-all text-sm">{localizedAdminValue(value, locale, t)}</dd></div>)}</dl>{!recordId && typeof record.external_id === "string" && <a className="mt-2 block underline" href={`${adminNavigationPath(locale, section)}/${encodeURIComponent(record.external_id)}`}>{locale === "zh" ? "查看详情" : "Details"}</a>}</article>)}</div>{nextCursor && <Button variant="secondary" onClick={() => setCursor(nextCursor)}>{locale === "zh" ? "下一页" : "Next page"}</Button>}<AdminRecordActions key={`${session.user.id}:${context.database_instance_id}:${section}:${recordId ?? "list"}`} section={section} context={context} record={selected} accessToken={session.access_token} locale={locale} onCommitted={() => setRefresh(n => n + 1)} /></>}
 </>}
 </main>;
}
