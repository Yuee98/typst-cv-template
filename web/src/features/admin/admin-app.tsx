"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { getSupabaseBrowserClient, getSupabaseConfig } from "@/lib/supabase/client";
import type { AdminRecord, AdminSection } from "@/lib/admin/contract";
import { useAdminSession } from "./admin-session";
import { useAdminRead, type AdminRead } from "./admin-read";
import { adminMessages } from "./messages";
import { adminOAuthRedirectUrl } from "./navigation";
import { AdminRuntimeControls } from "./runtime-controls";
import { AdminShell } from "./admin-shell";
import { AdminAuthPanel } from "./admin-auth-panel";
import { AdminEntityDialog } from "./admin-entity-dialog";
import { UsageStatistics } from "./usage-statistics";
import { adminDate, rulePeriod, auditKindLabel, statusLabel } from "./format";
const defaultKind = (section: AdminSection) => section === "usage" ? "analytics" : section === "users" ? "accounts" : section === "audit" ? "configurations" : section === "disclosures" ? "documents" : section;
type Selection = {
  section: AdminSection;
  kind: string;
  cursor: string | null;
  dialog: null | {
    owner: string;
    record: AdminRecord | null;
    mode: "view" | "edit" | "create";
  };
};
export default function AdminApp({
  locale,
  section = "controls"
}: {
  locale: "zh" | "en";
  section?: AdminSection;
}) {
  const t = adminMessages[locale],
    l = (en: string, zh: string) => locale === "zh" ? zh : en;
  const client = useMemo(() => getSupabaseBrowserClient(), []),
    actor = useAdminSession(client),
    session = actor.session;
  const [credentials, setCredentials] = useState({
    email: "",
    password: ""
  });
  const [authBusy, setAuthBusy] = useState(false),
    [signInError, setSignInError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({
    section,
    kind: defaultKind(section),
    cursor: null,
    dialog: null
  });
  if (selection.section !== section) setSelection({
    section,
    kind: defaultKind(section),
    cursor: null,
    dialog: null
  });
  const currentSelection = selection.section === section ? selection : {
    section,
    kind: defaultKind(section),
    cursor: null,
    dialog: null
  };
  const project = getSupabaseConfig().url;
  const read = useAdminRead(client, project, actor, {
    section,
    kind: currentSelection.kind,
    cursor: currentSelection.cursor
  });
  const owner = JSON.stringify([project, session?.user.id ?? null, actor.principalEpoch, section, currentSelection.kind, currentSelection.cursor]);
  const [presentation, setPresentation] = useState<{
    owner: string;
    result: AdminRead;
  } | null>(null);
  const denied = ["UNAUTHORIZED", "FORBIDDEN", "CLIENT_UPDATE_REQUIRED"].includes(read.error ?? "");
  if (!read.loading && read.result && !read.error) {
    if (presentation?.owner !== owner || presentation.result !== read.result) setPresentation({
      owner,
      result: read.result
    });
  } else if (presentation && (presentation.owner !== owner || denied)) setPresentation(null);
  const view = read.result ?? (!denied && presentation?.owner === owner ? presentation.result : null),
    ready = Boolean(read.result && !read.loading && !read.error);
  const context = view?.context ?? null,
    data = view?.data;
  const records = data && typeof data === "object" && "records" in data ? (data as {
    records: AdminRecord[];
  }).records : [];
  const nextCursor = data && typeof data === "object" && "next_cursor" in data ? (data as {
    next_cursor: string | null;
  }).next_cursor : null;
  const error = actor.error ? t.unavailable : signInError ?? read.error;
  const busy = authBusy || read.loading;
  async function signIn() {
    if (!client) return;
    setSignInError(null);
    setAuthBusy(true);
    try {
      const {
        error
      } = await client.auth.signInWithPassword(credentials);
      setCredentials({
        email: credentials.email,
        password: ""
      });
      if (error) setSignInError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }
  if (!client) return <AdminShell locale={locale} t={t}><p role="status" className="rounded-xl border border-border bg-surface p-6">{t.noConfiguration}</p></AdminShell>;
  if (!actor.ready) return <AdminShell locale={locale} t={t}><p role="status">{l("Loading…", "正在加载…")}</p></AdminShell>;
  if (!session) return <AdminShell locale={locale} t={t}><AdminAuthPanel t={t} email={credentials.email} password={credentials.password} busy={busy} error={error} onEmailChange={email => setCredentials(current => ({
      ...current,
      email
    }))} onPasswordChange={password => setCredentials(current => ({
      ...current,
      password
    }))} onSubmit={() => void signIn()} onGithubSignIn={() => void client.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: adminOAuthRedirectUrl(window.location.origin, locale)
      }
    })} /></AdminShell>;
  const mayCreate = ["configurations", "disclosures", "rules"].includes(section) || section === "users" && currentSelection.kind !== "accounts";
  const choose = (kind: string) => setSelection({
    section,
    kind,
    cursor: null,
    dialog: null
  });
  const dialogOwner = `${project}:${session.user.id}:${actor.principalEpoch}:${context?.database_instance_id ?? "unknown"}`;
  const dialog = currentSelection.dialog?.owner === dialogOwner ? currentSelection.dialog : null;
  if (currentSelection.dialog && context && !dialog) setSelection({
    ...currentSelection,
    dialog: null
  });
  return <AdminShell locale={locale} t={t} section={section} environment={context?.environment} onSignOut={() => void client.auth.signOut()}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t[section]}</h2><div className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={read.refreshRead}>{l("Refresh", "刷新")}</Button>{mayCreate && context && <Button disabled={!ready} onClick={() => setSelection({
          ...currentSelection,
          dialog: {
            owner: dialogOwner,
            record: null,
            mode: "create"
          }
        })}>{l("New", "新建")}</Button>}</div></div>
    {busy && <p role="status" className="text-sm text-foreground-muted">{l("Loading…", "正在加载…")}</p>}
    {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger-foreground">{error}</p>}
    {context && <section key={`${owner}:${context.database_instance_id}`} hidden={!ready} aria-busy={!ready}>
      <fieldset disabled={!ready} className="min-w-0 space-y-5">
        {section === "controls" ? <><AdminRuntimeControls client={client} actor={actor} context={context} locale={locale} enabled={ready} onCommitted={read.refreshAfterMutation} /></> : <>
          {section === "usage" && <div className="flex gap-2">{[["analytics", l("Statistics", "统计")], ["requests", l("Requests", "请求")]].map(([value, label]) => <Button key={value} variant={currentSelection.kind === value ? "default" : "secondary"} onClick={() => choose(value)}>{label}</Button>)}</div>}
          {section === "users" && <div className="flex flex-wrap gap-2">{[["accounts", l("Accounts", "账户")], ["members", l("Administrators", "管理员")], ["allowed_users", l("Allowed AI accounts", "AI 允许账户")]].map(([value, label]) => <Button key={value} variant={currentSelection.kind === value ? "default" : "secondary"} onClick={() => choose(value)}>{label}</Button>)}</div>}
          {section === "audit" && <label className="block space-y-1 text-sm"><span>{l("Record type", "记录类型")}</span><select className="h-10 max-w-full rounded-md border border-border bg-surface px-3" value={currentSelection.kind} onChange={event => choose(event.target.value)}>{[["configurations", l("Configurations", "配置")], ["prices", l("Prices", "价格")], ["rules", l("Time rules", "时间规则")], ["rule_members", l("Rule options", "规则选项")], ["runtime_control", l("Runtime controls", "运行控制")], ["allowed_users", l("Allowed accounts", "允许账户")], ["documents", l("Legal documents", "法律文档")], ["acceptances", l("Acceptance records", "同意记录")], ["members", l("Administrators", "管理员")]].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
          {section === "usage" && currentSelection.kind === "analytics" ? <UsageStatistics key={`${owner}:${context.database_instance_id}`} data={data as {
            global_quota: AdminRecord[];
            configurations: AdminRecord[];
          }} locale={locale} enabled={ready} /> : <div className="overflow-hidden rounded-xl border border-border bg-surface divide-y divide-border">
            {records.length === 0 && <p className="p-5 text-sm text-foreground-muted">{l("No records.", "暂无记录。")}</p>}
            {records.map((record, index) => <div key={String(record.audit_id ?? record.document_id ?? record.id ?? record.auth_user_id ?? index)} className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-4"><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium">{section === "rules" ? rulePeriod(record, locale) : section === "disclosures" ? String(locale === "zh" ? record.zh_title : record.en_title) : section === "audit" ? `${auditKindLabel(currentSelection.kind, locale)} · ${statusLabel(record.action, locale)}` : String(record.name ?? record.email ?? record.auth_user_id ?? record.external_id ?? record.id ?? l("Record", "记录"))}</h3><p className="mt-1 break-words text-sm text-foreground-muted">{section === "disclosures" ? String(record.recipient_name ?? "") : section === "configurations" ? String(record.display_name ?? "") : section === "rules" ? `${Array.isArray(record.members) ? record.members.length : 0} ${l("configurations", "个配置")}` : section === "audit" ? adminDate(record.time_changed, locale) : String(record.model_id ?? record.time_created ?? record.time_revoked ?? record.state ?? record.operation ?? "")}{typeof record.enabled === "boolean" ? ` · ${record.enabled ? l("Enabled", "已启用") : l("Disabled", "未启用")}` : ""}</p></div><div className="flex shrink-0 gap-2"><Button variant="secondary" size="sm" onClick={() => setSelection({
                  ...currentSelection,
                  dialog: {
                    owner: dialogOwner,
                    record,
                    mode: "view"
                  }
                })}>{l("View", "查看")}</Button>{["configurations", "disclosures", "rules"].includes(section) && <Button variant="secondary" size="sm" onClick={() => setSelection({
                  ...currentSelection,
                  dialog: {
                    owner: dialogOwner,
                    record,
                    mode: "edit"
                  }
                })}>{l("Edit", "编辑")}</Button>}</div></div>)}
          </div>}
          {nextCursor && <Button variant="secondary" onClick={() => setSelection({
            ...currentSelection,
            cursor: nextCursor,
            dialog: null
          })}>{l("Next page", "下一页")}</Button>}
        </>}
      </fieldset>
      {dialog && <AdminEntityDialog key={`${owner}:${context.database_instance_id}:${dialog.record?.document_id ?? dialog.record?.id ?? dialog.record?.auth_user_id ?? "new"}`} client={client} actor={actor} project={project} context={context} section={section} kind={currentSelection.kind} record={dialog.record} mode={dialog.mode} locale={locale} enabled={ready} onClose={() => setSelection(current => ({
        ...current,
        dialog: null
      }))} onCommitted={read.refreshAfterMutation} />}
    </section>}
  </AdminShell>;
}
