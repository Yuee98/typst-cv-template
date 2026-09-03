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
  }) => (
    <a href={locale ? `/${locale}${href}` : href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

function renderLegalDocument(locale: "zh" | "en", document: typeof legalEn.aiTermsDocument) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "zh" ? messagesZh : messagesEn}
    >
      <LegalDocumentPage document={document} />
    </NextIntlClientProvider>,
  );
}

describe("LegalDocumentPage structured links and anchors", () => {
  it.each([
    {
      locale: "en" as const,
      document: legalEn.aiTermsDocument,
      sourceLabel: /Official source 1:/,
    },
    {
      locale: "zh" as const,
      document: legalZh.aiTermsDocument,
      sourceLabel: /官方来源 1：/,
    },
  ])("renders stable provider annex ids and safe external links for $locale", ({
    locale,
    document,
    sourceLabel,
  }) => {
    const { container } = renderLegalDocument(locale, document);

    expect(container.querySelector("#provider-annex-deepseek-official-v1")).not.toBeNull();
    expect(container.querySelector("#provider-annex-mimo-cn-v1")).not.toBeNull();

    const source = screen.getAllByRole("link", { name: sourceLabel })[0];
    expect(source.getAttribute("href")).toMatch(/^https:\/\//);
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each([
    {
      locale: "en" as const,
      document: legalEn.privacyDocument,
      deepseekLabel: "View the DeepSeek provider annex",
      mimoLabel: "View the MiMo provider annex",
    },
    {
      locale: "zh" as const,
      document: legalZh.privacyDocument,
      deepseekLabel: "查看 DeepSeek 提供方附录",
      mimoLabel: "查看 MiMo 提供方附录",
    },
  ])("renders locale-prefixed Privacy Policy annex links for $locale", ({
    locale,
    document,
    deepseekLabel,
    mimoLabel,
  }) => {
    renderLegalDocument(locale, document);

    expect(screen.getByRole("link", { name: deepseekLabel }).getAttribute("href")).toBe(
      `/${locale}/ai-terms#provider-annex-deepseek-official-v1`,
    );
    expect(screen.getByRole("link", { name: mimoLabel }).getAttribute("href")).toBe(
      `/${locale}/ai-terms#provider-annex-mimo-cn-v1`,
    );
  });
});
