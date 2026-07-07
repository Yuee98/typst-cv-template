const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const H5_NS = "http://www.w3.org/1999/xhtml";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

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

function cloneSharedChild(child: Element): Element {
  const name = child.localName.toLowerCase();

  if (name === "style") {
    const scopedCss = scopeTypstCss(child.textContent ?? "");
    const clone = child.cloneNode(false) as Element;
    clone.textContent = scopedCss;
    return clone;
  }

  return child.cloneNode(true) as Element;
}

function parsePageSize(value: string | null, fallback: string): string {
  if (value === null) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return String(parsed);
}

export function splitTypstSvg(svg: string) {
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

  const shared = Array.from(root.children).filter((child) => {
    const name = child.localName.toLowerCase();
    return name === "style" || name === "defs";
  });

  return pages.map((page) => {
    const width = parsePageSize(page.getAttribute("data-page-width"), "595.28");
    const height = parsePageSize(page.getAttribute("data-page-height"), "841.89");

    const pageSvg = document.createElementNS(SVG_NS, "svg");
    pageSvg.setAttribute("style", "overflow: visible;");
    pageSvg.setAttribute("class", "typst-doc");
    pageSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    pageSvg.setAttribute("width", width);
    pageSvg.setAttribute("height", height);
    pageSvg.setAttribute("data-width", width);
    pageSvg.setAttribute("data-height", height);
    pageSvg.setAttribute("xmlns", SVG_NS);
    pageSvg.setAttributeNS(XMLNS_NS, "xmlns:xlink", XLINK_NS);
    pageSvg.setAttributeNS(XMLNS_NS, "xmlns:h5", H5_NS);

    for (const child of shared) {
      pageSvg.appendChild(cloneSharedChild(child));
    }

    const clone = page.cloneNode(true) as Element;
    clone.setAttribute("transform", "translate(0, 0)");
    pageSvg.appendChild(clone);

    return pageSvg.outerHTML;
  });
}
