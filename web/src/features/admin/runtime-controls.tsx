"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  adminCommittedOperationSchema,
  adminErrorSchema,
  adminRuntimeReadbackSchema,
  adminValidationReportSchema,
  type AdminControlState,
  type AdminMutationRequest,
  type AdminRuntimeReadback,
  type AdminValidationReport,
} from "@/lib/admin/contract";
import type { AdminMessages } from "./messages";

type MutationPayload = AdminMutationRequest extends infer Request
  ? Request extends { idempotencyKey: string }
    ? Omit<Request, "idempotencyKey">
    : never
  : never;

function ids(value: string) {
  return value.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean);
}

function messageFor(code: string, t: AdminMessages) {
  if (code === "STEP_UP_REQUIRED") return t.stepUpRequired;
  if (code === "NOT_READY") return t.noConfiguration;
  if (code === "CONFLICT") return t.invalid;
  if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return t.noAccess;
  return t.loadFailed;
}

function useMutation(
  accessToken: string,
  t: AdminMessages,
  onCommitted: () => void,
) {
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<{
    operationId: string;
    auditId: string;
  } | null>(null);
  function changed() {
    setIdempotencyKey(crypto.randomUUID());
    setCommitted(null);
    setError(null);
  }
  async function run(payload: MutationPayload) {
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
        body: JSON.stringify({ ...payload, idempotencyKey }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const parsed = adminErrorSchema.safeParse(raw);
        setError(messageFor(parsed.success ? parsed.data.error.code : "", t));
        return;
      }
      const parsed = adminCommittedOperationSchema.safeParse(raw);
      if (!parsed.success) {
        setError(t.schemaError);
        return;
      }
      setCommitted({
        operationId: parsed.data.operationId,
        auditId: parsed.data.auditId,
      });
      onCommitted();
    } catch {
      // The same key is deliberately retained for an unknown-result retry.
      setError(t.retryOriginal);
    } finally {
      setBusy(false);
    }
  }
  return { busy, changed, committed, error, run };
}

function Result({
  committed,
  error,
  t,
}: {
  committed: { operationId: string; auditId: string } | null;
  error: string | null;
  t: AdminMessages;
}) {
  return (
    <>
      {error && <p className="text-sm text-danger-foreground">{error}</p>}
      {committed && (
        <div className="rounded border border-border bg-background p-3 text-xs">
          <p className="font-medium">{t.mutationCommitted}</p>
          <p className="mt-1 break-all">{t.operationId}: {committed.operationId}</p>
          <p className="mt-1 break-all">{t.auditId}: {committed.auditId}</p>
        </div>
      )}
    </>
  );
}

function Panel({
  title,
  disabled,
  children,
}: {
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-border bg-surface p-4 disabled:opacity-60">
      <legend className="px-1 font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function ControlStateView({
  state,
  locale,
  t,
}: {
  state: AdminControlState;
  locale: string;
  t: AdminMessages;
}) {
  const values = [
    [t.aiEnabled, state.aiEnabled ? t.enabled : t.disabled],
    [t.activePolicy, state.activePolicyVersionId ?? "—"],
    [t.controlRevision, state.controlRevision],
    [t.configRevision, state.configGeneration],
    [t.closingCycle, state.closingCycleId ?? "—"],
    [t.closedAt, state.closedAt ? new Date(state.closedAt).toLocaleString(locale) : "—"],
    [t.reopenedAt, state.reopenedAt ? new Date(state.reopenedAt).toLocaleString(locale) : "—"],
    [t.callsDay, String(state.globalDailyLimit)],
  ];
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="font-semibold">{t.controlState}</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {values.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-foreground-muted">{label}</dt>
            <dd className="mt-1 break-all text-sm">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ValidationPanel({
  accessToken,
  writesEnabled,
  t,
}: {
  accessToken: string;
  writesEnabled: boolean;
  t: AdminMessages;
}) {
  const [draft, setDraft] = useState({
    reviewedDeploymentId: "",
    runtimeContractId: "",
    runtimeTargetId: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AdminValidationReport | null>(null);
  const update = (key: keyof typeof draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
    setReport(null);
  };
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "validate_runtime_target", ...draft }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const parsed = adminErrorSchema.safeParse(raw);
        setError(messageFor(parsed.success ? parsed.data.error.code : "", t));
        return;
      }
      const parsed = adminValidationReportSchema.safeParse(raw);
      if (!parsed.success) setError(t.schemaError);
      else setReport(parsed.data);
    } catch {
      setError(t.loadFailed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={t.validationReports} disabled={!writesEnabled}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input aria-label={t.reviewedDeployment} value={draft.reviewedDeploymentId} placeholder={t.reviewedDeployment} onChange={(event) => update("reviewedDeploymentId", event.target.value)} />
        <Input aria-label={t.runtimeContract} value={draft.runtimeContractId} placeholder={t.runtimeContract} onChange={(event) => update("runtimeContractId", event.target.value)} />
        <Input aria-label={t.targetId} value={draft.runtimeTargetId} placeholder={t.targetId} onChange={(event) => update("runtimeTargetId", event.target.value)} />
      </div>
      <Button disabled={busy || Object.values(draft).some((value) => !value)} onClick={() => void run()}>{t.apply}</Button>
      {error && <p className="text-sm text-danger-foreground">{error}</p>}
      {report && (
        <div className="rounded border border-border bg-background p-3 text-xs">
          <p className="font-medium">{report.passed ? t.complete : t.incomplete}</p>
          <p className="mt-1 break-all">{t.readbackReport}: {report.reportId}</p>
          {Object.entries(report.checks).map(([key, value]) => <p key={key}>{key}: {value ? t.yes : t.no}</p>)}
          <p className="mt-1">{t.reportExpires}: {report.expiresAt}</p>
        </div>
      )}
    </Panel>
  );
}

export function AdminRuntimeControls({
  state,
  environment,
  locale,
  accessToken,
  writesEnabled,
  onRefresh,
  t,
}: {
  state: AdminControlState;
  environment: string;
  locale: string;
  accessToken: string;
  writesEnabled: boolean;
  onRefresh: () => void;
  t: AdminMessages;
}) {
  const limit = useMutation(accessToken, t, onRefresh);
  const disable = useMutation(accessToken, t, onRefresh);
  const pointer = useMutation(accessToken, t, onRefresh);
  const clear = useMutation(accessToken, t, onRefresh);
  const reopen = useMutation(accessToken, t, onRefresh);
  const [limitDraft, setLimitDraft] = useState({ value: String(state.globalDailyLimit), reason: "" });
  const [disableDraft, setDisableDraft] = useState({ confirmation: "", reason: "" });
  const [pointerDraft, setPointerDraft] = useState({ policyVersionId: state.activePolicyVersionId ?? "", validationReportIds: "", confirmation: "", reason: "" });
  const [clearDraft, setClearDraft] = useState({ validationReportIds: "", confirmation: "", reason: "" });
  const [readbackDraft, setReadbackDraft] = useState({
    reviewedDeploymentId: "",
    admissionId: "",
    admissionRevision: "",
    targetSetSha256: "",
    validationReportIds: "",
  });
  const [readback, setReadback] = useState<AdminRuntimeReadback | null>(null);
  const [readbackBusy, setReadbackBusy] = useState(false);
  const [readbackError, setReadbackError] = useState<string | null>(null);
  const [reopenDraft, setReopenDraft] = useState({ readbackReportId: "", confirmation: "", reason: "" });
  const enabled = writesEnabled && state.writesEnabled;

  async function recordReadback() {
    if (!state.activePolicyVersionId) return;
    setReadbackBusy(true);
    setReadbackError(null);
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "record_runtime_readback",
          reviewedDeploymentId: readbackDraft.reviewedDeploymentId,
          admissionId: readbackDraft.admissionId,
          admissionRevision: readbackDraft.admissionRevision,
          targetSetSha256: readbackDraft.targetSetSha256,
          policyVersionId: state.activePolicyVersionId,
          validationReportIds: ids(readbackDraft.validationReportIds),
        }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const parsed = adminErrorSchema.safeParse(raw);
        setReadbackError(messageFor(parsed.success ? parsed.data.error.code : "", t));
        return;
      }
      const parsed = adminRuntimeReadbackSchema.safeParse(raw);
      if (!parsed.success) {
        setReadbackError(t.schemaError);
        return;
      }
      setReadback(parsed.data);
      setReopenDraft((current) => ({ ...current, readbackReportId: parsed.data.reportId }));
    } catch {
      setReadbackError(t.retryOriginal);
    } finally {
      setReadbackBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t.controls}</h1>
          <p className="mt-1 text-sm text-foreground-muted">{t.operationHelp}</p>
        </div>
        <Button variant="secondary" onClick={onRefresh}>{t.refreshState}</Button>
      </div>
      <ControlStateView state={state} locale={locale} t={t} />
      {!enabled && <p className="rounded border border-border bg-surface p-3 text-sm text-foreground-muted">{t.writesUnavailable}</p>}
      <ValidationPanel accessToken={accessToken} writesEnabled={enabled} t={t} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t.setDailyLimit} disabled={!enabled}>
          <Input aria-label={t.callsDay} type="number" min={0} value={limitDraft.value} onChange={(event) => { setLimitDraft({ ...limitDraft, value: event.target.value }); limit.changed(); }} />
          <Input aria-label={t.mutationReason} maxLength={500} value={limitDraft.reason} placeholder={t.mutationReason} onChange={(event) => { setLimitDraft({ ...limitDraft, reason: event.target.value }); limit.changed(); }} />
          <Button disabled={limit.busy || !limitDraft.reason} onClick={() => void limit.run({ operation: "global_daily_limit_set", globalDailyLimit: Number(limitDraft.value), expectedGlobalDailyLimit: state.globalDailyLimit, expectedControlRevision: state.controlRevision, reason: limitDraft.reason })}>{t.setDailyLimit}</Button>
          <Result {...limit} t={t} />
        </Panel>
        <Panel title={t.disableAi} disabled={!enabled || !state.aiEnabled}>
          <p className="text-xs text-foreground-muted">{t.confirmEnvironment}: <strong>{environment}</strong></p>
          <Input aria-label={t.confirmation} value={disableDraft.confirmation} placeholder={t.confirmation} onChange={(event) => { setDisableDraft({ ...disableDraft, confirmation: event.target.value }); disable.changed(); }} />
          <Input aria-label={t.mutationReason} maxLength={500} value={disableDraft.reason} placeholder={t.mutationReason} onChange={(event) => { setDisableDraft({ ...disableDraft, reason: event.target.value }); disable.changed(); }} />
          <Button disabled={disable.busy || !disableDraft.reason || disableDraft.confirmation !== environment} onClick={() => void disable.run({ operation: "disable_ai", expectedControlRevision: state.controlRevision, reason: disableDraft.reason })}>{t.disableAi}</Button>
          <Result {...disable} t={t} />
        </Panel>
        <Panel title={t.setPointer} disabled={!enabled || state.aiEnabled}>
          <Input aria-label={t.activePolicy} value={pointerDraft.policyVersionId} placeholder={t.activePolicy} onChange={(event) => { setPointerDraft({ ...pointerDraft, policyVersionId: event.target.value }); pointer.changed(); }} />
          <Input aria-label={t.validationReports} value={pointerDraft.validationReportIds} placeholder={t.validationReports} onChange={(event) => { setPointerDraft({ ...pointerDraft, validationReportIds: event.target.value }); pointer.changed(); }} />
          <p className="text-xs text-foreground-muted">{t.confirmPolicy}: <strong className="break-all">{pointerDraft.policyVersionId || "—"}</strong></p>
          <Input aria-label={t.confirmation} value={pointerDraft.confirmation} placeholder={t.confirmation} onChange={(event) => { setPointerDraft({ ...pointerDraft, confirmation: event.target.value }); pointer.changed(); }} />
          <Input aria-label={t.mutationReason} maxLength={500} value={pointerDraft.reason} placeholder={t.mutationReason} onChange={(event) => { setPointerDraft({ ...pointerDraft, reason: event.target.value }); pointer.changed(); }} />
          <Button disabled={pointer.busy || !pointerDraft.reason || !pointerDraft.policyVersionId || pointerDraft.confirmation !== pointerDraft.policyVersionId} onClick={() => void pointer.run({ operation: "pointer_set", policyVersionId: pointerDraft.policyVersionId, validationReportIds: ids(pointerDraft.validationReportIds), expectedControlRevision: state.controlRevision, expectedPolicyVersionId: state.activePolicyVersionId, expectedConfigGeneration: state.configGeneration, reason: pointerDraft.reason })}>{t.setPointer}</Button>
          <Result {...pointer} t={t} />
        </Panel>
        <Panel title={t.clearPointer} disabled={!enabled || state.aiEnabled || !state.activePolicyVersionId}>
          <p className="text-xs text-foreground-muted">{t.confirmPolicy}: <strong className="break-all">{state.activePolicyVersionId ?? "—"}</strong></p>
          <Input aria-label={t.validationReports} value={clearDraft.validationReportIds} placeholder={t.validationReports} onChange={(event) => { setClearDraft({ ...clearDraft, validationReportIds: event.target.value }); clear.changed(); }} />
          <Input aria-label={t.confirmation} value={clearDraft.confirmation} placeholder={t.confirmation} onChange={(event) => { setClearDraft({ ...clearDraft, confirmation: event.target.value }); clear.changed(); }} />
          <Input aria-label={t.mutationReason} maxLength={500} value={clearDraft.reason} placeholder={t.mutationReason} onChange={(event) => { setClearDraft({ ...clearDraft, reason: event.target.value }); clear.changed(); }} />
          <Button disabled={clear.busy || !clearDraft.reason || clearDraft.confirmation !== state.activePolicyVersionId} onClick={() => state.activePolicyVersionId && void clear.run({ operation: "pointer_clear", validationReportIds: ids(clearDraft.validationReportIds), expectedControlRevision: state.controlRevision, expectedPolicyVersionId: state.activePolicyVersionId, expectedConfigGeneration: state.configGeneration, reason: clearDraft.reason })}>{t.clearPointer}</Button>
          <Result {...clear} t={t} />
        </Panel>
        <Panel title={t.recordReadback} disabled={!enabled || state.aiEnabled || !state.activePolicyVersionId}>
          <Input aria-label={t.reviewedDeployment} value={readbackDraft.reviewedDeploymentId} placeholder={t.reviewedDeployment} onChange={(event) => { setReadbackDraft({ ...readbackDraft, reviewedDeploymentId: event.target.value }); setReadback(null); setReadbackError(null); }} />
          <Input aria-label={t.admissionId} value={readbackDraft.admissionId} placeholder={t.admissionId} onChange={(event) => { setReadbackDraft({ ...readbackDraft, admissionId: event.target.value }); setReadback(null); setReadbackError(null); }} />
          <Input aria-label={t.admissionRevision} value={readbackDraft.admissionRevision} placeholder={t.admissionRevision} onChange={(event) => { setReadbackDraft({ ...readbackDraft, admissionRevision: event.target.value }); setReadback(null); setReadbackError(null); }} />
          <Input aria-label={t.targetSetSha256} value={readbackDraft.targetSetSha256} placeholder={t.targetSetSha256} onChange={(event) => { setReadbackDraft({ ...readbackDraft, targetSetSha256: event.target.value }); setReadback(null); setReadbackError(null); }} />
          <Input aria-label={t.validationReports} value={readbackDraft.validationReportIds} placeholder={t.validationReports} onChange={(event) => { setReadbackDraft({ ...readbackDraft, validationReportIds: event.target.value }); setReadback(null); setReadbackError(null); }} />
          <Button disabled={readbackBusy || Object.entries(readbackDraft).some(([key, value]) => key === "validationReportIds" ? ids(value).length === 0 : !value)} onClick={() => void recordReadback()}>{t.recordReadback}</Button>
          {readbackError && <p className="text-sm text-danger-foreground">{readbackError}</p>}
          {readback && <div className="rounded border border-border bg-background p-3 text-xs"><p className="font-medium">{t.readbackRecorded}</p><p className="mt-1 break-all">{t.readbackReport}: {readback.reportId}</p><p className="mt-1">{t.reportExpires}: {readback.expiresAt}</p><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap">{JSON.stringify(readback.effectiveRoutes, null, 2)}</pre></div>}
        </Panel>
        <Panel title={t.reopenAi} disabled={!enabled || state.aiEnabled || !state.closingCycleId}>
          <Input aria-label={t.readbackReport} value={reopenDraft.readbackReportId} placeholder={t.readbackReport} onChange={(event) => { setReopenDraft({ ...reopenDraft, readbackReportId: event.target.value }); reopen.changed(); }} />
          <p className="text-xs text-foreground-muted">{t.confirmEnvironment}: <strong>{environment}</strong></p>
          <Input aria-label={t.confirmation} value={reopenDraft.confirmation} placeholder={t.confirmation} onChange={(event) => { setReopenDraft({ ...reopenDraft, confirmation: event.target.value }); reopen.changed(); }} />
          <Input aria-label={t.mutationReason} maxLength={500} value={reopenDraft.reason} placeholder={t.mutationReason} onChange={(event) => { setReopenDraft({ ...reopenDraft, reason: event.target.value }); reopen.changed(); }} />
          <Button disabled={reopen.busy || !reopenDraft.reason || !reopenDraft.readbackReportId || reopenDraft.confirmation !== environment} onClick={() => state.closingCycleId && void reopen.run({ operation: "reopen", readbackReportId: reopenDraft.readbackReportId, expectedClosingCycleId: state.closingCycleId, expectedControlRevision: state.controlRevision, expectedPolicyVersionId: state.activePolicyVersionId, expectedConfigGeneration: state.configGeneration, reason: reopenDraft.reason })}>{t.reopenAi}</Button>
          <Result {...reopen} t={t} />
        </Panel>
      </div>
    </div>
  );
}
