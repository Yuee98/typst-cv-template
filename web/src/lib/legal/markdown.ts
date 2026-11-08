export type LegalBlock = {
  kind: "heading";
  text: string;
} | {
  kind: "paragraph";
  text: string;
} | {
  kind: "list";
  items: string[];
};
export function isLegalHref(value: string): boolean {
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return false;
  if (/^\/(?!\/)/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The sole body format: paragraphs, ## headings, - lists and safe links. */
export function parseLegalMarkdown(body: string): LegalBlock[] {
  if (!body.trim() || body.length > 65536 || /[<>]|!\[|```/.test(body)) throw new Error("Invalid legal Markdown");
  for (const match of body.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    if (!isLegalHref(match[2])) throw new Error("Unsafe legal link");
  }
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({
        kind: "paragraph",
        text: paragraph.join("\n")
      });
      paragraph = [];
    }
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      blocks.push({
        kind: "heading",
        text: line.slice(3)
      });
    } else if (line.startsWith("- ")) {
      flush();
      const previous = blocks.at(-1);
      if (previous?.kind === "list") previous.items.push(line.slice(2));else blocks.push({
        kind: "list",
        items: [line.slice(2)]
      });
    } else {
      if (/^\s*#|^\s*[-*+]\s|^\s*\d+\.\s/.test(line)) throw new Error("Unsupported legal Markdown");
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}
