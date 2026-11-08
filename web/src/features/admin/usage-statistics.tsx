import { useState } from "react";
import type { AdminRecord } from "@/lib/admin/contract";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { DetailFields } from "./admin-detail-sections";
import { adminText, formatMoney } from "./format";
export function UsageStatistics({
  data,
  locale,
  enabled = true
}: {
  data: {
    global_quota: AdminRecord[];
    configurations: AdminRecord[];
  };
  locale: "zh" | "en";
  enabled?: boolean;
}) {
  const l = (en: string, zh: string) => adminText(locale, en, zh);
  const [selected, setSelected] = useState<AdminRecord | null>(null);
  return <div className="space-y-5"><p className="text-sm text-foreground-muted">{l("Usage is grouped by UTC reservation day and the exact configuration and currency used. Provider capacity uses the UTC admission day.", "用量按 UTC 预留日期、请求实际配置和币种统计。供应商总容量按 UTC 实际发送日期统计。")}</p><section className="overflow-x-auto rounded-xl border border-border bg-surface"><h3 className="px-4 pt-4 font-medium">{l("Daily provider capacity", "供应商每日容量")}</h3><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-foreground-muted"><th className="p-4">{l("Date (UTC)", "日期（UTC）")}</th><th className="p-4">{l("Admitted requests", "已接纳请求")}</th></tr></thead><tbody>{data.global_quota.map((row, i) => <tr key={i} className="border-b border-border last:border-0"><td className="p-4">{String(row.day)}</td><td className="p-4">{String(row.admitted_count)}</td></tr>)}{data.global_quota.length === 0 && <tr><td className="p-4 text-foreground-muted" colSpan={2}>{l("No records.", "暂无记录。")}</td></tr>}</tbody></table></section><section className="overflow-x-auto rounded-xl border border-border bg-surface"><h3 className="px-4 pt-4 font-medium">{l("Configuration usage", "配置用量")}</h3><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-foreground-muted">{[l("Date (UTC)", "日期（UTC）"), l("Configuration", "配置"), l("Currency", "币种"), l("Requests", "请求数"), l("Known estimated cost", "已知估算成本"), l("Details", "详情")].map(label => <th className="whitespace-nowrap p-4" key={label}>{label}</th>)}</tr></thead><tbody>{data.configurations.map((row, i) => <tr key={i} className="border-b border-border last:border-0"><td className="whitespace-nowrap p-4">{String(row.day)}</td><td className="p-4">{String(row.config_name)}</td><td className="p-4">{String(row.currency)}</td><td className="p-4">{String(row.settled_count)}</td><td className="whitespace-nowrap p-4">{formatMoney(row.known_estimated_cost_nanos, row.currency)}{Number(row.incomplete_cost_count) > 0 ? ` · ${l("Incomplete", "不完整")}` : ""}</td><td className="p-4"><Button size="sm" variant="secondary" onClick={() => setSelected(row)}>{l("View", "查看")}</Button></td></tr>)}{data.configurations.length === 0 && <tr><td colSpan={6} className="p-4 text-foreground-muted">{l("No records.", "暂无记录。")}</td></tr>}</tbody></table></section>{selected && <ModalDialog open title={l("Usage details", "用量明细")} closeLabel={l("Close dialog", "关闭弹窗")} onClose={() => setSelected(null)} className="max-w-2xl" footer={<Button variant="secondary" onClick={() => setSelected(null)}>{l("Close", "关闭")}</Button>}><div hidden={!enabled}><DetailFields items={[[l("Date (UTC)", "日期（UTC）"), String(selected.day)], [l("Configuration", "配置"), String(selected.config_name)], [l("Currency", "币种"), String(selected.currency)], ...([["settled_count", "Settled requests", "已结算请求"], ["succeeded_count", "Succeeded", "成功"], ["failed_count", "Failed", "失败"], ["canceled_count", "Canceled", "取消"], ["released_count", "Released", "已释放"], ["attempt_count", "Attempts", "尝试数"], ["input_tokens", "Input tokens", "输入 Token"], ["output_tokens", "Output tokens", "输出 Token"], ["incomplete_usage_count", "Incomplete usage", "用量不完整"], ["incomplete_cost_count", "Incomplete cost", "成本不完整"]] as const).map(([key, en, zh]) => [l(en, zh), String(selected[key])] as const), [l("Known estimated cost", "已知估算成本"), formatMoney(selected.known_estimated_cost_nanos, selected.currency)]]} /></div></ModalDialog>}</div>;
}
