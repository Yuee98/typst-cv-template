"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateRoutingRulesV1, type RoutingRouteV1 } from "@/lib/routing-rules-v1";
import type { AdminMessages } from "./messages";
import { AuthoringSelect } from "./authoring-select";
import { minuteText, serializeRoutingDraft, type RoutingDraft } from "./routing-form-model";

type Shared = { accessToken: string; t: AdminMessages };
function RouteFields({ route, onChange, ...shared }: Shared & { route: RoutingRouteV1; onChange: (route: RoutingRouteV1) => void }) {
  return <div className="grid gap-3 sm:grid-cols-2">
    <AuthoringSelect {...shared} kind="versions" label={shared.t.profileVersionId} value={route.profileVersionId} onChange={id => onChange({ profileVersionId: id, priceVersionId: "" })} />
    <AuthoringSelect {...shared} kind="prices" parent={route.profileVersionId} label={shared.t.priceVersionId} value={route.priceVersionId} onChange={id => onChange({ ...route, priceVersionId: id })} />
  </div>;
}
export function RoutingRulesForm({ value, onChange, ...shared }: Shared & { value: RoutingDraft | null; onChange: (value: RoutingDraft) => void }) {
  const { t } = shared;
  if (!value) return <p role="alert" className="text-danger-foreground">{t.unsupportedRules}</p>;
  let valid = true; try { serializeRoutingDraft(value); } catch { valid = false; }
  const update = (index: number, patch: Partial<RoutingDraft["windows"][number]>) => onChange({ ...value, windows: value.windows.map((window, i) => i === index ? { ...window, ...patch } : window) });
  return <div className="space-y-4">
    <p className="text-sm text-foreground-muted">{t.rulesHint}</p>
    <fieldset className="space-y-3 rounded border border-border p-3"><legend>{t.defaultRoute}</legend>
      <RouteFields {...shared} route={value.defaultRoute} onChange={defaultRoute => onChange({ ...value, defaultRoute })} />
    </fieldset>
    {value.windows.map((window, index) => <fieldset key={window.key} className="space-y-3 rounded border border-border p-3">
      <legend>{t.timeWindow} {index + 1}</legend>
      <div className="flex flex-wrap gap-3">{t.weekdays.map((day, i) => <label key={i} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={window.weekdays.includes(i + 1)} onChange={event => update(index, { weekdays: event.target.checked ? [...window.weekdays, i + 1] : window.weekdays.filter(day => day !== i + 1) })} />{day}</label>)}</div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">{t.startTime}<Input aria-label={t.startTime} placeholder="09:00" maxLength={5} value={window.start} onChange={event => update(index, { start: event.target.value })} /></label>
        <label className="text-sm">{t.endTime}<Input aria-label={t.endTime} placeholder="24:00" maxLength={5} value={window.end} onChange={event => update(index, { end: event.target.value })} /></label>
      </div>
      <RouteFields {...shared} route={window.route} onChange={route => update(index, { route })} />
      <Button type="button" variant="secondary" onClick={() => onChange({ ...value, windows: value.windows.filter((_, i) => i !== index) })}>{t.removeWindow}</Button>
    </fieldset>)}
    <Button type="button" variant="secondary" disabled={value.windows.length >= 32} onClick={() => onChange({ ...value, windows: [...value.windows, { key: crypto.randomUUID(), weekdays: [1,2,3,4,5], start: "09:00", end: "18:00", route: { profileVersionId: "", priceVersionId: "" } }] })}>{t.addWindow}</Button>
    {!valid && <p role="status" className="text-sm text-foreground-muted">{t.invalidRules}</p>}
  </div>;
}
export function RoutingRulesSummary({ value, locale, t }: { value: unknown; locale: string; t: AdminMessages }) {
  let rules: ReturnType<typeof validateRoutingRulesV1>;
  try { rules = validateRoutingRulesV1(value); } catch { return <p role="alert">{t.unsupportedRules}</p>; }

    const route = (target: RoutingRouteV1) => <div className="space-y-1 break-all text-sm"><p>{t.profileVersionId}: <a className="text-accent-soft-foreground hover:underline" href={`/${locale}/admin/profiles/${target.profileVersionId}`}>{target.profileVersionId}</a></p><p>{t.priceVersionId}: <a className="text-accent-soft-foreground hover:underline" href={`/${locale}/admin/prices/${target.priceVersionId}`}>{target.priceVersionId}</a></p></div>;
    return <section className="space-y-3 rounded border border-border bg-surface p-4">
      <h2 className="font-semibold">{t.rules} · Asia/Shanghai</h2><h3>{t.defaultRoute}</h3>{route(rules.defaultRoute)}
      {rules.windows.map((window, i) => <div key={i} className="border-t border-border pt-3"><p className="mb-2">{window.weekdays.map(day => t.weekdays[day - 1]).join(" / ")} · {minuteText(window.startMinute)}–{minuteText(window.endMinute)}</p>{route(window.route)}</div>)}
    </section>;
}
