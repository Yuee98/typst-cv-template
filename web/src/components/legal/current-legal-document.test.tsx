// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messagesEn from "../../../messages/en.json";
import messagesZh from "../../../messages/zh.json";
import { aiDisclosureHref, termsDocumentHref } from "@/lib/legal/document-links";
import { getCurrentLegal, getLegalDocument } from "@/lib/legal/terms-acceptance";
import { legalDisplayFixture, legalDocumentFixture } from "@/lib/legal/test-fixtures";
import { CurrentLegalDocument } from "./current-legal-document";
const state = vi.hoisted(() => ({
  search: "",
  client: {} as object | null
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.search)
}));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: () => state.client
}));
vi.mock("@/lib/legal/terms-acceptance", () => ({
  getCurrentLegal: vi.fn(),
  getLegalDocument: vi.fn()
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => <a href={href} {...rest}>{children}</a>
}));
const terms = legalDocumentFixture(),
  display = legalDisplayFixture();
const providerB = {
  ...legalDocumentFixture("AI_PROVIDER", "4"),
  en_title: "Other service",
  zh_title: "另一服务"
};
const all = [terms, display.common, display.provider, providerB];
function page(locale: "zh" | "en" = "en", kind: "terms" | "ai_terms" = "ai_terms") {
  return <NextIntlClientProvider locale={locale} messages={locale === "zh" ? messagesZh : messagesEn}><CurrentLegalDocument locale={locale} kind={kind} /></NextIntlClientProvider>;
}
function query(href: string) {
  state.search = href.split("?")[1] ?? "";
}
beforeEach(() => {
  vi.clearAllMocks();
  state.search = "";
  state.client = {};
  vi.mocked(getCurrentLegal).mockResolvedValue({
    documents: all
  });
  vi.mocked(getLegalDocument).mockImplementation(async (_client, pin) => {
    const found = all.find(doc => doc.external_id === pin.external_id && doc.document_audit_id === pin.document_audit_id && doc.content_digest === pin.content_digest);
    if (!found) throw new Error("NOT_FOUND");
    return found;
  });
});
afterEach(cleanup);
describe("current and precise audited reading", () => {
  it.each(["zh", "en"] as const)("renders the %s common terms once with exact provider links", async locale => {
    render(page(locale));
    await screen.findByRole("heading", {
      level: 1,
      name: locale === "zh" ? display.common.zh_title : display.common.en_title
    });
    expect(screen.getAllByText(locale === "zh" ? "中文介绍" : "English introduction")).toHaveLength(1);
    expect(screen.getByRole("link", {
      name: locale === "zh" ? providerB.zh_title : providerB.en_title
    }).getAttribute("href")).toBe(aiDisclosureHref({
      common: display.common,
      provider: providerB
    }));
  });
  it.each(["zh", "en"] as const)("reads two independently pinned historical %s bodies without latest substitution", async locale => {
    query(aiDisclosureHref(display));
    render(page(locale));
    await screen.findByRole("heading", {
      name: locale === "zh" ? display.provider.zh_title : display.provider.en_title
    });
    expect(getCurrentLegal).not.toHaveBeenCalled();
    expect(getLegalDocument).toHaveBeenCalledTimes(2);
    expect(screen.getByText(locale === "zh" ? `实际数据接收方：${display.provider.recipient_name}` : `Data recipient: ${display.provider.recipient_name}`)).toBeTruthy();
    expect(screen.queryByText(/Adapter:|Endpoint:|Model:/)).toBeNull();
    expect(screen.queryByRole("link", {
      name: "Other service"
    })).toBeNull();
    expect(screen.getAllByText(locale === "zh" ? "中文介绍" : "English introduction")).toHaveLength(2);
  });
  it("retains paragraph/list/paragraph order", async () => {
    const doc = {
      ...display.provider,
      en_body: "First paragraph\n\n- Middle bullet\n\nLast paragraph"
    };
    vi.mocked(getLegalDocument).mockImplementation(async (_c, pin) => pin.external_id === doc.external_id ? doc : display.common);
    query(aiDisclosureHref(display));
    const view = render(page());
    await screen.findByText("Last paragraph");
    const nodes = Array.from(view.container.querySelectorAll("p,li")).filter(node => /First paragraph|Middle bullet|Last paragraph/.test(node.textContent ?? ""));
    expect(nodes.map(node => node.tagName)).toEqual(["P", "LI", "P"]);
  });
  it("does not fall back to current content when one historical document is missing", async () => {
    query(aiDisclosureHref(display));
    vi.mocked(getLegalDocument).mockRejectedValue(new Error("NOT_FOUND"));
    render(page());
    await screen.findByRole("alert");
    expect(getCurrentLegal).not.toHaveBeenCalled();
    expect(screen.queryByText("English introduction")).toBeNull();
  });
  it("rejects partial/legacy pins without reading", () => {
    state.search = "common_audit=2";
    render(page());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(getLegalDocument).not.toHaveBeenCalled();
    expect(getCurrentLegal).not.toHaveBeenCalled();
  });
  it("reads the exact ordinary terms audit", async () => {
    query(termsDocumentHref(terms));
    render(page("en", "terms"));
    await screen.findByRole("heading", {
      level: 1,
      name: terms.en_title
    });
    expect(getLegalDocument).toHaveBeenCalledTimes(1);
  });
  it("hides the old body immediately when the query changes and ignores late old results", async () => {
    let resolve!: (value: typeof display.provider) => void;
    vi.mocked(getLegalDocument).mockImplementation(async (_c, pin) => pin.external_id === display.provider.external_id ? new Promise(done => {
      resolve = done;
    }) : display.common);
    query(aiDisclosureHref(display));
    const view = render(page());
    query(aiDisclosureHref({
      common: display.common,
      provider: providerB
    }));
    vi.mocked(getLegalDocument).mockResolvedValueOnce(display.common).mockResolvedValueOnce(providerB);
    view.rerender(page());
    await screen.findByRole("heading", {
      name: providerB.en_title
    });
    await act(async () => resolve(display.provider));
    expect(screen.queryByRole("heading", {
      name: display.provider.en_title
    })).toBeNull();
  });
});
