"use client";

import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type { AdminContext } from "@/lib/admin/contract";
import { DetailFields } from "./admin-detail-sections";
import type { AdminSession } from "./admin-session";
import { useAdminMutation } from "./use-admin-mutation";
export function AdminRuntimeControls({
  client,
  actor,
  context,
  locale,
  onCommitted,
  enabled = true
}: {
  client: SupabaseClient;
  actor: AdminSession;
  context: AdminContext;
  locale: "zh" | "en";
  enabled?: boolean;
  onCommitted(): void;
}) {
  const l = (en: string, zh: string) => locale === "zh" ? zh : en;
  const [mode, setMode] = useState<"view" | "edit" | null>(null);
  const [baseline, setBaseline] = useState(context.control),
    [draft, setDraft] = useState(context.control);
  const mutation = useAdminMutation(client, actor, onCommitted),
    emergency = useAdminMutation(client, actor, onCommitted);
  const changed = context.control.revision !== baseline.revision,
    dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  function open(mode: "view" | "edit") {
    mutation.clearError();
    setBaseline(context.control);
    setDraft(context.control);
    setMode(mode);
  }
  function close() {
    if (!mutation.busy && !mutation.uncertain && (mode !== "edit" || !dirty || window.confirm(l("Discard unsaved changes?", "放弃尚未保存的修改？")))) setMode(null);
  }
  function changeDraft(next: typeof draft) {
    if (!enabled || mutation.busy || mutation.uncertain) return;
    mutation.clearError();
    setDraft(next);
  }
  function errorMessage(code: string) {
    switch (code) {
      case "LEGAL_UNAVAILABLE": return l("The Terms of Use or AI Service Terms are unavailable. Check that both are enabled before enabling AI.", "使用条款或 AI 服务条款不可用，请先确认两者均已启用，再开启 AI。");
      case "FALLBACK_REQUIRED": return l("Enable a fallback in Time rules before enabling AI.", "请先到“时间规则”配置并启用兜底规则，再开启 AI。");
      case "INVALID_ROUTING_GRAPH": return l("An enabled time rule refers to a disabled configuration or an invalid data-processing disclosure. Check AI configurations and Time rules.", "已启用的时间规则引用了未启用的 AI 配置，或其数据处理说明无效。请检查“AI 配置”和“时间规则”。");
      case "CONFLICT": return l("These settings changed. Your edits are preserved. Refresh the settings and load the latest values before saving again.", "运行设置已被修改，你的草稿已保留。请刷新设置并载入最新值后再保存。");
      case "INVALID_REQUEST": return l("These settings could not be saved. Check the values and try again.", "无法保存运行设置，请检查填写内容后重试。");
      case "RESULT_UNKNOWN": return l("Result unknown. Keep this dialog open and retry the same operation.", "结果尚不确定，请保留弹窗并重试同一操作。");
      default: return code;
    }
  }
  async function save() {
    const success = await mutation.submit({
      operation: "admin_ai_update",
      contract_code: "cv_app_db_2",
      database_instance_id: context.database_instance_id,
      operation_key: crypto.randomUUID(),
      reason: "Save runtime controls",
      expected_revision: baseline.revision,
      enabled: draft.enabled,
      audience: draft.audience,
      user_daily_limit: draft.user_daily_limit,
      global_daily_limit: draft.global_daily_limit,
      user_minute_limit: draft.user_minute_limit
    });
    if (success) setMode(null);
  }
  const values = mode === "view" ? context.control : draft;
  return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4"><div><h3 className="text-sm font-semibold">{l("AI service settings", "AI 服务设置")}</h3><p className="mt-1 text-sm text-foreground-muted">{context.control.enabled ? l("Enabled", "已启用") : l("Disabled", "未启用")} · {context.control.audience === "ALL" ? l("All accounts", "全部账户") : l("Allowed accounts", "指定账户")}</p></div><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => open("view")}>{l("View", "查看")}</Button><Button size="sm" variant="secondary" onClick={() => open("edit")}>{l("Edit", "编辑")}</Button></div></div>
    <Button disabled={emergency.busy || !context.control.enabled} type="button" variant="secondary" onClick={() => void emergency.submit({
      operation: "admin_ai_disable",
      contract_code: "cv_app_db_2",
      database_instance_id: context.database_instance_id,
      operation_key: crypto.randomUUID(),
      expected_revision: context.control.revision,
      reason: "Emergency disable AI"
    })}>{emergency.busy ? l("Disabling…", "正在关闭…") : l("Emergency disable AI", "紧急关闭 AI")}</Button>
    {emergency.error && <p role="alert" className="text-sm text-danger-foreground">{emergency.error === "RESULT_UNKNOWN" ? l("Result unknown. Retry the same emergency disable operation.", "结果尚不确定，请重试同一紧急关闭操作。") : errorMessage(emergency.error)}</p>}
    {mode && <ModalDialog open title={mode === "view" ? l("AI service settings", "AI 服务设置") : l("Edit AI service settings", "编辑 AI 服务设置")} closeLabel={l("Close dialog", "关闭弹窗")} onClose={close} closeDisabled={mutation.busy || mutation.uncertain} className="h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-2xl sm:h-auto sm:max-h-[calc(100dvh-3rem)]" footer={<><Button type="button" variant="secondary" onClick={close} disabled={mutation.busy || mutation.uncertain}>{l("Close", "关闭")}</Button>{mode === "view" ? <Button disabled={!enabled} onClick={() => setMode("edit")}>{l("Edit", "编辑")}</Button> : <Button type="submit" form="admin-runtime-settings" disabled={!enabled || mutation.busy}>{mutation.busy ? l("Saving…", "正在保存…") : mutation.uncertain ? l("Retry same operation", "重试同一操作") : l("Save", "保存")}</Button>}</>}>
      {changed && mode === "edit" && <p className="space-y-2 text-sm">{l("Settings changed. Your edits are preserved.", "运行设置已有更新，你的修改已保留。")}{" "}<Button type="button" variant="secondary" disabled={!enabled || mutation.busy || mutation.uncertain} onClick={() => {
          if (!dirty || window.confirm(l("Replace unsaved edits?", "替换尚未保存的修改？"))) {
            mutation.clearError();
            setBaseline(context.control);
            setDraft(context.control);
          }
        }}>{l("Load latest", "载入最新设置")}</Button></p>}
      {mutation.error && <div role="alert" className="space-y-2 text-sm text-danger-foreground"><p>{errorMessage(mutation.error)}</p>{mutation.error === "CONFLICT" && <Button type="button" variant="secondary" disabled={!enabled || mutation.busy} onClick={onCommitted}>{l("Refresh settings", "刷新设置")}</Button>}</div>}
      {mode === "view" ? <div hidden={!enabled}><DetailFields items={[[l("AI enabled", "AI 已启用"), values.enabled ? l("Yes", "是") : l("No", "否")], [l("Audience", "开放范围"), values.audience === "ALL" ? l("All accounts", "全部账户") : l("Allowed accounts", "指定账户")], [l("User daily limit (UTC)", "每用户每日额度（UTC）"), values.user_daily_limit], [l("Service daily capacity", "服务每日总容量"), values.global_daily_limit], [l("User minute limit", "每用户每分钟额度"), values.user_minute_limit]]} /></div> : <form id="admin-runtime-settings" className="space-y-4" onSubmit={event => {
        event.preventDefault();
        void save();
      }}><fieldset disabled={!enabled || mutation.busy || mutation.uncertain} hidden={!enabled} className="space-y-4">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => changeDraft({
              ...draft,
              enabled: event.target.checked
            })} />{l("Enable AI", "启用 AI")}</label>
        <label className="block space-y-1 text-sm"><span>{l("Audience", "开放范围")}</span><select className="h-10 w-full rounded-md border border-border bg-bg px-3" value={draft.audience} onChange={event => changeDraft({
              ...draft,
              audience: event.target.value as "ALL" | "ALLOWLIST"
            })}><option value="ALLOWLIST">{l("Allowed accounts", "指定账户")}</option><option value="ALL">{l("All accounts", "全部账户")}</option></select></label>
        {(["user_daily_limit", "global_daily_limit", "user_minute_limit"] as const).map((key, index) => <label key={key} className="block space-y-1 text-sm"><span>{l(["Requests per user / UTC day", "Service daily capacity", "Requests per user / minute"][index], ["每用户每日请求数（UTC）", "服务每日总容量", "每用户每分钟请求数"][index])}</span><Input required inputMode="numeric" pattern="(0|[1-9][0-9]*)" value={draft[key]} onChange={event => changeDraft({
              ...draft,
              [key]: event.target.value
            })} /></label>)}
      </fieldset></form>}
    </ModalDialog>}
  </div>;
}
