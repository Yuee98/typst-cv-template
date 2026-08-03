"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFormContext, useWatch, type FieldPath } from "react-hook-form";

import { Button } from "@/components/ui/button";
import type { CvData } from "@/lib/cv/schema";

import { isPolishEntryVisible } from "./polish-entry";
import { usePolishEntry } from "./polish-entry-context";
import { isPolishableText, type PolishScope } from "./scope-builder";

/**
 * The shared Sparkles ghost icon button for every polish entry point
 * (roadmap「入口」: 共用 Sparkles ghost 图标按钮). Purely declarative: the
 * caller states the scope, this component enforces the two gates
 * (deployment flag + capability matrix) and forwards clicks to the wiring
 * via the entry context. It renders NOTHING when the flag is off, the
 * section/granularity pair is not in the capability matrix (publications,
 * profile section-level, …), or the provider is absent.
 */
export function PolishEntryButton({
  scope,
  disabled,
  disabledTitle,
}: {
  scope: PolishScope;
  disabled?: boolean;
  /** Tooltip shown instead of the label while disabled (e.g. the too-short hint). */
  disabledTitle?: string;
}) {
  const t = useTranslations("PolishEntry");
  const entry = usePolishEntry();

  if (!isPolishEntryVisible(scope.sectionId, scope.granularity)) return null;
  if (!entry) return null;

  const label = t(scope.granularity);
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      {...(disabled ? { disabled: true } : { title: label })}
      onClick={() => entry.requestPolish(scope)}
    >
      <Sparkles />
    </Button>
  );
  // Disabled buttons emit no mouse events, so the tooltip needs a wrapper.
  return disabled ? <span title={disabledTitle ?? label}>{button}</span> : button;
}

/**
 * Single-item entry button (item granularity). Watches the item's text
 * field and disables itself while the text fails isPolishableText (blank or
 * < 10 chars) — the same rule the scope builder applies to aggregate scopes
 * (roadmap: 单条禁用规则与聚合规则同源). Aggregate scopes stay always
 * clickable; their filtering is handled inside the dialog.
 */
export function PolishItemEntryButton({
  textPath,
  scope,
}: {
  /** RHF path of the item's text field (e.g. "experience.0.projects.1.bullets.2.body"). */
  textPath: string;
  scope: PolishScope;
}) {
  const t = useTranslations("PolishEntry");
  const { control } = useFormContext<CvData>();
  const text = useWatch({ control, name: textPath as FieldPath<CvData> });
  const polishable = isPolishableText(typeof text === "string" ? text : "");

  return (
    <PolishEntryButton
      scope={scope}
      disabled={!polishable}
      disabledTitle={t("tooShort")}
    />
  );
}
