import { validateRoutingRulesV1, type RoutingRouteV1 } from "@/lib/routing-rules-v1";
export type RoutingDraft = {
  defaultRoute: RoutingRouteV1;
  windows: { key: string; weekdays: number[]; start: string; end: string; route: RoutingRouteV1 }[];
};
export function minuteText(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`; }
export function parseMinute(text: string, end = false) {
  if (end && text === "24:00") return 1440;
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(text)) throw new Error("Invalid time");
  const [hour, minute] = text.split(":").map(Number); return hour * 60 + minute;
}
export function routingDraft(value: unknown, first = false): RoutingDraft | null {
  if (first) return { defaultRoute: { profileVersionId: "", priceVersionId: "" }, windows: [] };
  try {
    const rules = validateRoutingRulesV1(value);
    return { defaultRoute: rules.defaultRoute, windows: rules.windows.map((window, i) => ({ key: String(i), weekdays: [...window.weekdays], start: minuteText(window.startMinute), end: minuteText(window.endMinute), route: window.route })) };
  } catch { return null; }
}
export function serializeRoutingDraft(draft: RoutingDraft) {
  return validateRoutingRulesV1({ schemaVersion: "routing_rules_v1", defaultRoute: draft.defaultRoute, windows: draft.windows.map(window => ({ weekdays: window.weekdays, startMinute: parseMinute(window.start), endMinute: parseMinute(window.end, true), route: window.route })) });
}
