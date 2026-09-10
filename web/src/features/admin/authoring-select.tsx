"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminAuthoringOptionsSchema, type AdminAuthoringOption, type AdminOptionKind } from "@/lib/admin/contract";
import type { AdminMessages } from "./messages";

type Props = {
  accessToken: string; kind: AdminOptionKind; parent?: string; value: string;
  label: string; onChange: (id: string, option?: AdminAuthoringOption) => void;
  t: AdminMessages; disabled?: boolean; firstOnly?: boolean;
};

export function AuthoringSelect(props: Props) {
  return <Options key={`${props.accessToken}:${props.kind}:${props.parent ?? ""}`} {...props} />;
}

function Options({ accessToken, kind, parent, value, label, onChange, t, disabled, firstOnly }: Props) {
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState("");
  const [state, setState] = useState<{ items: AdminAuthoringOption[]; selected?: AdminAuthoringOption; next: string | null; loading: boolean; error: boolean }>({ items: [], next: null, loading: true, error: false });
  useEffect(() => {
    const controller = new AbortController();
    async function read(id?: string) {
      const query = new URLSearchParams({ section: "options", kind });
      if (parent) query.set("parent", parent);
      if (id) query.set("id", id);
      else { if (search) query.set("search", search); if (after) query.set("after", after); }
      const response = await fetch(`/api/admin?${query}`, { cache: "no-store", signal: controller.signal, headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error("options unavailable");
      const page = adminAuthoringOptionsSchema.parse(await response.json());
      if (page.kind !== kind) throw new Error("options mismatch");
      return page;
    }
    if (kind === "prices" && !parent) return () => controller.abort();
    void Promise.all([read(), value ? read(value) : Promise.resolve(null)]).then(([page, selected]) => {
      if (controller.signal.aborted) return;
      setState(current => ({ items: [...new Map([...(after ? current.items : []), ...page.items].map(item => [item.id, item])).values()], selected: selected?.items[0], next: page.nextCursor, loading: false, error: false }));
    }).catch(() => { if (!controller.signal.aborted) setState({ items: [], next: null, loading: false, error: true }); });
    return () => controller.abort();
  }, [accessToken, kind, parent, search, after, value]);
  const items = [...new Map([...(state.selected ? [state.selected] : []), ...state.items].map(item => [item.id, item])).values()];
  const missingParent = kind === "prices" && !parent;
  return <div className="min-w-0 space-y-2">
    <label className="block text-sm">{label}
      <select aria-label={label} className="mt-1 w-full min-w-0 rounded border border-border px-3 py-2 text-sm" value={value} disabled={disabled || missingParent || state.loading || state.error}
        onChange={event => onChange(event.target.value, items.find(item => item.id === event.target.value))}>
        <option value="">{t.chooseOption}</option>
        {value && !items.some(item => item.id === value) && <option value={value} disabled>{value} — {t.unavailable}</option>}
        {items.map(item => <option key={item.id} value={item.id} disabled={['archived', 'retired', 'deprecated'].includes(item.status) || (firstOnly && item.latestVersion !== 0)}>{item.label} · {item.status}{item.latestVersion === 0 ? ` · ${t.noVersions}` : ""}</option>)}
      </select>
    </label>
    <Input aria-label={`${label} — ${t.search}`} placeholder={t.search} maxLength={100} value={search} disabled={disabled || missingParent}
      onChange={event => { setSearch(event.target.value); setAfter(""); setState({ items: [], next: null, loading: true, error: false }); }} />
    {state.error && <p role="alert" className="text-sm text-danger-foreground">{t.loadFailed}</p>}
    {missingParent && <p className="text-sm text-foreground-muted">{t.chooseParent}</p>}
    {!state.loading && !state.error && items.length === 0 && <p className="text-sm text-foreground-muted">{t.missingOptions}</p>}
    {state.next && <Button type="button" variant="secondary" size="sm" disabled={state.loading} onClick={() => { setAfter(state.next!); setState(current => ({ ...current, loading: true })); }}>{t.nextPage}</Button>}
  </div>;
}
