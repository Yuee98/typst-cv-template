"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type PreviewStatus = "idle" | "rendering" | "ready" | "error";

function splitSelectorList(selectorText: string) {
  const selectors: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < selectorText.length; index += 1) {
    const char = selectorText[index];

    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      selectors.push(selectorText.slice(start, index));
      start = index + 1;
    }
  }

  selectors.push(selectorText.slice(start));
  return selectors;
}

function scopeSelector(selector: string) {
  const trimmed = selector.trim();

  if (!trimmed) return trimmed;
  if (trimmed === "svg" || trimmed === ":root") return ".typst-doc";
  if (trimmed.startsWith(".typst-doc")) return trimmed;

  if (/^svg(?=[\s.#:[>+~]|$)/.test(trimmed)) {
    return trimmed.replace(/^svg/, ".typst-doc");
  }

  return `.typst-doc ${trimmed}`;
}

function scopeSelectorList(selectorText: string) {
  return splitSelectorList(selectorText).map(scopeSelector).join(", ");
}

function scopeCssTextFallback(cssText: string) {
  return cssText.replace(/(^|})(\s*)([^@{}][^{}]*?)\s*\{/g, (match, close, whitespace, selector) => {
    const scoped = scopeSelectorList(selector);
    return `${close}${whitespace}${scoped} {`;
  });
}

function scopeTypstCss(cssText: string) {
  if (typeof CSSStyleSheet === "undefined") {
    return scopeCssTextFallback(cssText);
  }

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);

    return Array.from(sheet.cssRules)
      .map((rule) => {
        if (rule.type === 1) {
          const styleRule = rule as CSSStyleRule;
          return `${scopeSelectorList(styleRule.selectorText)} { ${styleRule.style.cssText} }`;
        }

        if (rule.type === 4) {
          const mediaRule = rule as CSSMediaRule;
          const scopedRules = Array.from(mediaRule.cssRules)
            .map((childRule) => {
              if (childRule.type !== 1) return childRule.cssText;

              const styleRule = childRule as CSSStyleRule;
              return `${scopeSelectorList(styleRule.selectorText)} { ${styleRule.style.cssText} }`;
            })
            .join("\n");
          return `@media ${mediaRule.conditionText} {\n${scopedRules}\n}`;
        }

        return rule.cssText;
      })
      .join("\n");
  } catch {
    return scopeCssTextFallback(cssText);
  }
}

function serializeSharedTypstChild(child: Element) {
  const name = child.localName.toLowerCase();

  if (name === "style") {
    const scopedCss = scopeTypstCss(child.textContent ?? "");
    return `<style>${scopedCss}</style>`;
  }

  return child.outerHTML;
}

function splitTypstSvg(svg: string) {
  if (typeof window === "undefined") {
    return svg ? [svg] : [];
  }

  const template = document.createElement("template");
  template.innerHTML = svg.trim();
  const root = template.content.querySelector("svg");
  const pages = Array.from(root?.querySelectorAll("g.typst-page") ?? []);

  if (!root || pages.length === 0) {
    return svg ? [svg] : [];
  }

  const shared = Array.from(root.children)
    .filter((child) => {
      const name = child.localName.toLowerCase();
      return name === "style" || name === "defs";
    })
    .map(serializeSharedTypstChild)
    .join("");

  return pages.map((page) => {
    const width = page.getAttribute("data-page-width") ?? "595.28";
    const height = page.getAttribute("data-page-height") ?? "841.89";
    const clone = page.cloneNode(true) as Element;
    clone.setAttribute("transform", "translate(0, 0)");
    return `<svg style="overflow: visible;" class="typst-doc" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" data-width="${width}" data-height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h5="http://www.w3.org/1999/xhtml">${shared}${clone.outerHTML}</svg>`;
  });
}

function StatusBadge({ status }: { status: PreviewStatus }) {
  const label = {
    idle: "Waiting",
    rendering: "Rendering",
    ready: "Ready",
    error: "Error",
  }[status];

  const Icon = status === "rendering" ? Loader2 : status === "error" ? AlertTriangle : CheckCircle2;

  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium",
        status === "error"
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-emerald-200 bg-emerald-50 text-emerald-700",
      )}
    >
      <Icon className={cn("size-4", status === "rendering" && "animate-spin")} />
      {label}
    </span>
  );
}

export function PreviewPane({
  svg,
  status,
  error,
  actions,
}: {
  svg: string | null;
  status: PreviewStatus;
  error: string | null;
  actions?: ReactNode;
}) {
  const pages = useMemo(() => splitTypstSvg(svg ?? ""), [svg]);

  return (
    <Panel
      title="Preview"
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          {actions}
        </div>
      }
      className="preview-pane flex h-full min-h-[720px] flex-col overflow-hidden"
    >
      {error && (
        <div className="preview-error border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800 print:hidden">
          {error}
        </div>
      )}
      <div className="preview-scroll flex-1 overflow-auto bg-slate-200 p-5">
        <div className="mx-auto flex w-full max-w-[210mm] flex-col gap-5">
          {pages.length > 0 ? (
            pages.map((page, index) => (
              <div
                key={index}
                className="typst-page-shell bg-white shadow-md ring-1 ring-slate-300"
                dangerouslySetInnerHTML={{ __html: page }}
              />
            ))
          ) : (
            <div className="flex h-[297mm] w-[210mm] items-center justify-center bg-white text-sm text-slate-500 shadow-md ring-1 ring-slate-300">
              Preview will appear here.
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
