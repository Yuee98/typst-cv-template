import type { ReactNode } from "react";
import { RestrictedLegalMarkdown } from "@/components/legal/restricted-legal-markdown";
import { adminDate, adminText, formatMoney, rulePeriod, statusLabel } from "./format";
import type { AdminRecord, AdminSection } from "@/lib/admin/contract";
export function DetailFields({
  items
}: {
  items: readonly (readonly [string, ReactNode])[];
}) {
  return <dl className="grid min-w-0 gap-x-6 gap-y-4 sm:grid-cols-2">{items.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-foreground-muted">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{value ?? "—"}</dd></div>)}</dl>;
}
export function PriceDetails({
  price,
  locale
}: {
  price: AdminRecord;
  locale: "zh" | "en";
}) {
  const l = (en: string, zh: string) => adminText(locale, en, zh);
  return <section className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">{l("Price per million tokens", "每百万 Token 价格")}</h3><DetailFields items={[[l("Input", "输入"), formatMoney(price.input_standard_nanos_per_million, price.currency)], [l("Cache read", "缓存读取"), formatMoney(price.input_cache_read_nanos_per_million, price.currency)], [l("Cache write", "缓存写入"), formatMoney(price.input_cache_write_nanos_per_million, price.currency)], [l("Output", "输出"), formatMoney(price.output_nanos_per_million, price.currency)]]} /></section>;
}
export function AdminDetails({
  record,
  section,
  kind,
  locale,
  adapters = [],
  configurations = [],
  disclosureLink
}: {
  record: AdminRecord;
  section: AdminSection;
  kind: string;
  locale: "zh" | "en";
  adapters?: AdminRecord[];
  configurations?: AdminRecord[];
  disclosureLink?: ReactNode;
}) {
  const l = (en: string, zh: string) => adminText(locale, en, zh),
    yes = (value: unknown) => value == null ? "—" : value ? l("Yes", "是") : l("No", "否");
  if (section === "configurations") return <div className="space-y-5"><DetailFields items={[[l("Configuration name", "配置名称"), String(record.name)], [l("Display name", "展示名称"), String(record.display_name)], [l("Adapter", "请求适配器"), String(adapters.find(adapter => adapter.id === record.adapter_id)?.name ?? record.adapter_id)], [l("Endpoint URL", "接入地址"), String(record.endpoint_url)], [l("Model", "模型"), String(record.model_id)], [l("Credential reference", "凭据引用名称"), String(record.credential_ref)], [l("Enabled", "启用"), yes(record.enabled)]]} />{disclosureLink}<PriceDetails price={record.price as AdminRecord} locale={locale} /></div>;
  if (section === "rules") return <div className="space-y-5"><DetailFields items={[[l("Period", "适用时段"), rulePeriod(record, locale)], [l("Enabled", "启用"), yes(record.enabled)]]} /><section className="space-y-2"><h3 className="text-sm font-medium">{l("Available configurations", "可选配置")}</h3><ul className="space-y-2 text-sm">{(record.members as {
          config_id: string;
          is_default: boolean;
        }[]).map(member => <li key={member.config_id}>{String(configurations.find(config => config.id === member.config_id)?.name ?? member.config_id)}{member.is_default ? ` · ${l("Default", "默认")}` : ""}</li>)}</ul></section></div>;
  if (section === "users") return <DetailFields items={[[l("Account", "账户"), typeof record.email === "string" ? record.email : "—"], [l("Account UUID", "账户 UUID"), String(record.auth_user_id)], ...(kind === "members" ? [[l("Administrator", "管理员资格"), record.time_revoked ? l("Revoked", "已撤销") : l("Active", "有效")], [l("Revoked at", "撤销时间"), adminDate(record.time_revoked, locale)]] as const : kind === "allowed_users" ? [[l("AI access", "AI 访问"), l("Allowed", "允许")]] as const : [[l("Deleted at", "删除时间"), adminDate(record.deleted_at, locale)], [l("Banned until", "封禁截止"), adminDate(record.banned_until, locale)]] as const)]} />;
  if (section === "usage") {
    const request = record.request as AdminRecord ?? record,
      snapshot = record.snapshot as AdminRecord | null,
      attempts = record.attempts as AdminRecord[] | undefined;
    return <div className="space-y-6"><section className="space-y-3"><h3 className="font-medium">{l("Request", "请求")}</h3><DetailFields items={[[l("Request ID", "请求编号"), String(request.external_id ?? request.id)], [l("State", "状态"), String(request.state)], [l("Outcome", "结果"), request.outcome ? String(request.outcome) : "—"], [l("Reserved at", "预留时间"), adminDate(request.time_reserved, locale)], [l("Completed at", "完成时间"), adminDate(request.time_finalized, locale)], [l("Canceled at", "取消时间"), adminDate(request.time_canceled, locale)], [l("Quota charged", "已计入配额"), yes(request.charged)], [l("User quota day (UTC)", "用户配额日期（UTC）"), String(request.reserve_day)], [l("Provider admission day (UTC)", "供应商请求日期（UTC）"), request.provider_admission_day ? String(request.provider_admission_day) : "—"]]} /></section>{snapshot && <section className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">{l("Frozen configuration", "请求所用配置")}</h3><DetailFields items={[[l("Configuration name", "配置名称"), String(snapshot.config_name)], [l("Display name", "展示名称"), String(snapshot.config_display_name)], [l("Endpoint", "接入地址"), String(snapshot.endpoint_url)], [l("Model", "模型"), String(snapshot.model_id)]]} /><PriceDetails price={snapshot} locale={locale} /></section>}{attempts?.map(attempt => <section key={String(attempt.attempt_no)} className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">{l("Attempt", "尝试")} {String(attempt.attempt_no)}</h3><DetailFields items={[[l("State", "状态"), String(attempt.state)], [l("Started at", "开始时间"), adminDate(attempt.time_started, locale)], [l("Transmitted", "已发送"), yes(attempt.transmitted)], [l("Input tokens", "输入 Token"), String(attempt.input_total ?? "—")], [l("Output tokens", "输出 Token"), String(attempt.output ?? "—")], [l("Known estimated cost", "已知估算成本"), formatMoney(attempt.known_estimated_cost_nanos, snapshot?.currency)], [l("Cost incomplete", "成本不完整"), yes(attempt.cost_incomplete)]]} /></section>)}</div>;
  }
  return <AuditDetails record={record} locale={locale} />;
}
const auditLabels: Record<string, readonly [string, string]> = {
  action: ["Change", "变更"],
  operation_id: ["Operation ID", "操作编号"],
  time_changed: ["Changed at", "变更时间"],
  actor_kind: ["Actor type", "操作方类型"],
  actor_auth_user_id: ["Actor account", "操作账户"],
  reason: ["Reason", "说明"],
  name: ["Name", "名称"],
  display_name: ["Display name", "展示名称"],
  config_display_name: ["Display name", "展示名称"],
  enabled: ["Enabled", "启用"],
  adapter_id: ["Adapter", "适配器"],
  endpoint_url: ["Endpoint", "接入地址"],
  model_id: ["Model", "模型"],
  credential_ref: ["Credential reference", "凭据引用名称"],
  recipient_name: ["Recipient", "实际接收方"],
  audience: ["Audience", "开放范围"],
  auth_user_id: ["Account UUID", "账户 UUID"],
  owner_auth_user_id: ["Acceptance account", "同意账户"],
  time_accepted: ["Accepted at", "同意时间"],
  time_revoked: ["Revoked at", "撤销时间"],
  weekday: ["Weekday", "星期"],
  start_minute: ["Start minute", "开始分钟"],
  end_minute: ["End minute", "结束分钟"],
  is_default: ["Default", "默认"],
  config_id: ["Configuration ID", "配置编号"],
  rule_id: ["Rule ID", "规则编号"],
  document_id: ["Document ID", "文档编号"],
  user_daily_limit: ["User daily limit", "每用户每日额度"],
  global_daily_limit: ["Global daily limit", "每日总额度"],
  user_minute_limit: ["User minute limit", "每用户每分钟额度"]
};
export function AuditDetails({
  record,
  locale
}: {
  record: AdminRecord;
  locale: "zh" | "en";
}) {
  return <div className="space-y-5"><DetailFields items={Object.entries(auditLabels).filter(([key]) => key in record).map(([key, labels]) => [adminText(locale, ...labels), record[key] === null ? "—" : key === "action" ? statusLabel(record[key], locale) : key.startsWith("time_") ? adminDate(record[key], locale) : typeof record[key] === "boolean" ? record[key] ? adminText(locale, "Yes", "是") : adminText(locale, "No", "否") : String(record[key])])} />{typeof record.currency === "string" && <PriceDetails price={record} locale={locale} />}{typeof record.zh_body === "string" && typeof record.en_body === "string" && <section className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">{String(locale === "zh" ? record.zh_title : record.en_title)}</h3><RestrictedLegalMarkdown body={String(locale === "zh" ? record.zh_body : record.en_body)} /></section>}</div>;
}
