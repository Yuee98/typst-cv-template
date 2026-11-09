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
  if (/[\\\u0000-\u0020\u007f]|\s/.test(value)) return false;
  if (/^\/(?!\/)/.test(value)) return true;
  if (!/^https:\/\//i.test(value)) return false;
  const authority = value.slice(8).split(/[/?#]/, 1)[0];
  if (authority.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:.]+)\](?::([0-9]{1,5}))?$/.exec(authority);
    if (!match || !validPort(match[2])) return false;
    const address = match[1];
    if (address.includes(".") && !canonicalIpv4(address.slice(address.lastIndexOf(":") + 1))) return false;
    try {
      // The native parser is used only for IPv6 syntax. SQL uses inet here;
      // DNS/IPv4 and authority spelling follow the shared lexical contract.
      new URL(`https://[${address}]`);
      return true;
    } catch {
      return false;
    }
  }
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!match || match[1].length > 253 || !validPort(match[2])) return false;
  const trailingDot = match[1].endsWith(".");
  const host = trailingDot ? match[1].slice(0, -1) : match[1];
  const labels = host.split(".");
  if (!labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return false;
  // Browsers repair numeric and hexadecimal host spellings as IPv4. Accept
  // only the explicit four-octet form instead of implementing those repairs.
  if (/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(labels.at(-1)!)) return !trailingDot && canonicalIpv4(host);
  return true;
}
function validPort(value: string | undefined): boolean {
  return value === undefined || Number(value) >= 1 && Number(value) <= 65535;
}
function canonicalIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
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
