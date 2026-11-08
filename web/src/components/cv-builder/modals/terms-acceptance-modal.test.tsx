// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import messagesEn from "../../../../messages/en.json";
import messagesZh from "../../../../messages/zh.json";
import type { CurrentTerms } from "@/lib/legal/terms-acceptance";
import { TermsAcceptanceModal } from "./terms-acceptance-modal";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...props }: ComponentProps<"a"> & { children: ReactNode }) => <a {...props}>{children}</a>,
}));

afterEach(cleanup);

const terms: CurrentTerms = {
  external_id: "ldv_000000000001",
  content_digest: "1".repeat(64),
  renderer_contract: "legal_document_1",
  content: {
    en: { title: "Long current terms", effectiveDate: "2026-11-07", intro: ["Full document belongs on its own page."], sections: [] },
    zh: { title: "完整使用条款", effectiveDate: "2026-11-07", intro: ["完整条款只应出现在独立页面。"], sections: [] },
  },
};

function setup(locale: "zh" | "en" = "en", overrides: Partial<ComponentProps<typeof TermsAcceptanceModal>> = {}) {
  const props = {
    terms, open: true, checked: false, accepting: false, error: null,
    onCheckedChange: vi.fn(), onAccept: vi.fn(), onClose: vi.fn(), ...overrides,
  };
  const view = render(<NextIntlClientProvider locale={locale} messages={locale === "zh" ? messagesZh : messagesEn}>
    <TermsAcceptanceModal {...props} />
  </NextIntlClientProvider>);
  return { ...view, props };
}

describe("TermsAcceptanceModal document links", () => {
  it.each(["zh", "en"] as const)("keeps %s concise and links the exact terms without accepting on a link click", locale => {
    const { props } = setup(locale);
    const link = screen.getByRole("link", { name: locale === "zh" ? "使用条款" : "Terms of Use" });
    const url = new URL(link.getAttribute("href")!, "https://preview.example");
    expect(url.pathname).toBe("/terms");
    expect(Object.fromEntries(url.searchParams)).toEqual({ document: terms.external_id, digest: terms.content_digest });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: locale === "zh" ? "隐私政策" : "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
    expect(screen.queryByText(terms.content[locale].intro[0])).toBeNull();
    expect(screen.queryByText(terms.external_id, { exact: false })).toBeNull();
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(link);
    expect(checkbox.checked).toBe(false);
    expect(props.onCheckedChange).not.toHaveBeenCalled();
    expect(props.onAccept).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: locale === "zh" ? "接受" : "Accept" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires an explicit check and preserves the accept callback", () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(props.onCheckedChange).toHaveBeenCalledWith(true);
    expect(props.onAccept).not.toHaveBeenCalled();
    rerender(<NextIntlClientProvider locale="en" messages={messagesEn}><TermsAcceptanceModal {...props} checked /></NextIntlClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(props.onAccept).toHaveBeenCalledOnce();
  });

  it("locks consent controls while accepting while keeping documents readable", () => {
    const { props } = setup("en", { checked: true, accepting: true });
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Terms of Use" }));
    expect(props.onAccept).not.toHaveBeenCalled();
    expect(props.onCheckedChange).not.toHaveBeenCalled();
  });

  it("cannot accept or offer an unpinned terms link before the target is loaded", () => {
    setup("en", { terms: null });
    expect(screen.queryByRole("link", { name: "Terms of Use" })).toBeNull();
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
