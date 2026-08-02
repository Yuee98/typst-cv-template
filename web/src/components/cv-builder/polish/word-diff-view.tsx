"use client";

import type { DiffToken } from "./word-diff";

/**
 * Renders one side of a word-level diff. Changed tokens use semantic
 * <del>/<ins> elements plus strikethrough/underline and a soft background —
 * the change signal never relies on color alone (a11y), and screen readers
 * announce the elements' semantics.
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
            <del key={index} className="rounded-sm bg-danger-soft/80">
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
