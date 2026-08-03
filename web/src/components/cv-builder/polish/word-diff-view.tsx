"use client";

import type { DiffToken } from "./word-diff";

/**
 * Renders one side of a word-level diff. Changed tokens use semantic
 * <del>/<ins> elements plus a soft background — the original side is
 * deliberately NOT struck through (agreed preview design: no deletion
 * strikethrough); the change signal relies on the background, the elements'
 * semantics for screen readers (a11y, never color alone), and the sr-only
 * before/after texts the preview card renders alongside.
 */
export function WordDiffTokens({
  tokens,
  side,
}: {
  tokens: ReadonlyArray<DiffToken>;
  side: "original" | "polished";
}) {
  return (
    <>
      {tokens.map((token, index) => {
        if (token.type === "removed") {
          return side === "original" ? (
            // Semantic <del> for the a11y tree; no-underline suppresses the
            // UA strikethrough so the original stays readable.
            <del key={index} className="rounded-sm bg-danger-soft/80 no-underline">
              {token.text}
            </del>
          ) : null;
        }
        if (token.type === "added") {
          return side === "polished" ? (
            <ins key={index} className="rounded-sm bg-success-soft/80">
              {token.text}
            </ins>
          ) : null;
        }
        return <span key={index}>{token.text}</span>;
      })}
    </>
  );
}
