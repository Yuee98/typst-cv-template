"use client";

import { cloneElement, useEffect, useId, useState, type ReactElement } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { adminConfigurationSchema, adminRuleSchema, type AdminConfiguration, type AdminContext, type AdminRecord, type AdminSection } from "@/lib/admin/contract";
import { aiDisclosureHref } from "@/lib/legal/document-links";
import { legalDocumentSchema, type LegalDocument } from "@/lib/legal/legal-display";
import { useAdminRead } from "./admin-read";
import { useAdminOptions } from "./use-admin-options";
import type { AdminSession } from "./admin-session";
import { useAdminMutation } from "./use-admin-mutation";
import { AdminDetails } from "./admin-detail-sections";
import { formatMinute, parseMinute } from "./format";
import { AdminBusinessHistory } from "./admin-business-history";
type Props = {
  client: SupabaseClient;
  actor: AdminSession;
  project: string;
  context: AdminContext;
  section: AdminSection;
  kind: string;
  record: AdminRecord | null;
  mode: "view" | "edit" | "create";
  locale: "zh" | "en";
  enabled: boolean;
  onClose(): void;
  onCommitted(): void;
};
const emptyPrice = {
  currency: "USD",
  input_standard_nanos_per_million: "0",
  input_cache_read_nanos_per_million: "0",
  input_cache_write_nanos_per_million: "0",
  output_nanos_per_million: "0"
};
export function formatPrice(value: string): string {
  const n = BigInt(value),
    scale = BigInt(1000000000),
    fraction = String(n % scale).padStart(9, "0").replace(/0+$/, "");
  return `${n / scale}${fraction ? `.${fraction}` : ""}`;
}
export function parsePrice(value: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value)) throw new Error("Enter a non-negative price with at most 9 decimal places");
  const [whole, fraction = ""] = value.split(".");
  return String(BigInt(whole) * BigInt(1000000000) + BigInt(fraction.padEnd(9, "0")));
}
function Field({
  label,
  children
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return <div className="min-w-0 space-y-1.5 text-sm"><label htmlFor={id} className="block font-medium">{label}</label>{cloneElement(children, { id })}</div>;
}
const selectClass = "h-10 w-full min-w-0 rounded-md border border-border bg-bg px-3 text-base sm:text-sm";
export function AdminEntityDialog(props: Props) {
  const {
    client,
    actor,
    project,
    section,
    kind,
    record,
    mode,
    enabled
  } = props;
  const rawId = section === "audit" ? record?.audit_id : record?.id;
  const id = typeof rawId === "string" && /^[1-9][0-9]*$/.test(rawId) ? rawId : undefined;
  const detail = useAdminRead(client, project, actor, {
    section,
    kind,
    cursor: null,
    recordId: id
  }, enabled && Boolean(id) && !["accounts", "allowed_users"].includes(kind));
  const [lastDetail, setLastDetail] = useState<AdminRecord | null>(null);
  const incoming = detail.result?.context.database_instance_id === props.context.database_instance_id && detail.result.data && typeof detail.result.data === "object" ? detail.result.data as AdminRecord : null;
  if (incoming && incoming !== lastDetail) setLastDetail(incoming);
  const loaded = mode === "create" ? null : ["accounts", "allowed_users"].includes(kind) ? record : lastDetail;
  const ready = enabled && (mode === "create" || ["accounts", "allowed_users"].includes(kind) || Boolean(incoming && !detail.loading && !detail.error));
  if (mode !== "create" && !loaded) return <ModalDialog open title={props.locale === "zh" ? "查看详情" : "View details"} onClose={props.onClose}><p role={detail.error ? "alert" : "status"}>{detail.error ?? (props.locale === "zh" ? "正在加载…" : "Loading…")}</p></ModalDialog>;
  return <EntityEditor {...props} record={loaded} ready={ready} reload={detail.refreshRead} />;
}
function EntityEditor({
  client,
  actor,
  project,
  context,
  section,
  kind,
  record,
  mode: initialMode,
  locale,
  ready,
  reload,
  onClose,
  onCommitted
}: Omit<Props, "enabled"> & {
  ready: boolean;
  reload(): void;
}) {
  const l = (en: string, zh: string) => locale === "zh" ? zh : en;
  const [mode, setMode] = useState(initialMode);
  const [baseline, setBaseline] = useState(record);
  const formId = useId();
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useAdminMutation(client, actor, onCommitted);
  const optionsEnabled = section === "configurations" || section === "rules";
  const adapters = useAdminOptions(client, project, actor, "adapters", optionsEnabled && section === "configurations");
  const documents = useAdminOptions(client, project, actor, "legal_documents", optionsEnabled && section === "configurations");
  const configurations = useAdminOptions(client, project, actor, "configurations", optionsEnabled && section === "rules");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [configuration, setConfiguration] = useState<AdminConfiguration>(() => section === "configurations" && record ? adminConfigurationSchema.parse(record) : {
    id: "1",
    revision: "1",
    name: "",
    adapter_id: 1,
    endpoint_url: "",
    model_id: "",
    credential_ref: "",
    legal_document_id: "",
    enabled: false,
    price: emptyPrice
  });
  const [prices, setPrices] = useState(() => Object.fromEntries(Object.entries(configuration.price).filter(([key]) => key !== "currency").map(([key, value]) => [key, record ? formatPrice(value) : ""])));
  const [rule, setRule] = useState(() => section === "rules" && record ? adminRuleSchema.parse(record) : {
    id: "1",
    revision: "1",
    weekday: null as number | null,
    start_minute: null as number | null,
    end_minute: null as number | null,
    enabled: false,
    members: [] as {
      config_id: string;
      is_default: boolean;
    }[]
  });
  const [authUserId, setAuthUserId] = useState(String(record?.auth_user_id ?? ""));
  const [allowed, setAllowed] = useState(true);
  const [startTime, setStartTime] = useState(formatMinute(rule.start_minute ?? 0));
  const [endTime, setEndTime] = useState(formatMinute(rule.end_minute ?? 1440));
  const source = JSON.stringify({
    configuration,
    prices,
    rule,
    authUserId,
    allowed,
    startTime,
    endTime
  });
  const [clean, setClean] = useState(source);
  const dirty = source !== clean;
  useEffect(() => {
    if (!dirty || mode === "view") return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, mode]);
  const editable = section === "configurations" || section === "rules" || section === "users";
  const readonly = mode === "view";
  const metadataReady = section === "configurations" ? Boolean(adapters.result && documents.result && !adapters.loading && !documents.loading && !adapters.error && !documents.error) : section === "rules" ? Boolean(configurations.result && !configurations.loading && !configurations.error) : true;
  const canUse = ready && metadataReady;
  const legalDocs: LegalDocument[] = documents.records.map(row => legalDocumentSchema.parse(row));
  const currentDocument = legalDocs.find(doc => doc.document_id === configuration.legal_document_id);
  const common = legalDocs.find(doc => doc.kind === "AI_COMMON");
  const matching = legalDocs.filter(doc => doc.kind === "AI_PROVIDER" && doc.adapter_id === configuration.adapter_id && (!configuration.endpoint_url || doc.endpoint_url === configuration.endpoint_url) && (!configuration.model_id || doc.model_id === configuration.model_id));
  const newer = baseline && record && record.revision !== baseline.revision;
  function close() {
    if (!mutation.busy && !mutation.uncertain && (!dirty || readonly || window.confirm(l("Discard unsaved changes?", "放弃尚未保存的修改？")))) onClose();
  }
  function replaceBaseline() {
    if (!record || dirty && !window.confirm(l("Replace your edits with the latest record?", "用最新记录替换尚未保存的修改？"))) return;
    const nextConfiguration = section === "configurations" ? adminConfigurationSchema.parse(record) : configuration;
    const nextPrices = section === "configurations" ? Object.fromEntries(Object.entries(nextConfiguration.price).filter(([key]) => key !== "currency").map(([key, value]) => [key, formatPrice(value)])) : prices;
    const nextRule = section === "rules" ? adminRuleSchema.parse(record) : rule;
    const nextStart = formatMinute(nextRule.start_minute ?? 0),
      nextEnd = formatMinute(nextRule.end_minute ?? 1440);
    setBaseline(record);
    setConfiguration(nextConfiguration);
    setPrices(nextPrices);
    setRule(nextRule);
    setStartTime(nextStart);
    setEndTime(nextEnd);
    setClean(JSON.stringify({
      configuration: nextConfiguration,
      prices: nextPrices,
      rule: nextRule,
      authUserId,
      allowed,
      startTime: nextStart,
      endTime: nextEnd
    }));
    setLocalError(null);
    mutation.clearError();
  }
  async function save() {
    if (!canUse) return;
    setLocalError(null);
    try {
      const base = {
        contract_code: "cv_app_db_2",
        database_instance_id: context.database_instance_id,
        operation_key: crypto.randomUUID(),
        reason: section === "configurations" ? "Save AI configuration" : section === "rules" ? "Save time rule" : kind === "allowed_users" ? "Update allowed user" : "Update administrator membership"
      };
      const identity = {
        id: baseline?.id ?? null,
        expected_revision: baseline?.revision ?? null
      };
      let payload: unknown;
      if (section === "configurations") {
        if (!currentDocument || currentDocument.adapter_id !== configuration.adapter_id || currentDocument.endpoint_url !== configuration.endpoint_url || currentDocument.model_id !== configuration.model_id) throw new Error(l("Select a disclosure matching the connection and model.", "请选择与接入地址和模型匹配的数据处理说明。"));
        payload = {
          ...base,
          operation: "admin_configuration_save",
          ...identity,
          name: configuration.name,
          adapter_id: configuration.adapter_id,
          endpoint_url: configuration.endpoint_url,
          model_id: configuration.model_id,
          credential_ref: configuration.credential_ref,
          legal_document_id: configuration.legal_document_id,
          enabled: configuration.enabled,
          price: {
            currency: configuration.price.currency,
            ...Object.fromEntries(Object.entries(prices).map(([key, value]) => [key, parsePrice(value)]))
          }
        };
      } else if (section === "rules") payload = {
        ...base,
        operation: "admin_rule_save",
        ...identity,
        weekday: rule.weekday,
        start_minute: rule.weekday === null ? null : parseMinute(startTime),
        end_minute: rule.weekday === null ? null : parseMinute(endTime, true),
        enabled: rule.enabled,
        members: rule.members
      };else if (kind === "allowed_users") payload = {
        ...base,
        operation: "admin_allowed_user_set",
        expected_revision: context.control.revision,
        auth_user_id: authUserId,
        allowed
      };else payload = {
        ...base,
        operation: "admin_member_grant",
        expected_revision: baseline?.revision ?? null,
        auth_user_id: authUserId
      };
      if (await mutation.submit(payload)) onClose();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "INVALID_REQUEST");
    }
  }
  const isMember = section === "users" && kind === "members" && baseline && !baseline.time_revoked;
  async function revoke() {
    if (!baseline || !window.confirm(l("Revoke this administrator?", "撤销这位管理员的资格？"))) return;
    if (await mutation.submit({
      operation: "admin_member_revoke",
      contract_code: "cv_app_db_2",
      database_instance_id: context.database_instance_id,
      operation_key: crypto.randomUUID(),
      reason: "Revoke administrator membership",
      id: baseline.id,
      expected_revision: baseline.revision
    })) onClose();
  }
  const title = mode === "create" ? l("New record", "新建记录") : readonly ? l("View details", "查看详情") : l("Edit record", "编辑记录");
  return <ModalDialog open title={title} closeLabel={l("Close dialog", "关闭弹窗")} onClose={close} closeDisabled={mutation.busy || mutation.uncertain} className="h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-3xl sm:h-auto sm:max-h-[calc(100dvh-3rem)]" footer={<>
    <Button type="button" variant="secondary" onClick={close} disabled={mutation.busy || mutation.uncertain}>{l("Close", "关闭")}</Button>
    {readonly && editable && <Button type="button" disabled={!canUse} onClick={() => {
      setMode("edit");
      setHistoryOpen(false);
    }}>{kind === "accounts" ? l("Grant administrator", "授予管理员") : l("Edit", "编辑")}</Button>}
    {!readonly && !historyOpen && <Button type="submit" form={formId} disabled={!canUse || mutation.busy}>{mutation.busy ? l("Saving…", "正在保存…") : mutation.uncertain ? l("Retry same operation", "重试同一操作") : l("Save", "保存")}</Button>}
  </>}>
    {(!ready || !metadataReady) && <p role="status">{l("Loading…", "正在加载…")}</p>}
    {(localError || mutation.error || adapters.error || documents.error || configurations.error) && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger-foreground">{mutation.error === "RESULT_UNKNOWN" ? l("Result unknown. Keep this dialog open and retry the same operation.", "结果尚不确定，请保留此弹窗并重试同一操作。") : mutation.error === "CONFLICT" ? l("This record changed. Your edits are preserved. Refresh and load the latest record before saving again.", "记录已变化。你的修改已保留，请刷新并载入最新记录后再保存。") : localError ?? mutation.error ?? adapters.error ?? documents.error ?? configurations.error}</p>}
    {(newer || mutation.error === "CONFLICT") && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{l("A newer record is available.", "记录已有更新。")}</span><Button variant="secondary" type="button" onClick={reload}>{l("Refresh record", "刷新记录")}</Button><Button variant="secondary" type="button" onClick={replaceBaseline} disabled={!ready || !newer || mutation.busy || mutation.uncertain}>{l("Load latest", "载入最新记录")}</Button></div>}
    <fieldset disabled={!canUse || mutation.busy || mutation.uncertain} hidden={!ready} className="min-w-0 space-y-4">
      {baseline && ["configurations", "rules", "users"].includes(section) && !["accounts", "allowed_users"].includes(kind) && <div className="flex gap-2"><Button variant="secondary" size="sm" type="button" onClick={() => setHistoryOpen(false)}>{l("Details", "详情")}</Button><Button variant="secondary" size="sm" type="button" onClick={() => setHistoryOpen(true)}>{l("History", "变更历史")}</Button></div>}
      {historyOpen && baseline && (section === "configurations" || section === "rules" || section === "users") ? <AdminBusinessHistory client={client} actor={actor} project={project} instanceId={context.database_instance_id} entityId={String(baseline.id)} section={section} locale={locale} /> : readonly ? <AdminDetails record={record ?? {}} section={section} kind={kind} locale={locale} adapters={adapters.records} configurations={configurations.records} disclosureLink={currentDocument && common && currentDocument.enabled && <a target="_blank" rel="noopener noreferrer" className="text-sm text-accent underline" href={`/${locale}${aiDisclosureHref({
        common,
        provider: currentDocument
      })}`}>{l("Read the exact terms and disclosure", "阅读对应条款与数据处理说明")}</a>} /> : <form id={formId} className="space-y-5" onSubmit={event => {
        event.preventDefault();
        void save();
      }}>
            {section === "configurations" && <>
              <Field label={l("Configuration name", "配置名称")}><Input required value={configuration.name} onChange={event => setConfiguration({
              ...configuration,
              name: event.target.value
            })} /></Field>
              <Field label={l("Adapter", "请求适配器")}><select className={selectClass} value={configuration.adapter_id} onChange={event => setConfiguration({
              ...configuration,
              adapter_id: Number(event.target.value) as 1 | 2 | 3,
              legal_document_id: ""
            })}>{adapters.records.map(adapter => <option key={String(adapter.id)} value={String(adapter.id)}>{String(adapter.name)}</option>)}</select></Field>
              <Field label={l("Endpoint URL", "接入地址")}><Input type="url" required value={configuration.endpoint_url} onChange={event => setConfiguration({
              ...configuration,
              endpoint_url: event.target.value
            })} /></Field>
              <Field label={l("Model", "模型")}><Input required value={configuration.model_id} onChange={event => setConfiguration({
              ...configuration,
              model_id: event.target.value
            })} /></Field>
              <Field label={l("Credential reference", "凭据引用名称")}><Input required autoComplete="off" spellCheck={false} placeholder="AI_PROVIDER_KEY_…" value={configuration.credential_ref} onChange={event => setConfiguration({
              ...configuration,
              credential_ref: event.target.value
            })} /></Field>
              <Field label={l("Data-processing disclosure", "数据处理说明")}><select required className={selectClass} value={configuration.legal_document_id} onChange={event => {
              const doc = legalDocs.find(item => item.document_id === event.target.value);
              setConfiguration({
                ...configuration,
                legal_document_id: event.target.value,
                endpoint_url: configuration.endpoint_url || doc?.endpoint_url || "",
                model_id: configuration.model_id || doc?.model_id || ""
              });
            }}><option value="">{l("Select a matching document", "选择匹配的文档")}</option>{matching.map(doc => <option key={doc.document_id} value={doc.document_id}>{locale === "zh" ? doc.zh_title : doc.en_title}</option>)}</select></Field>
              {documents.hasMore && <Button variant="secondary" type="button" onClick={documents.loadMore}>{l("Load more disclosures", "加载更多披露")}</Button>}
              {currentDocument && common && <a target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-accent underline" href={`/${locale}${aiDisclosureHref({
            common,
            provider: currentDocument
          })}`}>{l("Read the exact terms and disclosure", "阅读对应条款与数据处理说明")}</a>}
              <section className="space-y-3 border-t border-border pt-4"><h3 className="font-semibold">{l("Price per million tokens", "每百万 Token 价格")}</h3><Field label={l("Currency", "币种")}><Input required maxLength={3} value={configuration.price.currency} onChange={event => setConfiguration({
                ...configuration,
                price: {
                  ...configuration.price,
                  currency: event.target.value.toUpperCase()
                }
              })} /></Field><div className="grid gap-3 sm:grid-cols-2">{Object.keys(prices).map((key, index) => <Field key={key} label={l(["Input", "Cache read", "Cache write", "Output"][index], ["输入", "缓存读取", "缓存写入", "输出"][index])}><Input required inputMode="decimal" value={prices[key]} onChange={event => setPrices({
                  ...prices,
                  [key]: event.target.value
                })} /></Field>)}</div></section>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={configuration.enabled} onChange={event => setConfiguration({
              ...configuration,
              enabled: event.target.checked
            })} />{l("Enabled", "启用")}</label>
            </>}
            {section === "rules" && <>
              <p className="text-sm text-foreground-muted">{l("All periods use Asia/Shanghai. Select one default configuration.", "时间均为 Asia/Shanghai。请在已选配置中指定一个默认项。")}</p>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.weekday === null} onChange={event => setRule({
              ...rule,
              weekday: event.target.checked ? null : 1,
              start_minute: event.target.checked ? null : 0,
              end_minute: event.target.checked ? null : 1440
            })} />{l("Fallback for other periods", "其他时段的默认规则")}</label>
              {rule.weekday !== null && <div className="grid gap-3 sm:grid-cols-3"><Field label={l("Weekday", "星期")}><select className={selectClass} value={rule.weekday} onChange={event => setRule({
                ...rule,
                weekday: Number(event.target.value)
              })}>{[1, 2, 3, 4, 5, 6, 7].map(day => <option key={day} value={day}>{l(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][day - 1], ["一", "二", "三", "四", "五", "六", "日"][day - 1])}</option>)}</select></Field><Field label={l("Start time", "开始时间")}><Input required placeholder="09:00" value={startTime} onChange={event => setStartTime(event.target.value)} /></Field><Field label={l("End time", "结束时间")}><Input required placeholder="18:00" value={endTime} onChange={event => setEndTime(event.target.value)} /></Field></div>}
              <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{l("Available configurations", "可选配置")}</legend>{configurations.records.map(config => <label key={String(config.id)} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.members.some(member => member.config_id === config.id)} onChange={event => setRule({
                ...rule,
                members: event.target.checked ? [...rule.members, {
                  config_id: String(config.id),
                  is_default: rule.members.length === 0
                }] : rule.members.filter(member => member.config_id !== config.id)
              })} />{String(config.name)} · {String(config.model_id)}</label>)}</fieldset>
              {configurations.hasMore && <Button variant="secondary" type="button" onClick={configurations.loadMore}>{l("Load more configurations", "加载更多配置")}</Button>}
              <Field label={l("Default configuration", "默认配置")}><select required className={selectClass} value={rule.members.find(member => member.is_default)?.config_id ?? ""} onChange={event => setRule({
              ...rule,
              members: rule.members.map(member => ({
                ...member,
                is_default: member.config_id === event.target.value
              }))
            })}><option value="">{l("Select a default", "选择默认项")}</option>{rule.members.map(member => <option key={member.config_id} value={member.config_id}>{String(configurations.records.find(config => config.id === member.config_id)?.name ?? member.config_id)}</option>)}</select></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.enabled} onChange={event => setRule({
              ...rule,
              enabled: event.target.checked
            })} />{l("Enabled", "启用")}</label>
            </>}
            {section === "users" && <><Field label={l("Account UUID", "账户 UUID")}><Input required value={authUserId} readOnly={Boolean(baseline)} onChange={event => setAuthUserId(event.target.value)} /></Field>{kind === "allowed_users" ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowed} onChange={event => setAllowed(event.target.checked)} />{l("Allow AI access", "允许使用 AI")}</label> : <p className="text-sm text-foreground-muted">{l("Saving grants administrator access. Sensitive operations require recent TOTP verification.", "保存后授予管理员资格。敏感操作仍要求近期 TOTP 验证。")}</p>}</>}
          </form>}
      {isMember && !historyOpen && <Button type="button" variant="secondary" onClick={() => void revoke()} disabled={mutation.busy}>{l("Revoke administrator", "撤销管理员")}</Button>}
    </fieldset>
  </ModalDialog>;
}
