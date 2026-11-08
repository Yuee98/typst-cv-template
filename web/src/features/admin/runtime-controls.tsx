"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminErrorSchema, adminRuntimeReadbackSchema, adminValidationReportSchema, type AdminContext } from "@/lib/admin/contract";
import { AdminRecordActions } from "./record-actions";
export function AdminRuntimeControls({
  context,
  accessToken,
  locale,
  onCommitted
}: {
  context: AdminContext;
  accessToken: string;
  locale: "zh" | "en";
  onCommitted: () => void;
}) {
  const [targetKind, setTargetKind] = useState("PROFILE");
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function produce(operation: "validate" | "readback") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          operation,
          contract_code: context.contract_code,
          database_instance_id: context.database_instance_id,
          ...(operation === "validate" ? {
            target_kind: targetKind,
            target_id: targetId
          } : {})
        })
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        setMessage(adminErrorSchema.parse(raw).error.code);
        return;
      }
      const report = operation === "validate" ? adminValidationReportSchema.parse(raw) : adminRuntimeReadbackSchema.parse(raw);
      setMessage(`${report.external_id}: ${report.passed ? locale === "zh" ? "通过" : "Passed" : report.reasons.join(", ")} · ${report.time_expires}`);
    } catch {
      setMessage(locale === "zh" ? "检查失败，请刷新后重试。" : "Check unavailable. Refresh and retry.");
    } finally {
      setBusy(false);
    }
  }
  return <div className="min-w-0 space-y-4"><section className="min-w-0 space-y-3 rounded border border-border p-4"><h2 className="break-words font-semibold">{locale === "zh" ? "配置验证" : "Configuration verification"}</h2><p className="min-w-0 break-words text-sm text-foreground-muted">{locale === "zh" ? "发布前验证目标及全部依赖；开启前检查当前策略中所有时段的候选配置。检查不发送上游请求。" : "Validate the target and all dependencies before publishing; check every option in all policy periods before enabling. These checks do not send upstream requests."}</p><select aria-label="Target kind" value={targetKind} onChange={e => setTargetKind(e.target.value)} className="min-w-0 max-w-full rounded border border-border bg-bg p-2"><option value="PROFILE">{locale === "zh" ? "配置版本" : "Profile version"}</option><option value="PRICE">{locale === "zh" ? "价格版本" : "Price version"}</option><option value="POLICY">{locale === "zh" ? "策略版本" : "Policy version"}</option></select><Input className="min-w-0 max-w-full" aria-label="Target ID" value={targetId} onChange={e => setTargetId(e.target.value)} /><div className="flex min-w-0 flex-wrap gap-2"><Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" disabled={busy || !targetId} onClick={() => void produce("validate")}>{locale === "zh" ? "验证目标" : "Validate target"}</Button><Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" variant="secondary" disabled={busy} onClick={() => void produce("readback")}>{locale === "zh" ? "检查当前策略" : "Check current policy"}</Button></div>{message && <p role="status" className="min-w-0 break-all text-sm">{message}</p>}</section><AdminRecordActions section="controls" context={context} accessToken={accessToken} locale={locale} onCommitted={onCommitted} /></div>;
}
