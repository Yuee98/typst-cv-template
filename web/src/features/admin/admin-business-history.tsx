"use client";
import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import type { AdminRecord } from "@/lib/admin/contract";
import type { AdminSession } from "./admin-session";
import { AuditDetails } from "./admin-detail-sections";
import { useAdminRead } from "./admin-read";
import { adminText } from "./format";

type Props = { client: SupabaseClient; actor: AdminSession; project: string; instanceId: string; entityId: string; section: "configurations" | "disclosures" | "rules" | "users"; locale: "zh" | "en" };
/** One business save has multiple typed histories; keep all of them together. */
export function AdminBusinessHistory(props: Props) {
  const l = (en: string, zh: string) => adminText(props.locale, en, zh);
  const groups = props.section === "configurations" ? [["configurations", l("Configuration changes", "配置变更")], ["prices", l("Price changes", "价格变更")]]
    : props.section === "rules" ? [["rules", l("Period changes", "时段变更")], ["rule_members", l("Options and defaults", "候选配置与默认项变更")]] : props.section === "disclosures" ? [["documents", l("Disclosure changes", "数据处理说明变更")]] : [["members", l("Membership changes", "管理员资格变更")]];
  return <div className="space-y-6">{groups.map(([kind, title]) => <HistoryGroup key={kind} {...props} kind={kind} title={title} />)}</div>;
}
function HistoryGroup({ client, actor, project, instanceId, entityId, locale, kind, title }: Props & { kind: string; title: string }) {
  const l = (en: string, zh: string) => adminText(locale, en, zh);
  const [cursor, setCursor] = useState<string | null>(null);
  const read = useAdminRead(client, project, actor, { section: "audit", kind, cursor, entityId });
  const data = read.result?.context.database_instance_id === instanceId ? read.result.data as { records: AdminRecord[]; next_cursor: string | null } : null;
  return <section className="space-y-3" aria-label={title}><h3 className="font-semibold">{title}</h3>{read.error ? <p role="alert">{read.error}</p> : read.loading || !data ? <p role="status">{l("Loading…", "正在加载…")}</p> : <>
    {data.records.length === 0 && <p className="text-sm text-foreground-muted">{l("No changes recorded.", "暂无变更记录。")}</p>}
    {data.records.map((record, index) => <div key={String(record.audit_id ?? index)} className="rounded-lg border border-border p-3"><AuditDetails record={record} locale={locale} /></div>)}
    <div className="flex gap-2">{cursor && <Button variant="secondary" size="sm" onClick={() => setCursor(null)}>{l("First page", "返回首页")}</Button>}{data.next_cursor && <Button variant="secondary" size="sm" onClick={() => setCursor(data.next_cursor)}>{l("Next page", "下一页")}</Button>}</div>
  </>}</section>;
}
