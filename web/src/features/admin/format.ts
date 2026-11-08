export const adminText = (locale: "zh" | "en", en: string, zh: string) => locale === "zh" ? zh : en;
export function formatMinute(value: number | null): string {
  return value === null ? "—" : `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
export function parseMinute(value: string, end = false): number {
  if (end && value === "24:00") return 1440;
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) throw new Error("Use HH:mm (24:00 is allowed only as the end)");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
export function rulePeriod(record: {
  weekday?: unknown;
  start_minute?: unknown;
  end_minute?: unknown;
}, locale: "zh" | "en"): string {
  if (record.weekday === null) return adminText(locale, "Other periods", "其他时段");
  const day = Number(record.weekday),
    labels = locale === "zh" ? ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"] : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return `${labels[day - 1] ?? "—"} ${formatMinute(Number(record.start_minute))}–${formatMinute(Number(record.end_minute))} · Asia/Shanghai`;
}
export function formatMoney(value: unknown, currency: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return "—";
  const n = BigInt(value),
    scale = BigInt(1000000000),
    remainder = String(n % scale).padStart(9, "0").replace(/0+$/, "");
  return `${n / scale}${remainder ? `.${remainder}` : ""} ${typeof currency === "string" ? currency : ""}`.trim();
}
export function adminDate(value: unknown, locale: "zh" | "en"): string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") : typeof value === "string" ? value : "—";
}
export function auditKindLabel(kind: string, locale: "zh" | "en"): string {
  const names: Record<string, readonly [string, string]> = {
    configurations: ["Configurations", "配置"],
    prices: ["Prices", "价格"],
    rules: ["Time rules", "时间规则"],
    rule_members: ["Rule options", "规则选项"],
    runtime_control: ["Runtime controls", "运行控制"],
    allowed_users: ["Allowed accounts", "允许账户"],
    documents: ["Legal documents", "法律文档"],
    acceptances: ["Acceptance records", "同意记录"],
    members: ["Administrators", "管理员"]
  };
  return names[kind] ? adminText(locale, ...names[kind]) : kind;
}
export function statusLabel(value: unknown, locale: "zh" | "en"): string {
  if (value == null) return "—";
  const names: Record<string, string> = {
    INSERT: "创建",
    UPDATE: "更新",
    DELETE: "删除",
    RESERVED: "已预留",
    RUNNING: "处理中",
    HELD: "等待结算",
    FINALIZED: "已结算",
    SUCCEEDED: "成功",
    CANCELED: "已取消",
    FAILED_UPSTREAM: "上游失败",
    INVALID_OUTPUT: "输出无效",
    RELEASED: "已释放",
    TIMED_OUT: "超时",
    UNKNOWN: "未知"
  };
  return locale === "zh" ? names[String(value)] ?? String(value) : String(value).replaceAll("_", " ").toLowerCase();
}
