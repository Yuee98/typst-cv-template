"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import {
  MAX_STYLE_INSTRUCTION_CHARS,
  POLISH_CONTEXT_LEVELS,
  POLISH_STYLE_PRESETS,
  type PolishContextLevel,
} from "@/lib/polish/contract";
import { cn } from "@/lib/utils";

import type { PolishDisclosure } from "./scope-builder";
import type { PolishFlow } from "./use-polish-flow";

/**
 * Phase 1 (config/confirm): disclosure of exactly what will be sent, the
 * fixed privacy reminder (+ the prominent E2EE plaintext warning), remaining
 * quota, context level, style preset/custom instruction, and the AI terms
 * checkbox. Fires NO request — that only happens on confirm.
 */
export function PolishConfigPhase({ flow }: { flow: PolishFlow }) {
  const t = useTranslations("PolishDialog");
  const { state, scopeFailure } = flow;
  const disclosure = state.snapshot?.disclosure ?? null;

  return (
    <div className="space-y-4">
      {!flow.signedIn && (
        <div className="rounded-md border border-border bg-surface-hover px-3 py-2 text-sm text-foreground-muted">
          {t("signInRequired")}
        </div>
      )}

      {flow.configChangedHint && (
        <div
          role="status"
          className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-foreground"
        >
          {t("configChanged")}
        </div>
      )}

      {scopeFailure !== null ? (
        <div className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground">
          {t(`scopeFailures.${scopeFailure}`)}
        </div>
      ) : (
        disclosure && <DisclosureSummary disclosure={disclosure} />
      )}

      {/* Fixed privacy reminder; the E2EE variant gets warning-level styling
          (roadmap 信息区与提醒文案, Invariant 10). */}
      <div className="rounded-md border border-border bg-surface-hover px-3 py-2 text-xs leading-5 text-foreground-muted">
        {t("privacyReminder")}
      </div>
      {flow.encrypted && (
        <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm leading-5 text-warning-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{t("e2eeWarning")}</p>
        </div>
      )}

      <QuotaLine flow={flow} />
      <LevelSelector flow={flow} />
      <StyleSelector flow={flow} />
      <TermsRow flow={flow} />
    </div>
  );
}

function DisclosureSummary({ disclosure }: { disclosure: PolishDisclosure }) {
  const t = useTranslations("PolishDialog");
  return (
    <details className="group rounded-md border border-border">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm text-foreground">
        <span className="font-medium">{t("disclosure.heading")}</span>{" "}
        <span className="text-foreground-muted">
          {t("disclosure.summary", {
            targetCount: disclosure.targets.length,
            targetChars: disclosure.totalTargetChars,
            referenceCount: disclosure.references.length,
            referenceChars: disclosure.totalReferenceChars,
          })}
        </span>
        <span className="float-right text-xs text-foreground-subtle group-open:hidden">
          {t("disclosure.expand")}
        </span>
        <span className="float-right hidden text-xs text-foreground-subtle group-open:inline">
          {t("disclosure.collapse")}
        </span>
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-2">
        <DisclosureList heading={t("disclosure.targetsHeading")}>
          {disclosure.targets.map((target) => (
            <li key={target.id} className="whitespace-pre-wrap break-words">
              {target.text}
            </li>
          ))}
        </DisclosureList>
        {disclosure.references.length > 0 && (
          <DisclosureList heading={t("disclosure.referencesHeading")}>
            {disclosure.references.map((reference, index) => (
              <li key={index} className="whitespace-pre-wrap break-words">
                <span className="text-foreground-subtle">
                  [{reference.label ?? t(`disclosure.roles.${reference.role}`)}]
                </span>{" "}
                {reference.text}
              </li>
            ))}
          </DisclosureList>
        )}
        {(disclosure.stylePreset || disclosure.styleInstruction) && (
          <div className="text-xs text-foreground-muted">
            {disclosure.stylePreset &&
              t("disclosure.stylePreset", {
                preset: t(`style.presets.${disclosure.stylePreset}`),
              })}
            {disclosure.styleInstruction &&
              t("disclosure.styleInstruction", { instruction: disclosure.styleInstruction })}
          </div>
        )}
      </div>
    </details>
  );
}

function DisclosureList({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
        {heading}
      </div>
      <ul className="mt-1 max-h-32 list-disc space-y-1 overflow-y-auto pl-5 text-sm leading-5 text-foreground-muted">
        {children}
      </ul>
    </div>
  );
}

function QuotaLine({ flow }: { flow: PolishFlow }) {
  const t = useTranslations("PolishDialog");
  if (!flow.signedIn) return null;
  if (flow.quotaStatus === "loading" || flow.quotaStatus === "idle") {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("quota.loading")}
      </div>
    );
  }
  if (flow.quotaStatus === "error") {
    return (
      <div className="flex items-center gap-2 text-sm text-danger-foreground">
        {t("quota.error")}
        <Button type="button" variant="ghost" size="sm" onClick={flow.quotaRetry}>
          {t("quota.retry")}
        </Button>
      </div>
    );
  }
  if (!flow.quota) return null;
  return (
    <div className="text-sm text-foreground-muted">
      {t("quota.remaining", { remaining: flow.quota.remaining, limit: flow.quota.limit })}
    </div>
  );
}

function LevelSelector({ flow }: { flow: PolishFlow }) {
  const t = useTranslations("PolishDialog");
  const level = flow.state.params.level;
  // Terms acceptance in flight: the reviewed disclosure is frozen, so the
  // config controls lock until it settles (the hook kills the continuation
  // on any change regardless — this keeps the UI honest about it).
  const locked = flow.terms.status === "accepting";
  return (
    <fieldset className="space-y-1.5" disabled={locked}>
      <legend className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
        {t("level.heading")}
      </legend>
      <div className="space-y-1" role="radiogroup">
        {POLISH_CONTEXT_LEVELS.map((value) => (
          <label
            key={value}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm",
              level === value
                ? "border-accent-border bg-accent-soft"
                : "border-border hover:bg-surface-hover",
              locked && "pointer-events-none opacity-60",
            )}
          >
            <input
              type="radio"
              name="polish-context-level"
              className="mt-1 size-3.5"
              checked={level === value}
              disabled={locked}
              onChange={() => flow.setLevel(value as PolishContextLevel)}
            />
            <span>
              <span className="block font-medium text-foreground">{t(`level.l${value}`)}</span>
              <span className="block text-xs leading-5 text-foreground-muted">
                {t(`level.l${value}Description`)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StyleSelector({ flow }: { flow: PolishFlow }) {
  const t = useTranslations("PolishDialog");
  const params = flow.state.params;
  const instruction = params.styleInstruction ?? "";
  // Locked during terms acceptance — see LevelSelector.
  const locked = flow.terms.status === "accepting";
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
        {t("style.heading")}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {POLISH_STYLE_PRESETS.map((preset) => {
          const selected = params.stylePreset === preset;
          return (
            <button
              key={preset}
              type="button"
              aria-pressed={selected}
              disabled={locked}
              onClick={() => flow.setStylePreset(selected ? undefined : preset)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                selected
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border bg-surface text-foreground-muted hover:bg-surface-hover",
              )}
            >
              {t(`style.presets.${preset}`)}
            </button>
          );
        })}
      </div>
      <div className="space-y-1">
        <textarea
          value={instruction}
          maxLength={MAX_STYLE_INSTRUCTION_CHARS}
          rows={2}
          disabled={locked}
          onChange={(event) => flow.setStyleInstruction(event.target.value)}
          placeholder={t("style.customPlaceholder")}
          aria-label={t("style.heading")}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="text-right text-xs text-foreground-subtle">
          {t("style.counter", { count: instruction.length, max: MAX_STYLE_INSTRUCTION_CHARS })}
        </div>
      </div>
    </div>
  );
}

function TermsRow({ flow }: { flow: PolishFlow }) {
  const t = useTranslations("PolishDialog");
  const { terms } = flow;
  if (!flow.signedIn || terms.status === "accepted" || terms.status === "unknown") {
    return null;
  }
  if (terms.status === "checking") {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("terms.checking")}
      </div>
    );
  }
  if (terms.status === "error") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground">
        {t("terms.error")}
        <Button type="button" variant="ghost" size="sm" onClick={flow.refreshTerms}>
          {t("terms.retry")}
        </Button>
      </div>
    );
  }
  // required | accepting — the progressive consent checkbox (roadmap).
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        terms.serverRejected
          ? "border-danger-border bg-danger-soft"
          : "border-border bg-surface-hover",
      )}
    >
      <label className="flex items-start gap-2 text-sm leading-5 text-foreground-muted">
        <input
          type="checkbox"
          className="mt-1 size-4 rounded border-border-strong"
          checked={terms.checked}
          disabled={terms.status === "accepting"}
          onChange={(event) => terms.setChecked(event.target.checked)}
        />
        <span>
          {t("terms.agreePrefix")}{" "}
          <Link
            className="font-medium text-accent-soft-foreground hover:text-accent"
            href="/ai-terms"
            target="_blank"
            rel="noreferrer"
          >
            {t("terms.aiTerms")}
          </Link>
          .
        </span>
      </label>
      {terms.serverRejected && (
        <p className="mt-1 text-xs text-danger-foreground">{t("terms.required")}</p>
      )}
      {terms.status === "accepting" && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-foreground-muted">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {t("terms.accepting")}
        </p>
      )}
    </div>
  );
}
