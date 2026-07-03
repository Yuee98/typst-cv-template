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
