// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import messagesEn from "../../../messages/en.json";
import messagesZh from "../../../messages/zh.json";
import { legalEn, legalZh } from "@/content/legal";
import { LegalDocumentPage } from "./legal-document-page";
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    children,
    href,
    locale,
    ...rest
  }: {
    children: ReactNode;
    href: string;
    locale?: "zh" | "en";
  }) => <a href={locale ? `/${locale}${href}` : href} {...rest}>
      {children}
    </a>
}));
afterEach(() => {
  cleanup();
});
function renderLegalDocument(locale: "zh" | "en", document: typeof legalEn.aiTermsDocument) {
  return render(<NextIntlClientProvider locale={locale} messages={locale === "zh" ? messagesZh : messagesEn}>
      <LegalDocumentPage document={document} />
    </NextIntlClientProvider>);
}
describe("LegalDocumentPage structured links and anchors", () => {
  it.each([{
    locale: "en" as const,
    document: legalEn.privacyDocument,
    deepseekLabel: "View the DeepSeek data-processing disclosure",
    mimoLabel: "View the MiMo data-processing disclosure"
  }, {
    locale: "zh" as const,
    document: legalZh.privacyDocument,
    deepseekLabel: "查看 DeepSeek 数据处理说明",
    mimoLabel: "查看 MiMo 数据处理说明"
  }])("renders locale-prefixed Privacy Policy annex links for $locale", ({
    locale,
    document,
    deepseekLabel,
    mimoLabel
  }) => {
    renderLegalDocument(locale, document);
    expect(screen.getByRole("link", {
      name: deepseekLabel
    }).getAttribute("href")).toBe(`/${locale}/ai-terms`);
    expect(screen.getByRole("link", {
      name: mimoLabel
    }).getAttribute("href")).toBe(`/${locale}/ai-terms`);
  });
});
