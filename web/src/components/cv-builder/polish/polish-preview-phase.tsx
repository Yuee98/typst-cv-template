"use client";

import { Check, Undo2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import type { PolishLanguage } from "@/lib/polish/contract";
import { cn } from "@/lib/utils";

import { groupPolishItems, type PolishItemGroup } from "./group-polish-items";
import { countItems, type PolishItem } from "./polish-reducer";
import type { PolishFlow } from "./use-polish-flow";
import { diffWords } from "./word-diff";
import { WordDiffTokens } from "./word-diff-view";

/**
 * Phase 3 (preview): per-item review cards in a top/bottom comparison
 * layout (muted original above, polished below, changed words highlighted).
 * Section granularity groups cards by entry in an accordion; flatter scopes
 * render a plain list. Accept writes back immediately; undo is available
 * until the dialog closes (accepted values stay in the form either way).
 */
export function PolishPreviewPhase({
  flow,
  language,
}: {
  flow: PolishFlow;
  language: PolishLanguage;
}) {
  const t = useTranslations("PolishDialog");
  const { state, scope } = flow;
  const counts = countItems(state.items);
  const groups = useMemo(
    () => (scope ? groupPolishItems(state.items, scope.sectionId) : []),
    [scope, state.items],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-foreground-muted">
          {t("preview.counts", counts)}
        </span>
        <span className="flex gap-1.5">
          <Button type="button" variant="secondary" size="sm" onClick={flow.acceptAll}>
            {t("preview.acceptAll")}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={flow.rejectAll}>
            {t("preview.rejectAll")}
          </Button>
        </span>
      </div>

      {flow.referencesStale && (
        <div
          role="status"
          className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-foreground"
        >
          {t("preview.referencesStale")}
        </div>
      )}

      {groups.length > 1 ? (
        <Accordion
          type="multiple"
          defaultValue={groups.map((group) => group.key)}
          className="rounded-md border border-border px-3"
        >
          {groups.map((group, groupIndex) => (
            <AccordionItem key={group.key} value={group.key}>
              <AccordionTrigger>
                {resolveGroupLabel(flow, group, groupIndex)}
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {group.items.map((item) => (
                  <PolishItemCard
                    key={item.id}
                    flow={flow}
                    item={item}
                    language={language}
                  />
                ))}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      ) : (
        <div className="space-y-3">
          {groups[0]?.items.map((item) => (
            <PolishItemCard key={item.id} flow={flow} item={item} language={language} />
          ))}
        </div>
      )}
    </div>
  );
}

function resolveGroupLabel(
  flow: PolishFlow,
  group: PolishItemGroup,
  groupIndex: number,
): string {
  const parts = group.labelPaths
    .map((path) => flow.getValue(path))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.length > 0
    ? parts.join(" · ")
    : // Fallback is only reachable for a malformed path; index keeps it stable.
      `Entry ${groupIndex + 1}`;
}

function PolishItemCard({
  flow,
  item,
  language,
}: {
  flow: PolishFlow;
  item: PolishItem;
  language: PolishLanguage;
}) {
  const t = useTranslations("PolishDialog");
  const tokens = useMemo(
    () => diffWords(item.original, item.polished, language),
    [item.original, item.polished, language],
  );
  const stale = flow.staleItemIds.has(item.id);

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5",
        item.state === "accepted" && "border-success-border bg-success-soft/40",
        item.state === "rejected" && "border-border opacity-75",
        item.state === "pending" && "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-foreground-muted">
          {item.state === "accepted" && (
            <span className="inline-flex items-center gap-1 text-success-foreground">
              <Check className="size-3.5" aria-hidden />
              {t("preview.accepted")}
            </span>
          )}
          {item.state === "rejected" && (
            <span className="inline-flex items-center gap-1 text-foreground-subtle">
              <X className="size-3.5" aria-hidden />
              {t("preview.rejected")}
            </span>
          )}
        </span>
        <span className="flex gap-1">
          {item.state === "pending" && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => flow.acceptItem(item.id)}
              >
                <Check />
                {t("preview.accept")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => flow.rejectItem(item.id)}
              >
                <X />
                {t("preview.reject")}
              </Button>
            </>
          )}
          {item.state === "accepted" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => flow.undoAcceptItem(item.id)}
            >
              <Undo2 />
              {t("preview.undo")}
            </Button>
          )}
          {item.state === "rejected" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => flow.undoRejectItem(item.id)}
            >
              <Undo2 />
              {t("preview.undo")}
            </Button>
          )}
        </span>
      </div>

      {stale && (
        <p
          role="alert"
          className="mt-2 rounded border border-warning-border bg-warning-soft px-2 py-1 text-xs text-warning-foreground"
        >
          {t("preview.staleItem")}
        </p>
      )}

      <div className="mt-2 space-y-2">
        <div>
          <div className="text-xs text-foreground-subtle">{t("preview.original")}</div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground-muted">
            <WordDiffTokens tokens={tokens} side="original" />
          </p>
        </div>
        <div>
          <div className="text-xs text-foreground-subtle">{t("preview.polished")}</div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            <WordDiffTokens tokens={tokens} side="polished" />
          </p>
        </div>
      </div>

      {/* Screen-reader equivalent of the visual comparison (a11y: the diff
          never relies on the highlight styling alone). */}
      <span className="sr-only">
        {t("preview.srOriginal", { text: item.original })}
      </span>
      <span className="sr-only">
        {t("preview.srPolished", { text: item.polished })}
      </span>
    </div>
  );
}
