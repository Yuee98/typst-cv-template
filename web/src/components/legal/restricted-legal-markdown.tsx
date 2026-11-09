import type { ReactNode } from "react";
import { isLegalHref, parseLegalMarkdown } from "@/lib/legal/markdown";
import type { LegalBlock } from "@/lib/legal/markdown";
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let position = 0;
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const index = match.index!;
    nodes.push(text.slice(position, index));
    if (!isLegalHref(match[2])) throw new Error("Unsafe legal link");
    nodes.push(<a key={index} href={match[2]} className="font-medium text-accent-soft-foreground underline underline-offset-2" {...match[2].startsWith("https:") ? {
      target: "_blank",
      rel: "noopener noreferrer"
    } : {}}>{match[1]}</a>);
    position = index + match[0].length;
  }
  nodes.push(text.slice(position));
  return nodes;
}

/** React text nodes only: no HTML injection or general-purpose Markdown plugins. */
export function RestrictedLegalMarkdown({
  body
}: {
  body: string;
}) {
  return <LegalMarkdownBody blocks={parseLegalMarkdown(body)} />;
}

/** Editable drafts use the same renderer without crashing on incomplete Markdown. */
export function LegalMarkdownPreview({ body, emptyMessage, invalidMessage }: {
  body: string;
  emptyMessage: string;
  invalidMessage: string;
}) {
  if (!body.trim()) return <p role="status" className="text-sm text-foreground-muted">{emptyMessage}</p>;
  let blocks: LegalBlock[] | null = null;
  try {
    blocks = parseLegalMarkdown(body);
  } catch { /* Incomplete editor input is rendered as an explicit validation message. */ }
  return blocks === null ? <p role="alert" className="text-sm text-danger-foreground">{invalidMessage}</p> : <LegalMarkdownBody blocks={blocks} />;
}
function LegalMarkdownBody({ blocks }: { blocks: LegalBlock[] }) {
  return <div className="space-y-4 text-base leading-7 text-foreground-muted">
    {blocks.map((block, index) => block.kind === "heading" ? <h2 key={index} className="pt-3 text-lg font-semibold text-foreground">{inline(block.text)}</h2> : block.kind === "paragraph" ? <p key={index} className="whitespace-pre-wrap break-words">{inline(block.text)}</p> : <ul key={index} className="list-disc space-y-2 pl-6">{block.items.map((item, i) => <li key={i} className="break-words">{inline(item)}</li>)}</ul>)}
  </div>;
}
