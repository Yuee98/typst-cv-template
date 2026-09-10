"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  adminCommittedOperationSchema,
  adminErrorSchema,
  type AdminCommittedOperation,
  type AdminMutationRequest,
  type AdminRecordSection,
} from "@/lib/admin/contract";
import { RoutingRulesForm } from "./routing-rules-form";
import { routingDraft, serializeRoutingDraft } from "./routing-form-model";
import { AuthoringSelect } from "./authoring-select";
import type { AdminMessages } from "./messages";

type Row = Record<string, unknown>;
type AdminMutationPayload = AdminMutationRequest extends infer Request
  ? Request extends { idempotencyKey: string }
    ? Omit<Request, "idempotencyKey">
    : never
  : never;

function text(row: Row, key: string) {
  const value = row[key];
  return typeof value === "string" ? value : "";
}
function revision(row: Row, key: string) {
  const value = row[key];
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/u.test(value))
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  return "0";
}
function object(row: Row, key: string) {
  const value = row[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function pretty(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}
function parseIds(value: string) {
  return value
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function useAdminMutation(
  accessToken: string,
  t: AdminMessages,
  onCommitted: (operation: AdminCommittedOperation) => void,
) {
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<AdminCommittedOperation | null>(null);
  function changed() {
    setIdempotencyKey(crypto.randomUUID());
    setCommitted(null);
    setError(null);
  }
  function reject(message: string) {
    setError(message);
  }
  async function run(
    request: AdminMutationPayload,
  ) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...request, idempotencyKey }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const parsed = adminErrorSchema.safeParse(raw);
        if (parsed.success && parsed.data.error.code === "STEP_UP_REQUIRED")
          setError(t.stepUpRequired);
        else if (parsed.success && parsed.data.error.code === "CONFLICT")
          setError(t.invalid);
        else if (parsed.success && parsed.data.error.code === "NOT_READY")
          setError(t.noConfiguration);
        else setError(t.loadFailed);
        return;
      }
      const parsed = adminCommittedOperationSchema.safeParse(raw);
      if (!parsed.success) {
        setError(t.schemaError);
        return;
      }
      setCommitted(parsed.data);
      onCommitted(parsed.data);
    } catch {
      // Retain the idempotency key so a response-loss retry is safe.
      setError(t.retryOriginal);
    } finally {
      setBusy(false);
    }
  }
  return { busy, changed, committed, error, reject, run };
}

export function Result({
  committed,
  error,
  t,
}: {
  committed: AdminCommittedOperation | null;
  error: string | null;
  t: AdminMessages;
}) {
  const result = committed?.result;
  const target = result?.schemaVersion === "admin_profile_version_result_v1" ? `profiles/${result.profileVersionId}`
    : result?.schemaVersion === "admin_price_version_result_v1" ? `prices/${result.priceVersionId}`
    : result?.schemaVersion === "admin_provider_result_v1" ? `providers/${result.providerId}`
    : result?.schemaVersion === "admin_routing_policy_draft_result_v1" || result?.schemaVersion === "admin_routing_policy_result_v1" ? `policies/${result.policyVersionId}` : null;
  return (
    <>
      {error && <p className="text-sm text-danger-foreground">{error}</p>}
      {committed && (
        <div className="rounded-md border border-success-border bg-success-soft p-3 text-sm">
          <p className="font-medium">{t.mutationCommitted}</p>
          <p className="mt-1 break-all text-foreground-muted">
            {t.operationId}: {committed.operationId}
          </p>
          <p className="mt-1 break-all text-foreground-muted">
            {t.auditId}: {committed.auditId}
          </p>
          {committed.result.schemaVersion === "admin_profile_identity_result_v1" && <p className="mt-1 break-all">{t.profileId}: {committed.result.profileId}</p>}
          {committed.result.schemaVersion === "admin_profile_version_result_v1" && <p className="mt-1 break-all">{t.profileVersionId}: {committed.result.profileVersionId}</p>}
          {committed.result.schemaVersion === "admin_price_version_result_v1" && <p className="mt-1 break-all">{t.priceVersionId}: {committed.result.priceVersionId}</p>}
          {target && <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => window.location.assign(`${window.location.pathname.split("/admin")[0]}/admin/${target}`)}>{t.view}</Button>}
        </div>
      )}
    </>
  );
}

export function Panel({
  title,
  writesEnabled,
  t,
  children,
}: {
  title: string;
  writesEnabled: boolean;
  t: AdminMessages;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <h2 className="font-semibold">{title}</h2>
      {!writesEnabled && (
        <p className="text-sm text-foreground-muted">{t.writesUnavailable}</p>
      )}
      <fieldset disabled={!writesEnabled} className="space-y-4 disabled:opacity-60">
        {children}
      </fieldset>
    </section>
  );
}

function UserAction(props: CommonProps) {
  const { row, accessToken, writesEnabled, onRefresh, t } = props;
  const mutation = useAdminMutation(accessToken, t, onRefresh);
  const [reason, setReason] = useState("");
  const enabled = row.isAdmin === true;
  return (
    <Panel
      title={enabled ? t.revokeAdmin : t.grantAdmin}
      writesEnabled={writesEnabled}
      t={t}
    >
      <Input
        value={reason}
        maxLength={500}
        placeholder={t.mutationReason}
        onChange={(event) => {
          setReason(event.target.value);
          mutation.changed();
        }}
      />
      <Button
        disabled={mutation.busy || reason.trim() !== reason || !reason}
        onClick={() =>
          void mutation.run({
            operation: "membership_set",
            targetUserId: text(row, "id"),
            enabled: !enabled,
            expectedRevision: revision(row, "revision"),
            reason,
          })
        }
      >
        {enabled ? t.revokeAdmin : t.grantAdmin}
      </Button>
      <Result {...mutation} t={t} />
    </Panel>
  );
}

type ProviderDraft = {
  displayName: string;
  defaultAdapterId: string;
  defaultEndpointUrl: string;
  defaultCredentialEnvName: string;
  defaultModelId: string;
  archived: boolean;
};
export function ProviderActions(props: CommonProps & { profileOnly?: boolean }) {
  const { row, accessToken, draftsEnabled, onRefresh, t } = props;
  const defaults = useAdminMutation(accessToken, t, onRefresh);
  const [firstProfileId, setFirstProfileId] = useState("");
  const identity = useAdminMutation(accessToken, t, (operation) => {
    if (operation.result.schemaVersion === "admin_profile_identity_result_v1") {
      setFirstProfileId(operation.result.profileId);
    }
    onRefresh();
  });
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<ProviderDraft>({
    displayName: text(row, "displayName"),
    defaultAdapterId: text(row, "defaultAdapterId"),
    defaultEndpointUrl: text(row, "defaultEndpointUrl"),
    defaultCredentialEnvName: text(row, "defaultCredentialEnvName"),
    defaultModelId: text(row, "defaultModelId"),
    archived: row.archived === true,
  });
  const [profile, setProfile] = useState({
    profileKey: "",
    displayName: "",
    modelVendor: "",
    reason: "",
  });
  const adapters = Array.isArray(row.adapterOptions)
    ? (row.adapterOptions as Array<Record<string, unknown>>)
    : [];
  const update = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    defaults.changed();
  };
  return (
    <div className="space-y-4">
      {!props.profileOnly && <Panel title={t.saveDefaults} writesEnabled={draftsEnabled} t={t}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input value={draft.displayName} placeholder={t.displayName} onChange={(event) => update("displayName", event.target.value)} />
          <select className="rounded border border-border bg-bg px-3 py-2 text-sm" value={draft.defaultAdapterId} onChange={(event) => update("defaultAdapterId", event.target.value)}>
            {adapters.map((adapter) => <option key={String(adapter.adapterId)} value={String(adapter.adapterId)}>{String(adapter.displayName)}</option>)}
          </select>
          <Input value={draft.defaultEndpointUrl} placeholder={t.defaultEndpoint} onChange={(event) => update("defaultEndpointUrl", event.target.value)} />
          <Input value={draft.defaultCredentialEnvName} placeholder={t.defaultCredentialEnv} onChange={(event) => update("defaultCredentialEnvName", event.target.value)} />
          <Input value={draft.defaultModelId} placeholder={t.defaultModel} onChange={(event) => update("defaultModelId", event.target.value)} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.archived} onChange={(event) => update("archived", event.target.checked)} />{t.archived}</label>
        </div>
        <Input value={reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => { setReason(event.target.value); defaults.changed(); }} />
        <Button disabled={defaults.busy || !reason} onClick={() => void defaults.run({
          operation: "provider_defaults_update",
          providerId: text(row, "id"),
          ...draft,
          expectedRevision: revision(row, "revision"),
          reason,
        })}>{t.saveDefaults}</Button>
        <Result {...defaults} t={t} />
      </Panel>}
      <Panel title={t.createProfileIdentity} writesEnabled={draftsEnabled} t={t}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input value={profile.profileKey} placeholder={t.profileKey} onChange={(event) => { setProfile({ ...profile, profileKey: event.target.value }); identity.changed(); }} />
          <Input value={profile.displayName} placeholder={t.displayName} onChange={(event) => { setProfile({ ...profile, displayName: event.target.value }); identity.changed(); }} />
          <Input value={profile.modelVendor} placeholder={t.model} onChange={(event) => { setProfile({ ...profile, modelVendor: event.target.value }); identity.changed(); }} />
          <Input value={profile.reason} placeholder={t.mutationReason} onChange={(event) => { setProfile({ ...profile, reason: event.target.value }); identity.changed(); }} />
        </div>
        <Button disabled={identity.busy || !profile.reason} onClick={() => void identity.run({
          operation: "provider_profile_create",
          providerId: text(row, "id"),
          ...profile,
        })}>{t.createProfileIdentity}</Button>
        <Result {...identity} t={t} />
      </Panel>
      <Panel title={t.prepareFirstVersion} writesEnabled={draftsEnabled} t={t}>
        <p className="text-sm text-foreground-muted">{t.firstVersionHint}</p>
        <AuthoringSelect accessToken={accessToken} kind="identities" parent={text(row, "id")} firstOnly value={firstProfileId} label={t.resumeIdentity} onChange={setFirstProfileId} t={t} />
      </Panel>
      {firstProfileId && <ProfileAction
        {...props}
        key={firstProfileId}
        first
        row={{
          profileId: firstProfileId, latestVersion: "0", adapterOptions: adapters,
          suggestedAdapterId: row.defaultAdapterId,
          wireApiKind: adapters.find(adapter => adapter.adapterId === row.defaultAdapterId)?.wireApiKind,
          suggestedEndpointUrl: row.defaultEndpointUrl,
          suggestedCredentialEnvName: row.defaultCredentialEnvName,
          suggestedModelId: row.defaultModelId,
        }}
      />}
    </div>
  );
}

export function ProfileAction({ first = false, ...props }: CommonProps & { first?: boolean }) {
  const { row, accessToken, draftsEnabled, onRefresh, t } = props;
  const sourceId = text(row, "id") || text(row, "profileId");
  const [createdVersion, setCreatedVersion] = useState<{ sourceId: string; versionId: string } | null>(null);
  const priceTargetId = createdVersion?.sourceId === sourceId ? createdVersion.versionId : text(row, "id");
  const mutation = useAdminMutation(accessToken, t, (operation) => {
    if (operation.result.schemaVersion === "admin_profile_version_result_v1") {
      setCreatedVersion({ sourceId, versionId: operation.result.profileVersionId });
    }
    onRefresh();
  });
  const adapters = Array.isArray(row.adapterOptions)
    ? (row.adapterOptions as Array<Record<string, unknown>>)
    : [];
  const [draft, setDraft] = useState({
    adapterId: text(row, "suggestedAdapterId"),
    wireApiKind: text(row, "wireApiKind"),
    endpointUrl: text(row, "suggestedEndpointUrl"),
    credentialEnvName: text(row, "suggestedCredentialEnvName"),
    modelId: text(row, "suggestedModelId"),
    capabilityContractId: text(row, "capabilityContractId"),
    cachePolicyId: text(row, "cachePolicyId"),
    legalManifestId: text(row, "legalManifestId"),
    displayDisclosureKey: text(row, "displayDisclosureKey"),
    config: pretty(object(row, "config")),
    reason: "",
  });
  const update = (key: keyof typeof draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    mutation.changed();
  };
  return (
    <div className="space-y-4">
    <Panel title={first ? t.firstVersion : t.createSuccessor} writesEnabled={draftsEnabled} t={t}>
      <p className="break-all text-sm">{t.profileId}: {text(row, "profileId")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <select className="rounded border border-border bg-bg px-3 py-2 text-sm" value={draft.adapterId} onChange={(event) => {
          const adapter = adapters.find((item) => item.adapterId === event.target.value);
          setDraft((current) => ({ ...current, adapterId: event.target.value, wireApiKind: String(adapter?.wireApiKind ?? current.wireApiKind) }));
          mutation.changed();
        }}>{adapters.map((adapter) => <option key={String(adapter.adapterId)} value={String(adapter.adapterId)}>{String(adapter.displayName)}</option>)}</select>
        <Input value={draft.wireApiKind} readOnly />
        <Input value={draft.endpointUrl} placeholder={t.endpoint} onChange={(event) => update("endpointUrl", event.target.value)} />
        <Input value={draft.credentialEnvName} placeholder={t.credentialEnv} onChange={(event) => update("credentialEnvName", event.target.value)} />
        <Input value={draft.modelId} placeholder={t.model} onChange={(event) => update("modelId", event.target.value)} />
        <Input value={draft.capabilityContractId} placeholder="Capability contract" onChange={(event) => update("capabilityContractId", event.target.value)} />
        <Input value={draft.cachePolicyId} placeholder="Cache policy" onChange={(event) => update("cachePolicyId", event.target.value)} />
        <Input value={draft.legalManifestId} placeholder={t.legalManifest} onChange={(event) => update("legalManifestId", event.target.value)} />
        <Input value={draft.displayDisclosureKey} placeholder={t.displayDisclosure} onChange={(event) => update("displayDisclosureKey", event.target.value)} />
      </div>
      <textarea aria-label={t.profileConfig} className="min-h-36 w-full rounded border border-border bg-bg p-3 font-mono text-sm" value={draft.config} onChange={(event) => update("config", event.target.value)} />
      <Input value={draft.reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => update("reason", event.target.value)} />
      <Button disabled={mutation.busy || !draft.reason} onClick={() => {
        try {
          const config = JSON.parse(draft.config) as unknown;
          if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
          void mutation.run({
            operation: "profile_version_create",
            profileId: text(row, "profileId"),
            expectedLatestVersion: first ? "0" : revision(row, "latestVersion"),
            adapterId: draft.adapterId,
            wireApiKind: draft.wireApiKind as "chat_completions_v1" | "responses_v1",
            endpointUrl: draft.endpointUrl,
            credentialEnvName: draft.credentialEnvName,
            modelId: draft.modelId,
            capabilityContractId: draft.capabilityContractId,
            cachePolicyId: draft.cachePolicyId,
            legalManifestId: draft.legalManifestId,
            displayDisclosureKey: draft.displayDisclosureKey,
            config: config as Record<string, unknown>,
            reason: draft.reason,
          });
        } catch {
          mutation.reject(t.invalid);
        }
      }}>{t.createSuccessor}</Button>
      <Result {...mutation} t={t} />
    </Panel>
    {!first && <ProfileLifecycle {...props} />}
    {priceTargetId && <PriceAction
      {...props}
      first
      key={priceTargetId}
      row={{
        profileVersionId: priceTargetId,
        pricingLane: "default", latestVersion: "0", currency: "CNY", calculatorKind: "linear_token_v1",
      }}
    />}
    </div>
  );
}

export function PriceAction({ first = false, ...props }: CommonProps & { first?: boolean }) {
  const { row, accessToken, draftsEnabled, onRefresh, t } = props;
  const mutation = useAdminMutation(accessToken, t, onRefresh);
  const [draft, setDraft] = useState({
    pricingLane: text(row, "pricingLane"),
    currency: text(row, "currency"),
    calculatorKind: text(row, "calculatorKind"),
    validFrom: new Date().toISOString(),
    validTo: "",
    providerEffectiveFrom: text(row, "providerEffectiveFrom"),
    providerEffectiveTo: text(row, "providerEffectiveTo"),
    sourceUrl: text(row, "sourceUrl"),
    sourceCheckedAt: new Date().toISOString(),
    sourceSnapshotSha256: text(row, "sourceSnapshotSha256"),
    parameters: pretty(object(row, "parameters")),
    components: pretty(object(row, "components")),
    reason: "",
  });
  const update = (key: keyof typeof draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    mutation.changed();
  };
  return (
    <div className="space-y-4">
    <Panel title={first ? t.firstPrice : t.createSuccessor} writesEnabled={draftsEnabled} t={t}>
      <p className="break-all text-sm">{t.profileVersionId}: {text(row, "profileVersionId")}</p>
      {first && <>
        <p className="text-sm text-foreground-muted">{t.firstPriceHint}</p>
        <Input aria-label={t.pricingLane} value={draft.pricingLane} onChange={(event) => update("pricingLane", event.target.value)} />
      </>}
      <div className="grid gap-3 sm:grid-cols-2">
        {(["currency", "calculatorKind", "validFrom", "validTo", "providerEffectiveFrom", "providerEffectiveTo", "sourceUrl", "sourceCheckedAt", "sourceSnapshotSha256"] as const).map((key) => (
          <Input key={key} value={draft[key]} placeholder={key} onChange={(event) => update(key, event.target.value)} />
        ))}
      </div>
      <textarea aria-label={t.priceParameters} className="min-h-28 w-full rounded border border-border bg-bg p-3 font-mono text-sm" value={draft.parameters} onChange={(event) => update("parameters", event.target.value)} />
      <textarea aria-label={t.priceComponents} className="min-h-28 w-full rounded border border-border bg-bg p-3 font-mono text-sm" value={draft.components} onChange={(event) => update("components", event.target.value)} />
      <Input value={draft.reason} placeholder={t.mutationReason} onChange={(event) => update("reason", event.target.value)} />
      <Button disabled={mutation.busy || !draft.reason} onClick={() => {
        try {
          void mutation.run({
            operation: "price_version_create",
            profileVersionId: text(row, "profileVersionId"),
            pricingLane: first ? draft.pricingLane : text(row, "pricingLane"),
            expectedLatestVersion: first ? "0" : revision(row, "latestVersion"),
            currency: draft.currency,
            calculatorKind: draft.calculatorKind as "linear_token_v1" | "openai_gpt56_v1",
            validFrom: draft.validFrom,
            validTo: draft.validTo || null,
            providerEffectiveFrom: draft.providerEffectiveFrom || null,
            providerEffectiveTo: draft.providerEffectiveTo || null,
            sourceUrl: draft.sourceUrl,
            sourceCheckedAt: draft.sourceCheckedAt,
            sourceSnapshotSha256: draft.sourceSnapshotSha256,
            parameters: JSON.parse(draft.parameters) as Record<string, unknown>,
            components: JSON.parse(draft.components) as Record<string, unknown>,
            reason: draft.reason,
          });
        } catch {
          mutation.reject(t.invalid);
        }
      }}>{t.createSuccessor}</Button>
      <Result {...mutation} t={t} />
    </Panel>
    {!first && <PriceLifecycle {...props} />}
    </div>
  );
}

export function PolicyAction({ first = false, ...props }: CommonProps & { first?: boolean }) {
  const { row, accessToken, draftsEnabled, onRefresh, t } = props;
  const mutation = useAdminMutation(accessToken, t, onRefresh);
  const [rules, setRules] = useState(() => routingDraft(row.rules, first));
  let serialized: ReturnType<typeof serializeRoutingDraft> | null = null;
  try { if (rules) serialized = serializeRoutingDraft(rules); } catch { /* Incomplete form remains editable. */ }
  const [draft, setDraft] = useState({
    policyKey: text(row, "policyKey"),
    legalBundleVersion: text(row, "legalBundleVersion"),
    runtimeContractId: text(row, "runtimeContractId"),
    reason: "",
  });
  const update = (key: keyof typeof draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    mutation.changed();
  };
  return (
    <div className="space-y-4">
    <Panel title={t.createSuccessor} writesEnabled={draftsEnabled} t={t}>
      {first && <Input aria-label={t.policyKey} value={draft.policyKey} onChange={event => update("policyKey", event.target.value)} />}
      <RoutingRulesForm value={rules} onChange={value => { setRules(value); mutation.changed(); }} accessToken={accessToken} t={t} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input value={draft.legalBundleVersion} placeholder={t.legalBundle} onChange={(event) => update("legalBundleVersion", event.target.value)} />
        <AuthoringSelect accessToken={accessToken} kind="runtime_contracts" value={draft.runtimeContractId} label={t.runtimeContract} onChange={id => update("runtimeContractId", id)} t={t} />
      </div>
      <Input value={draft.reason} placeholder={t.mutationReason} onChange={(event) => update("reason", event.target.value)} />
      <Button disabled={mutation.busy || !draft.reason || !serialized} onClick={() => {
        try {
          void mutation.run({
            operation: "routing_policy_draft_create",
            policyKey: first ? draft.policyKey : text(row, "policyKey"),
            expectedLatestVersion: first ? "0" : revision(row, "latestVersion"),
            rules: { ...serialized! },
            defaultProfileVersionId: serialized!.defaultRoute.profileVersionId,
            legalBundleVersion: draft.legalBundleVersion,
            runtimeContractId: draft.runtimeContractId,
            reason: draft.reason,
          });
        } catch {
          mutation.reject(t.invalid);
        }
      }}>{t.createSuccessor}</Button>
      <Result {...mutation} t={t} />
    </Panel>
    {!first && <PolicyLifecycle {...props} />}
    </div>
  );
}

function ProfileLifecycle(props: CommonProps) {
  const { row, accessToken, writesEnabled, onRefresh, t } = props;
  const transition = useAdminMutation(accessToken, t, onRefresh);
  const retireVersion = useAdminMutation(accessToken, t, onRefresh);
  const retireProfile = useAdminMutation(accessToken, t, onRefresh);
  const [draft, setDraft] = useState({
    toStatus: "validated" as "validated" | "canary" | "active",
    validationReportId: "",
    reason: "",
    confirmation: "",
  });
  const [versionRetire, setVersionRetire] = useState({ validationReportId: "", reason: "", confirmation: "" });
  const [profileRetire, setProfileRetire] = useState({ validationReportId: "", reason: "", confirmation: "" });
  const versionId = text(row, "id");
  const profileId = text(row, "profileId");
  const changeTransition = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    transition.changed();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={t.transitionStatus} writesEnabled={writesEnabled} t={t}>
        <select aria-label={t.destinationStatus} className="w-full rounded border border-border bg-bg px-3 py-2 text-sm" value={draft.toStatus} onChange={(event) => changeTransition("toStatus", event.target.value as typeof draft.toStatus)}>
          {(["validated", "canary", "active"] as const).map((status) => <option key={status}>{status}</option>)}
        </select>
        <Input aria-label={t.validationReport} value={draft.validationReportId} placeholder={t.validationReport} onChange={(event) => changeTransition("validationReportId", event.target.value)} />
        <p className="text-xs text-foreground-muted">{t.confirmRecord}: <strong className="break-all">{versionId}</strong></p>
        <Input aria-label={t.confirmation} value={draft.confirmation} placeholder={t.confirmation} onChange={(event) => changeTransition("confirmation", event.target.value)} />
        <Input aria-label={t.mutationReason} value={draft.reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => changeTransition("reason", event.target.value)} />
        <Button disabled={transition.busy || !draft.reason || draft.confirmation !== versionId} onClick={() => void transition.run({ operation: "profile_version_transition", profileVersionId: versionId, toStatus: draft.toStatus, validationReportId: draft.validationReportId, reason: draft.reason })}>{t.transitionStatus}</Button>
        <Result {...transition} t={t} />
      </Panel>
      <Panel title={t.retireVersion} writesEnabled={writesEnabled} t={t}>
        <Input aria-label={t.validationReport} value={versionRetire.validationReportId} placeholder={t.validationReport} onChange={(event) => { setVersionRetire({ ...versionRetire, validationReportId: event.target.value }); retireVersion.changed(); }} />
        <p className="text-xs text-foreground-muted">{t.confirmRecord}: <strong className="break-all">{versionId}</strong></p>
        <Input aria-label={t.confirmation} value={versionRetire.confirmation} placeholder={t.confirmation} onChange={(event) => { setVersionRetire({ ...versionRetire, confirmation: event.target.value }); retireVersion.changed(); }} />
        <Input aria-label={t.mutationReason} value={versionRetire.reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => { setVersionRetire({ ...versionRetire, reason: event.target.value }); retireVersion.changed(); }} />
        <Button disabled={retireVersion.busy || !versionRetire.reason || versionRetire.confirmation !== versionId} onClick={() => void retireVersion.run({ operation: "profile_version_retire", profileVersionId: versionId, validationReportId: versionRetire.validationReportId, reason: versionRetire.reason })}>{t.retireVersion}</Button>
        <Result {...retireVersion} t={t} />
      </Panel>
      <Panel title={t.retireProfile} writesEnabled={writesEnabled} t={t}>
        <Input aria-label={t.validationReport} value={profileRetire.validationReportId} placeholder={t.validationReport} onChange={(event) => { setProfileRetire({ ...profileRetire, validationReportId: event.target.value }); retireProfile.changed(); }} />
        <p className="text-xs text-foreground-muted">{t.confirmRecord}: <strong className="break-all">{profileId}</strong></p>
        <Input aria-label={t.confirmation} value={profileRetire.confirmation} placeholder={t.confirmation} onChange={(event) => { setProfileRetire({ ...profileRetire, confirmation: event.target.value }); retireProfile.changed(); }} />
        <Input aria-label={t.mutationReason} value={profileRetire.reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => { setProfileRetire({ ...profileRetire, reason: event.target.value }); retireProfile.changed(); }} />
        <Button disabled={retireProfile.busy || !profileRetire.reason || profileRetire.confirmation !== profileId} onClick={() => void retireProfile.run({ operation: "provider_profile_retire", profileId, validationReportId: profileRetire.validationReportId, reason: profileRetire.reason })}>{t.retireProfile}</Button>
        <Result {...retireProfile} t={t} />
      </Panel>
    </div>
  );
}

function PriceLifecycle(props: CommonProps) {
  const { row, accessToken, writesEnabled, onRefresh, t } = props;
  const seal = useAdminMutation(accessToken, t, onRefresh);
  const close = useAdminMutation(accessToken, t, onRefresh);
  const priceId = text(row, "id");
  const [sealDraft, setSealDraft] = useState({ runtimeContractId: "", reason: "", confirmation: "" });
  const [closeDraft, setCloseDraft] = useState({ validTo: new Date().toISOString(), successorPriceVersionId: "", validationReportId: "", reason: "", confirmation: "" });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={t.sealPrice} writesEnabled={writesEnabled} t={t}>
        <Input aria-label={t.runtimeContract} value={sealDraft.runtimeContractId} placeholder={t.runtimeContract} onChange={(event) => { setSealDraft({ ...sealDraft, runtimeContractId: event.target.value }); seal.changed(); }} />
        <p className="text-xs text-foreground-muted">{t.confirmRecord}: <strong className="break-all">{priceId}</strong></p>
        <Input aria-label={t.confirmation} value={sealDraft.confirmation} placeholder={t.confirmation} onChange={(event) => { setSealDraft({ ...sealDraft, confirmation: event.target.value }); seal.changed(); }} />
        <Input aria-label={t.mutationReason} value={sealDraft.reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => { setSealDraft({ ...sealDraft, reason: event.target.value }); seal.changed(); }} />
        <Button disabled={seal.busy || !sealDraft.reason || sealDraft.confirmation !== priceId} onClick={() => void seal.run({ operation: "price_seal", priceVersionId: priceId, runtimeContractId: sealDraft.runtimeContractId, reason: sealDraft.reason })}>{t.sealPrice}</Button>
        <Result {...seal} t={t} />
      </Panel>
      <Panel title={t.closePrice} writesEnabled={writesEnabled} t={t}>
        <Input aria-label={t.validTo} value={closeDraft.validTo} placeholder={t.validTo} onChange={(event) => { setCloseDraft({ ...closeDraft, validTo: event.target.value }); close.changed(); }} />
        <Input aria-label={t.successorPrice} value={closeDraft.successorPriceVersionId} placeholder={t.successorPrice} onChange={(event) => { setCloseDraft({ ...closeDraft, successorPriceVersionId: event.target.value }); close.changed(); }} />
        <Input aria-label={t.validationReport} value={closeDraft.validationReportId} placeholder={t.validationReport} onChange={(event) => { setCloseDraft({ ...closeDraft, validationReportId: event.target.value }); close.changed(); }} />
        <p className="text-xs text-foreground-muted">{t.confirmRecord}: <strong className="break-all">{priceId}</strong></p>
        <Input aria-label={t.confirmation} value={closeDraft.confirmation} placeholder={t.confirmation} onChange={(event) => { setCloseDraft({ ...closeDraft, confirmation: event.target.value }); close.changed(); }} />
        <Input aria-label={t.mutationReason} value={closeDraft.reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => { setCloseDraft({ ...closeDraft, reason: event.target.value }); close.changed(); }} />
        <Button disabled={close.busy || !closeDraft.reason || closeDraft.confirmation !== priceId} onClick={() => void close.run({ operation: "price_close", priceVersionId: priceId, validTo: closeDraft.validTo, successorPriceVersionId: closeDraft.successorPriceVersionId || null, validationReportId: closeDraft.validationReportId, reason: closeDraft.reason })}>{t.closePrice}</Button>
        <Result {...close} t={t} />
      </Panel>
    </div>
  );
}

function PolicyLifecycle(props: CommonProps) {
  const { row, accessToken, writesEnabled, onRefresh, t } = props;
  const mutation = useAdminMutation(accessToken, t, onRefresh);
  const policyId = text(row, "id");
  const [draft, setDraft] = useState({ toStatus: "validated" as "validated" | "canary" | "active" | "retired", validationReportIds: "", reason: "", confirmation: "" });
  const update = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    mutation.changed();
  };
  return (
    <Panel title={t.transitionStatus} writesEnabled={writesEnabled} t={t}>
      <select aria-label={t.destinationStatus} className="w-full rounded border border-border bg-bg px-3 py-2 text-sm" value={draft.toStatus} onChange={(event) => update("toStatus", event.target.value as typeof draft.toStatus)}>
        {(["validated", "canary", "active", "retired"] as const).map((status) => <option key={status}>{status}</option>)}
      </select>
      <Input aria-label={t.validationReports} value={draft.validationReportIds} placeholder={t.validationReports} onChange={(event) => update("validationReportIds", event.target.value)} />
      <p className="text-xs text-foreground-muted">{t.confirmRecord}: <strong className="break-all">{policyId}</strong></p>
      <Input aria-label={t.confirmation} value={draft.confirmation} placeholder={t.confirmation} onChange={(event) => update("confirmation", event.target.value)} />
      <Input aria-label={t.mutationReason} value={draft.reason} maxLength={500} placeholder={t.mutationReason} onChange={(event) => update("reason", event.target.value)} />
      <Button disabled={mutation.busy || !draft.reason || draft.confirmation !== policyId} onClick={() => void mutation.run({ operation: "routing_policy_transition", policyVersionId: policyId, toStatus: draft.toStatus, validationReportIds: parseIds(draft.validationReportIds), reason: draft.reason })}>{t.transitionStatus}</Button>
      <Result {...mutation} t={t} />
    </Panel>
  );
}

export type CommonProps = {
  draftsEnabled: boolean;
  row: Row;
  accessToken: string;
  writesEnabled: boolean;
  onRefresh: () => void;
  t: AdminMessages;
};
export function AdminRecordActions({
  section,
  ...props
}: CommonProps & { section: AdminRecordSection }) {
  if (section === "users") return <UserAction {...props} />;
  if (section === "providers") return <ProviderActions {...props} />;
  if (section === "profiles") return <ProfileAction {...props} />;
  if (section === "prices") return <PriceAction {...props} />;
  if (section === "policies") return <PolicyAction {...props} />;
  return null;
}
