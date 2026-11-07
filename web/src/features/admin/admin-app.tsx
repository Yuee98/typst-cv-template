"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSupabaseBrowserClient, getSupabaseConfig } from "@/lib/supabase/client";
import { type AdminRecord, type AdminSection, ADMIN_SECTIONS } from "@/lib/admin/contract";
import { useAdminSession } from "./admin-session";
import { useAdminRead, type AdminRead } from "./admin-read";
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
  const actor = useAdminSession(client);
  const session = actor.session;
  const [credentials, setCredentials] = useState({
    email: "",
    password: ""
  });
  const [authBusy, setAuthBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [selection, setSelection] = useState({
    section,
    kind: section === "users" ? "accounts" : "versions",
    cursor: null as string | null
  });
  if (selection.section !== section) setSelection({
    section,
    kind: section === "users" ? "accounts" : "versions",
    cursor: null
  });
  // The catch-all route can reuse this component across sections. Never send a
  // previous section's kind/cursor or display its rows during that transition.
  const recordKind = selection.section === section ? selection.kind : section === "users" ? "accounts" : "versions";
  const cursor = selection.section === section ? selection.cursor : null;
  const project = getSupabaseConfig().url;
  const read = useAdminRead(client, project, actor, {
    section,
    kind: recordKind,
    cursor,
    recordId
  });
  const viewOwner = JSON.stringify([project, session?.user.id ?? null, section, recordId, recordKind, cursor]);
  const [presentation, setPresentation] = useState<{
    owner: string;
    result: AdminRead;
  } | null>(null);
  const denied = read.error === "UNAUTHORIZED" || read.error === "FORBIDDEN" || read.error === "CLIENT_UPDATE_REQUIRED";
  // Preserve mounted form state only within this user's exact page. During a
  // new-token read these props are hidden and disabled, never used as authority.
  if (!read.loading && read.result && !read.error) {
    if (presentation?.owner !== viewOwner || presentation.result !== read.result) setPresentation({
      owner: viewOwner,
      result: read.result
    });
  } else if (presentation && (presentation.owner !== viewOwner || denied)) setPresentation(null);
  const view = read.result ?? (!denied && presentation?.owner === viewOwner ? presentation.result : null);
  const viewReady = Boolean(read.result && !read.loading && !read.error);
  const context = view?.context ?? null;
  const data = view?.data;
  const records: AdminRecord[] = recordId ? data ? [data as AdminRecord] : [] : data && typeof data === "object" && "records" in data ? (data as {
    records: AdminRecord[];
  }).records : [];
  const nextCursor = data && typeof data === "object" && "next_cursor" in data ? (data as {
    next_cursor: string | null;
  }).next_cursor : null;
  const analytics = section === "analytics" ? data as Record<string, unknown> | null : null;
  const error = actor.error ? t.unavailable : signInError ?? read.error;
  const busy = authBusy || read.loading;
  async function signIn() {
    if (!client) return;
    setSignInError(null);
    setAuthBusy(true);
    const {
      error
    } = await client.auth.signInWithPassword(credentials);
    setCredentials({
      email: credentials.email,
      password: ""
    });
    if (error) setSignInError(error.message);
    setAuthBusy(false);
  }
  if (!client) return <main className="space-y-4 p-8"><a href={`/${locale}`} referrerPolicy="no-referrer" className="underline">{t.backToEditor}</a><p>{t.noConfiguration}</p></main>;
  if (!actor.ready) return <main className="space-y-4 p-8"><a href={`/${locale}`} referrerPolicy="no-referrer" className="underline">{t.backToEditor}</a><p>{locale === "zh" ? "正在加载…" : "Loading…"}</p></main>;
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
  return <main className="min-h-screen space-y-5 bg-background p-4 text-foreground md:p-8"><header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{t.brand}</h1><div className="flex gap-3"><a href={`/${locale}`} referrerPolicy="no-referrer" className="underline">{t.backToEditor}</a><Button variant="secondary" onClick={() => void client.auth.signOut()}>{t.signOut}</Button></div></header><nav className="flex flex-wrap gap-3">{ADMIN_SECTIONS.map(item => <Link key={item} href={adminNavigationPath(locale, item)!} aria-current={section === item ? "page" : undefined} className={section === item ? "font-semibold underline" : "text-foreground-muted"}>{t[item]}</Link>)}</nav><Button variant="secondary" disabled={busy} onClick={read.refreshRead}>{locale === "zh" ? "刷新" : "Refresh"}</Button>{error && <p role="alert">{error}</p>}
 {context && <section key={`${viewOwner}:${context.database_instance_id}`} hidden={!viewReady} aria-busy={!viewReady}><fieldset disabled={!viewReady} className="space-y-5"><p className="text-sm text-foreground-muted">{t.environment}: {context.environment} · {context.database_instance_id} · {context.member_id}</p>
 {section === "overview" && <><dl className="grid gap-3 sm:grid-cols-2">{Object.entries(context.control).map(([key, value]) => <div key={key}><dt className="text-sm capitalize text-foreground-muted">{key.replaceAll("_", " ")}</dt><dd>{localizedAdminValue(value, locale, t)}</dd></div>)}</dl><AdminSecuritySettings client={client} t={t} /></>}
 {section === "controls" && <AdminRuntimeControls context={context} accessToken={session.access_token} locale={locale} onCommitted={read.refreshAfterMutation} />}
 {section === "analytics" && analytics && <dl className="space-y-4">{Object.entries(analytics).map(([key, value]) => <div key={key}><dt className="font-medium capitalize">{key.replaceAll("_", " ")}</dt><dd className="whitespace-pre-wrap break-all text-sm">{localizedAdminValue(value, locale, t)}</dd></div>)}</dl>}
 {!["overview", "controls", "analytics"].includes(section) && <>{["profiles", "policies", "users"].includes(section) && !recordId && <select aria-label="Record kind" className="rounded border p-2" value={recordKind} onChange={event => {
            setSelection({
              section,
              kind: event.target.value,
              cursor: null
            });
          }}>{section === "users" ? <><option value="accounts">{locale === "zh" ? "账户" : "Accounts"}</option><option value="members">{locale === "zh" ? "管理员资格" : "Administrators"}</option></> : <><option value="versions">{locale === "zh" ? "配置版本" : "Versions"}</option><option value="identities">{locale === "zh" ? "配置身份" : "Identities"}</option></>}</select>}<div className="space-y-3">{records.map((record, index) => <article key={String(record.external_id ?? record.id ?? index)} className="rounded border border-border p-4"><dl className="grid gap-3 md:grid-cols-2">{Object.entries(record).map(([key, value]) => <div key={key}><dt className="text-xs capitalize text-foreground-muted">{key.replaceAll("_", " ")}</dt><dd className="whitespace-pre-wrap break-all text-sm">{localizedAdminValue(value, locale, t)}</dd></div>)}</dl>{!recordId && typeof record.external_id === "string" && <Link className="mt-2 block underline" href={`${adminNavigationPath(locale, section)}/${encodeURIComponent(record.external_id)}`}>{locale === "zh" ? "查看详情" : "Details"}</Link>}</article>)}</div>{nextCursor && <Button variant="secondary" onClick={() => setSelection({
            section,
            kind: recordKind,
            cursor: nextCursor
          })}>{locale === "zh" ? "下一页" : "Next page"}</Button>}<AdminRecordActions key={`${session.user.id}:${context.database_instance_id}:${section}:${recordId ?? "list"}`} section={section} context={context} record={selected} accessToken={session.access_token} locale={locale} onCommitted={read.refreshAfterMutation} /></>}
 </fieldset></section>}
 </main>;
}
