"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { LegalMarkdownPreview } from "@/components/legal/restricted-legal-markdown";
import { adminDisclosureDraftSchema, type AdminDisclosureDraft } from "@/lib/admin/contract";
import { legalDocumentSchema, type LegalDocument } from "@/lib/legal/legal-display";
import type { AdminEntityDialogProps } from "./admin-entity-dialog";
import { AdminBusinessHistory } from "./admin-business-history";
import { DetailFields } from "./admin-detail-sections";
import { useAdminRead } from "./admin-read";
import { useAdminMutation } from "./use-admin-mutation";

function draftOf(document: LegalDocument | null): AdminDisclosureDraft {
  return {
    kind: "AI_PROVIDER",
    recipient_name: document?.recipient_name ?? "",
    zh_title: document?.zh_title ?? "",
    en_title: document?.en_title ?? "",
    zh_body: document?.zh_body ?? "",
    en_body: document?.en_body ?? "",
    effective_date: document?.effective_date ?? new Date().toISOString().slice(0, 10),
    enabled: document?.enabled ?? false
  };
}

export function AdminDisclosureDialog(props: AdminEntityDialogProps) {
  const id = typeof props.record?.document_id === "string" ? props.record.document_id : undefined;
  const detail = useAdminRead(props.client, props.project, props.actor, { section: "disclosures", kind: "documents", cursor: null, recordId: id }, props.enabled && Boolean(id));
  const parsed = legalDocumentSchema.safeParse(detail.result?.data);
  const incoming = detail.result?.context.database_instance_id === props.context.database_instance_id && parsed.success && parsed.data.kind === "AI_PROVIDER" ? parsed.data : null;
  const [last, setLast] = useState<{ raw: unknown; document: LegalDocument } | null>(null);
  if (incoming && last?.raw !== detail.result?.data) setLast({ raw: detail.result?.data, document: incoming });
  const record = props.mode === "create" ? null : last?.document ?? incoming;
  const ready = props.enabled && (props.mode === "create" || Boolean(incoming && !detail.loading && !detail.error));
  if (props.mode !== "create" && !record) return <ModalDialog open title={props.locale === "zh" ? "数据处理说明" : "Data-processing disclosure"} onClose={props.onClose}><p role={detail.error ? "alert" : "status"}>{detail.error ?? (props.locale === "zh" ? "正在加载…" : "Loading…")}</p></ModalDialog>;
  return <DisclosureEditor {...props} document={record ?? null} ready={ready} reload={detail.refreshRead} />;
}

function DisclosureEditor({ document, ready, reload, ...props }: AdminEntityDialogProps & { document: LegalDocument | null; ready: boolean; reload(): void }) {
  const l = (en: string, zh: string) => props.locale === "zh" ? zh : en;
  const [mode, setMode] = useState(props.mode);
  const [baseline, setBaseline] = useState(document);
  const [draft, setDraft] = useState(() => draftOf(document));
  const [clean, setClean] = useState(() => JSON.stringify(draft));
  const [history, setHistory] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useAdminMutation(props.client, props.actor, props.onCommitted);
  const formId = useId();
  const dirty = JSON.stringify(draft) !== clean;
  const readonly = mode === "view";
  const newer = Boolean(baseline && document && baseline.revision !== document.revision);
  const locked = !ready || mutation.busy || mutation.uncertain;
  useEffect(() => {
    if (!dirty || readonly) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, readonly]);
  function close() {
    if (!mutation.busy && !mutation.uncertain && (readonly || !dirty || window.confirm(l("Discard unsaved changes?", "放弃尚未保存的修改？")))) props.onClose();
  }
  function change(next: AdminDisclosureDraft) {
    if (locked) return;
    setDraft(next);
    setLocalError(null);
    mutation.clearError();
  }
  function adoptLatest() {
    if (!document || locked || !newer || dirty && !window.confirm(l("Replace your edits with the latest record?", "用最新记录替换尚未保存的修改？"))) return;
    const next = draftOf(document);
    setBaseline(document);
    setDraft(next);
    setClean(JSON.stringify(next));
    setLocalError(null);
    mutation.clearError();
  }
  async function save() {
    if (!ready) return;
    const parsed = adminDisclosureDraftSchema.safeParse(draft);
    if (!parsed.success) { setLocalError(l("Complete both languages and use only supported Markdown with safe links.", "请填写完整的中英文内容，并仅使用支持的 Markdown 与安全链接。")); return; }
    if (await mutation.submit({ operation: "admin_legal_document_save", contract_code: "cv_app_db_2", database_instance_id: props.context.database_instance_id, operation_key: crypto.randomUUID(), reason: "Save data-processing disclosure", id: baseline?.document_id ?? null, expected_revision: baseline?.revision ?? null, ...parsed.data })) props.onClose();
  }
  const message = mutation.error === "RESULT_UNKNOWN" ? l("Result unknown. Keep this dialog open and retry the same operation.", "结果尚不确定，请保留此弹窗并重试同一操作。")
    : mutation.error === "CONFLICT" ? l("This disclosure changed. Your edits are preserved. Refresh and load the latest record before saving again.", "数据处理说明已有更新，你的草稿已保留。请刷新并载入最新记录后再保存。")
    : mutation.error === "INVALID_REQUEST" ? l("The disclosure could not be saved. Check its fields and Markdown format.", "无法保存数据处理说明，请检查填写内容与 Markdown 格式。") : mutation.error ?? localError;
  return <ModalDialog open title={readonly ? l("Data-processing disclosure", "数据处理说明") : mode === "create" ? l("New data-processing disclosure", "新增数据处理说明") : l("Edit data-processing disclosure", "编辑数据处理说明")} closeLabel={l("Close dialog", "关闭弹窗")} onClose={close} closeDisabled={mutation.busy || mutation.uncertain} className="h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-3xl sm:h-auto sm:max-h-[calc(100dvh-3rem)]" footer={<>
    <Button type="button" variant="secondary" disabled={mutation.busy || mutation.uncertain} onClick={close}>{l("Close", "关闭")}</Button>
    {readonly ? <Button disabled={locked} onClick={() => { setMode("edit"); setHistory(false); }}>{l("Edit", "编辑")}</Button> : !history && <Button type="submit" form={formId} disabled={!ready || mutation.busy}>{mutation.busy ? l("Saving…", "正在保存…") : mutation.uncertain ? l("Retry same operation", "重试同一操作") : l("Save", "保存")}</Button>}
  </>}>
    {!ready && <p role="status">{l("Loading…", "正在加载…")}</p>}
    {message && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger-foreground">{message}</p>}
    {(newer || mutation.error === "CONFLICT") && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{l("A newer record is available.", "记录已有更新。")}</span><Button type="button" variant="secondary" onClick={reload} disabled={mutation.busy || mutation.uncertain}>{l("Refresh record", "刷新记录")}</Button><Button type="button" variant="secondary" onClick={adoptLatest} disabled={locked || !newer}>{l("Load latest", "载入最新记录")}</Button></div>}
    <fieldset disabled={locked} hidden={!ready} className="min-w-0 space-y-5">
      {baseline && <div className="flex gap-2"><Button type="button" variant="secondary" size="sm" onClick={() => setHistory(false)}>{l("Details", "详情")}</Button><Button type="button" variant="secondary" size="sm" onClick={() => setHistory(true)}>{l("History", "变更历史")}</Button></div>}
      {history && baseline ? <AdminBusinessHistory client={props.client} actor={props.actor} project={props.project} instanceId={props.context.database_instance_id} entityId={baseline.document_id} section="disclosures" locale={props.locale} /> : readonly && document ? <>
        <DetailFields items={[[l("Recipient", "实际接收方"), document.recipient_name ?? ""], [l("Effective date", "生效日期"), document.effective_date], [l("Enabled", "启用"), document.enabled ? l("Yes", "是") : l("No", "否")]]} />
        <DisclosurePreview locale={props.locale} title={document.zh_title} body={document.zh_body} label={l("Chinese", "中文")} />
        <DisclosurePreview locale={props.locale} title={document.en_title} body={document.en_body} label={l("English", "英文")} />
      </> : <form id={formId} onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-5">
        <label className="block space-y-1.5 text-sm"><span>{l("Recipient", "实际接收方")}</span><Input required maxLength={500} value={draft.recipient_name} onChange={event => change({ ...draft, recipient_name: event.target.value })} /></label>
        <div className="flex flex-wrap items-end gap-4"><label className="block space-y-1.5 text-sm"><span>{l("Effective date", "生效日期")}</span><Input required type="date" value={draft.effective_date} onChange={event => change({ ...draft, effective_date: event.target.value })} /></label><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => change({ ...draft, enabled: event.target.checked })} />{l("Enabled", "启用")}</label></div>
        <p className="text-sm leading-6 text-foreground-muted">{l("Describe the actual recipient, submitted data, retention, training and other applicable handling. This document is selected manually for each configuration. Changing its content requires users to accept it again.", "请如实说明实际接收方、提交的数据、留存、训练及其他适用处理方式。每个配置需手动关联对应说明；修改正文后，用户需重新同意。")}</p>
        <p className="text-xs leading-5 text-foreground-muted">{l("Supported Markdown: paragraphs, ## headings, - lists and links to HTTPS or this site. HTML, images and scripts are not allowed.", "支持段落、## 标题、- 列表，以及 HTTPS 或本站链接。不支持 HTML、图片和脚本。")}</p>
        {(["zh", "en"] as const).map(language => <section key={language} className="space-y-3 border-t border-border pt-4">
          <label className="block space-y-1.5 text-sm"><span>{l(language === "zh" ? "Chinese title" : "English title", language === "zh" ? "中文标题" : "英文标题")}</span><Input required maxLength={500} value={draft[`${language}_title`]} onChange={event => change({ ...draft, [`${language}_title`]: event.target.value })} /></label>
          <label className="block space-y-1.5 text-sm"><span>{l(language === "zh" ? "Chinese content" : "English content", language === "zh" ? "中文正文" : "英文正文")}</span><textarea required maxLength={65536} rows={10} className="w-full min-w-0 rounded-lg border border-border bg-bg p-3 text-base sm:text-sm" value={draft[`${language}_body`]} onChange={event => change({ ...draft, [`${language}_body`]: event.target.value })} /></label>
          <DisclosurePreview locale={props.locale} title={draft[`${language}_title`]} body={draft[`${language}_body`]} label={l(language === "zh" ? "Chinese preview" : "English preview", language === "zh" ? "中文预览" : "英文预览")} />
        </section>)}
      </form>}
    </fieldset>
  </ModalDialog>;
}

function DisclosurePreview({ title, body, label, locale }: { title: string; body: string; label: string; locale: "zh" | "en" }) {
  return <section aria-label={label} className="space-y-3 rounded-lg border border-border bg-bg p-4"><p className="text-xs font-medium text-foreground-muted">{label}</p>{title && <h3 className="font-semibold">{title}</h3>}<LegalMarkdownPreview body={body} emptyMessage={locale === "zh" ? "填写正文后可在此预览。" : "Enter content to preview it here."} invalidMessage={locale === "zh" ? "此内容包含不支持的 Markdown 或不安全链接。" : "This content contains unsupported Markdown or unsafe links."} /></section>;
}
