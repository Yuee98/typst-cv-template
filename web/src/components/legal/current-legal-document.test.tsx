// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messagesEn from "../../../messages/en.json";
import messagesZh from "../../../messages/zh.json";
import { aiDisclosureHref, termsDocumentHref } from "@/lib/legal/document-links";
import { getCurrentLegal, type CurrentLegal } from "@/lib/legal/terms-acceptance";
import { CurrentLegalDocument } from "./current-legal-document";

const state = vi.hoisted(() => ({ search: "", client: {} as object | null }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(state.search) }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseBrowserClient: () => state.client }));
vi.mock("@/lib/legal/terms-acceptance", () => ({ getCurrentLegal: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const termsId = "ldv_111111111111", bundleId = "lgb_111111111111", disclosureId = "lds_111111111111";
const termsDigest = "a".repeat(64), manifestDigest = "b".repeat(64), contentDigest = "c".repeat(64);
function fixture(): CurrentLegal {
  const terms = { title: "Service terms", effectiveDate: "2026-11-08", intro: ["ORDINARY TERMS BODY"], sections: [] };
  const common = { title: "AI service terms", effectiveDate: "2026-11-08", intro: ["COMMON INTRO"], sections: [{ heading: "Common obligations", body: ["COMMON BODY"] }] };
  const content = (providerLabel: string, modelLabel: string) => ({ providerLabel, modelLabel, blocks: [
    { kind: "paragraph" as const, text: "COMMON INTRO" },
    { kind: "bulletList" as const, items: [`${providerLabel} SPECIFIC BULLET`] },
    { kind: "paragraph" as const, text: `${providerLabel} LAST PARAGRAPH` },
  ] });
  const ds = content("DeepSeek", "deepseek-flash"), mimo = content("MiMo", "mimo-v2.6-flash");
  return {
    terms: { external_id: termsId, content_digest: termsDigest, renderer_contract: "legal_document_1", content: { zh: terms, en: terms } },
    ai_bundle: {
      external_id: bundleId, manifest_digest: manifestDigest,
      ai_terms: { external_id: "ldv_222222222222", content_digest: "d".repeat(64), renderer_contract: "legal_document_1", content: { zh: common, en: common } },
      disclosures: [
        { external_id: disclosureId, provider_code: "DEEPSEEK", content_digest: contentDigest, renderer_contract: "legal_display_1", content: { zh: ds, en: ds } },
        { external_id: "lds_222222222222", provider_code: "MIMO", content_digest: "e".repeat(64), renderer_contract: "legal_display_1", content: { zh: mimo, en: mimo } },
      ],
    },
  };
}
function exactAi(data = fixture()) {
  return aiDisclosureHref({ bundleId: data.ai_bundle!.external_id, manifestDigest: data.ai_bundle!.manifest_digest, disclosureId: data.ai_bundle!.disclosures[0].external_id, contentDigest: data.ai_bundle!.disclosures[0].content_digest });
}
function setQuery(href: string) { state.search = href.split("?")[1] ?? ""; }
function page(locale: "zh" | "en" = "en", kind: "terms" | "ai_terms" = "ai_terms") {
  return <NextIntlClientProvider locale={locale} messages={locale === "zh" ? messagesZh : messagesEn}><CurrentLegalDocument locale={locale} kind={kind} /></NextIntlClientProvider>;
}
beforeEach(() => { vi.clearAllMocks(); state.search = ""; state.client = {}; vi.mocked(getCurrentLegal).mockResolvedValue(fixture()); });
afterEach(cleanup);

describe("current and exact legal reading pages", () => {
  it.each(["zh", "en"] as const)("shows common terms once and links to complete Provider documents in %s", async locale => {
    const view = render(page(locale));
    await screen.findByRole("heading", { name: "AI service terms", level: 1 });
    expect(screen.getAllByText("COMMON INTRO")).toHaveLength(1);
    expect(screen.queryByText("DeepSeek SPECIFIC BULLET")).toBeNull();
    expect(screen.queryByText("MiMo SPECIFIC BULLET")).toBeNull();
    expect(screen.getByRole("link", { name: "DeepSeek · deepseek-flash" }).getAttribute("href")).toBe(exactAi());
    expect(view.container.querySelector("#provider-deepseek")).not.toBeNull();
    expect(view.container.querySelector("#provider-mimo")).not.toBeNull();
  });
  it.each(["zh", "en"] as const)("renders only the exact selected document in its original block order in %s", async locale => {
    setQuery(exactAi());
    const view = render(page(locale));
    await screen.findByRole("heading", { level: 1, name: "AI service terms · DeepSeek · deepseek-flash" });
    expect(screen.getAllByText("COMMON INTRO")).toHaveLength(1);
    expect(screen.queryByText("COMMON BODY")).toBeNull();
    expect(screen.queryByText("MiMo SPECIFIC BULLET")).toBeNull();
    expect(screen.queryByRole("link", { name: /MiMo/ })).toBeNull();
    expect(Array.from(view.container.querySelector("#provider-deepseek")!.children).map(x => x.tagName)).toEqual(["P", "UL", "P"]);
    expect(view.container.querySelector("#provider-deepseek")!.textContent).toBe("COMMON INTRODeepSeek SPECIFIC BULLETDeepSeek LAST PARAGRAPH");
  });
  it.each(["bundle", "manifest", "disclosure", "digest"])("does not substitute current or another Provider for a mismatched %s", async key => {
    const url = new URL(exactAi(), "https://preview.test");
    url.searchParams.set(key, key === "bundle" ? "lgb_222222222222" : key === "disclosure" ? "lds_222222222222" : "f".repeat(64));
    state.search = url.searchParams.toString();
    render(page());
    await screen.findByRole("alert");
    expect(screen.queryByText("COMMON INTRO")).toBeNull();
    expect(screen.queryByText(/SPECIFIC BULLET/)).toBeNull();
  });
  it("rejects an incomplete exact link without a legal read", async () => {
    state.search = `disclosure=${disclosureId}`;
    render(page());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(getCurrentLegal).not.toHaveBeenCalled();
  });
  it("shows the ordinary terms at their matching target", async () => {
    setQuery(termsDocumentHref(fixture().terms));
    render(page("en", "terms"));
    await screen.findByRole("heading", { name: "Service terms", level: 1 });
    expect(screen.getByText("ORDINARY TERMS BODY")).toBeTruthy();
  });
  it.each(["document", "digest"])("rejects a changed ordinary terms %s", async key => {
    const url = new URL(termsDocumentHref(fixture().terms), "https://preview.test");
    url.searchParams.set(key, key === "document" ? "ldv_222222222222" : "f".repeat(64));
    state.search = url.searchParams.toString();
    render(page("en", "terms"));
    await screen.findByRole("alert");
    expect(screen.queryByText("ORDINARY TERMS BODY")).toBeNull();
  });
  it("does not show a document when the public read fails", async () => {
    vi.mocked(getCurrentLegal).mockRejectedValueOnce(new Error("unavailable"));
    render(page());
    await screen.findByText("Current terms are unavailable. Please refresh later.");
    expect(screen.queryByText("COMMON INTRO")).toBeNull();
  });
  it("does not adopt an older query's late response after navigating to another exact document", async () => {
    const old = fixture(), newer = fixture();
    newer.ai_bundle!.external_id = "lgb_333333333333";
    newer.ai_bundle!.disclosures[0].content.en.blocks[0] = { kind: "paragraph", text: "NEW DOCUMENT" };
    let finish!: (value: CurrentLegal) => void;
    vi.mocked(getCurrentLegal).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(newer);
    setQuery(exactAi(old));
    const view = render(page());
    setQuery(exactAi(newer));
    view.rerender(page());
    await screen.findByText("NEW DOCUMENT");
    await act(async () => { finish(old); });
    expect(screen.getByText("NEW DOCUMENT")).toBeTruthy();
    expect(screen.queryByText("COMMON INTRO")).toBeNull();
  });
});
