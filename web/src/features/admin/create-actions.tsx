"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminPageSchema, type AdminRecordSection } from "@/lib/admin/contract";
import { AuthoringSelect } from "./authoring-select";
import { Panel, PolicyAction, PriceAction, ProviderActions, Result, useAdminMutation, type CommonProps } from "./record-actions";

type Props = Omit<CommonProps, "row"> & { section: AdminRecordSection; locale: string };
export function AdminCreateActions(props: Props) {
  const [open, setOpen] = useState(false);
  if (!["providers", "profiles", "prices", "policies"].includes(props.section)) return null;
  return <div className="space-y-4">
    <Button type="button" variant={open ? "secondary" : "default"} onClick={() => setOpen(!open)}>{open ? props.t.cancel : props.t.createNew}</Button>
    {open && <CreateForm key={`${props.accessToken}:${props.section}`} {...props} />}
  </div>;
}
function CreateForm(props: Props) {
  const [parent, setParent] = useState("");
  if (props.section === "providers") return <ProviderCreate {...props} />;
  if (props.section === "policies") return <PolicyAction {...props} first row={{}} />;
  return <div className="space-y-4">
    <AuthoringSelect accessToken={props.accessToken} kind={props.section === "profiles" ? "providers" : "versions"} value={parent}
      label={props.section === "profiles" ? props.t.providers : props.t.profileVersionId} onChange={setParent} t={props.t} />
    {parent && (props.section === "profiles"
      ? <ProviderIdentity key={`${props.accessToken}:${parent}`} {...props} id={parent} />
      : <PriceAction key={parent} {...props} first row={{ profileVersionId: parent, pricingLane: "default", latestVersion: "0", currency: "CNY", calculatorKind: "linear_token_v1" }} />)}
  </div>;
}
function ProviderIdentity({ id, ...props }: Props & { id: string }) {
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/admin?section=providers&id=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal, headers: { Authorization: `Bearer ${props.accessToken}` } })
      .then(async response => { if (!response.ok) throw new Error(); return adminPageSchema.parse(await response.json()); })
      .then(page => { if (!controller.signal.aborted) { if (page.section !== "providers" || page.items[0]?.id !== id) throw new Error(); setRow(page.items[0]); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [id, props.accessToken]);
  return error ? <p role="alert">{props.t.loadFailed}</p> : row ? <ProviderActions {...props} row={row} profileOnly /> : <p>…</p>;
}
function ProviderCreate(props: Props) {
  const { accessToken, draftsEnabled, t, locale } = props;
  const mutation = useAdminMutation(accessToken, t, operation => {
    if (operation.result.schemaVersion === "admin_provider_result_v1")
      window.location.assign(`/${locale}/admin/providers/${operation.result.providerId}`);
  });
  const [draft, setDraft] = useState({ providerKey: "", displayName: "", recipientKey: "", gatewayKind: "custom_compatible" as "custom_compatible" | "direct_deepseek" | "direct_mimo", defaultAdapterId: "", defaultEndpointUrl: "", defaultCredentialEnvName: "AI_PROVIDER_KEY_", defaultModelId: "", reason: "" });
  const change = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => { setDraft(current => ({ ...current, [key]: value })); mutation.changed(); };
  return <Panel title={t.createNew} writesEnabled={draftsEnabled} t={t}>
    <p className="text-sm text-foreground-muted">{t.genericProviderHint}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      {([["providerKey", t.providerKey], ["displayName", t.displayName], ["recipientKey", t.recipientKey]] as const).map(([key, label]) => <Input key={key} aria-label={label} placeholder={label} value={draft[key]} maxLength={200} onChange={event => change(key, event.target.value)} />)}
      <label className="text-sm">{t.gatewayKind}<select aria-label={t.gatewayKind} className="mt-1 w-full rounded border border-border p-2" value={draft.gatewayKind} onChange={event => change("gatewayKind", event.target.value as typeof draft.gatewayKind)}>
        <option value="custom_compatible">Custom compatible</option><option value="direct_deepseek">DeepSeek direct</option><option value="direct_mimo">MiMo direct</option>
      </select></label>
      <AuthoringSelect accessToken={accessToken} kind="adapters" value={draft.defaultAdapterId} label={t.adapter} onChange={id => change("defaultAdapterId", id)} t={t} />
      {([["defaultEndpointUrl", t.defaultEndpoint], ["defaultCredentialEnvName", t.defaultCredentialEnv], ["defaultModelId", t.defaultModel]] as const).map(([key, label]) => <Input key={key} aria-label={label} placeholder={label} value={draft[key]} onChange={event => change(key, event.target.value)} />)}
    </div>
    <Input aria-label={t.mutationReason} placeholder={t.mutationReason} maxLength={500} value={draft.reason} onChange={event => change("reason", event.target.value)} />
    <Button disabled={mutation.busy || Object.values(draft).some(value => !value.trim())} onClick={() => void mutation.run({ operation: "provider_create", ...draft })}>{t.createNew}</Button>
    <Result {...mutation} t={t} />
  </Panel>;
}
