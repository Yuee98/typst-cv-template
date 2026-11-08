// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import messagesEn from "../../../../messages/en.json";
import messagesZh from "../../../../messages/zh.json";
import { fixtureAvailability } from "@/lib/polish/fixtures";
import { PolishConfigPhase } from "./polish-config-phase";
import { createInitialState } from "./polish-reducer";
import type { PolishSnapshot } from "./scope-builder";
import type { PolishFlow } from "./use-polish-flow";

vi.mock("@/i18n/navigation", () => ({
  Link: (props: ComponentProps<"a">) => <a {...props} />,
}));

afterEach(cleanup);

function makeFlow(): PolishFlow {
  const availability = fixtureAvailability([1, 2, 3], false).availability;
  const targets = [{ id: "i0", text: "Selected resume text to polish." }];
  const references = [{ role: "sibling" as const, text: "Selected context for this request." }];
  const snapshot: PolishSnapshot = {
    documentId: "local-preview",
    targets: targets.map(target => ({ ...target, path: "profile.0.body" })),
    referencePaths: ["profile.1.body"],
    apiRequest: {
      clientRequestId: "10000000-0000-4000-8000-000000000001",
      language: "en", sectionId: "profile", granularity: "item",
      items: targets.map(target => ({ ...target, kind: "profile" })),
      context: { level: 1, references },
    },
    disclosure: { targets, references, totalTargetChars: targets[0].text.length, totalReferenceChars: references[0].text.length },
  };
  return {
    isOpen: true, state: { ...createInitialState<PolishSnapshot>(), snapshot }, scope: null, scopeFailure: null,
    signedIn: true, encrypted: true, getValue: vi.fn(), quota: null, quotaStatus: "ready",
    availabilityCandidate: { ...availability, selectedConfigId: availability.configurations[0].configId },
    availabilityStatus: "ready", selectConfiguration: vi.fn(),
    terms: { status: "required", checked: false, serverRejected: false, setChecked: vi.fn() },
    configChangedHint: false, routeChangedHint: false, staleItemIds: new Set(), referencesStale: false, canConfirm: false,
    open: vi.fn(), close: vi.fn(), setLevel: vi.fn(), setStylePreset: vi.fn(), setStyleInstruction: vi.fn(),
    confirm: vi.fn(), cancel: vi.fn(), retry: vi.fn(), backToConfig: vi.fn(),
    acceptItem: vi.fn(), rejectItem: vi.fn(), undoAcceptItem: vi.fn(), undoRejectItem: vi.fn(),
    acceptAll: vi.fn(), rejectAll: vi.fn(), refreshTerms: vi.fn(), quotaRetry: vi.fn(), availabilityRetry: vi.fn(),
  };
}

function renderPhase(flow: PolishFlow, locale: "zh" | "en" = "en") {
  return <NextIntlClientProvider locale={locale} messages={locale === "zh" ? messagesZh : messagesEn}><PolishConfigPhase flow={flow} /></NextIntlClientProvider>;
}

function expectPinnedLinks(flow: PolishFlow) {
  const option = flow.availabilityCandidate!.configurations.find(o => o.configId === flow.availabilityCandidate!.selectedConfigId)!;
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(1);
  for (const link of links) {
    const url = new URL(link.getAttribute("href")!, "https://preview.example");
    expect(url.pathname).toBe("/ai-terms");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      common: option.legalDisplay.common.external_id, common_audit: option.legalDisplay.common.document_audit_id, common_digest: option.legalDisplay.common.content_digest,
      provider: option.legalDisplay.provider.external_id, provider_audit: option.legalDisplay.provider.document_audit_id, provider_digest: option.legalDisplay.provider.content_digest,
    });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("rel")).toContain("noopener");
  }
  return links;
}

describe("PolishConfigPhase exact provider reading links", () => {
  it("shows only public names in the selector and the actual recipient in consent", () => {
    const flow = makeFlow();
    flow.availabilityCandidate!.configurations[0].displayName = "Fast writing";
    render(renderPhase(flow));
    const option = screen.getByRole("option", { name: "Fast writing" }) as HTMLOptionElement;
    expect(option.value).toBe(flow.availabilityCandidate!.selectedConfigId);
    expect(screen.getByRole("checkbox", { name: /DeepSeek/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /DeepSeek/ })).toBeNull();
  });
  it.each(["zh", "en"] as const)("keeps %s full disclosure off the dialog and preserves the important reminders", locale => {
    const flow = makeFlow();
    render(renderPhase(flow, locale));
    expect(screen.getByRole("combobox", { name: locale === "zh" ? "选择 AI 服务" : "Choose AI service" })).toBeTruthy();
    expect(screen.queryByText(locale === "zh" ? "此项为本地测试披露。" : "Local test disclosure.")).toBeNull();
    expect(screen.getByText(locale === "zh" ? messagesZh.PolishDialog.privacyReminder : messagesEn.PolishDialog.privacyReminder)).toBeTruthy();
    expect(screen.getByText(locale === "zh" ? messagesZh.PolishDialog.e2eeWarning : messagesEn.PolishDialog.e2eeWarning)).toBeTruthy();
    expect(screen.getByText("Selected resume text to polish.")).toBeTruthy();
    expect(screen.getByText("Selected context for this request.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /DeepSeek/ })).toBeTruthy();
    const links = expectPinnedLinks(flow);
    fireEvent.click(links[0]);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(flow.terms.setChecked).not.toHaveBeenCalled();
    expect(flow.confirm).not.toHaveBeenCalled();
    expect(flow.selectConfiguration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(flow.terms.setChecked).toHaveBeenCalledWith(true);
    expect(flow.confirm).not.toHaveBeenCalled();
  });

  it("updates reading links and consent labels to the selected MiMo and Google disclosure", () => {
    const flow = makeFlow();
    const view = render(renderPhase(flow));
    for (const index of [1, 2]) {
      const option = flow.availabilityCandidate!.configurations[index];
      option.legalDisplay.provider.content_digest = String(index + 2).repeat(64);
      fireEvent.change(screen.getByRole("combobox"), { target: { value: option.configId } });
      expect(flow.selectConfiguration).toHaveBeenLastCalledWith(option.configId);
      flow.availabilityCandidate = { ...flow.availabilityCandidate!, selectedConfigId: option.configId };
      view.rerender(renderPhase(flow));
      expectPinnedLinks(flow);
      const checkbox = screen.getByRole("checkbox", { name: new RegExp(option.legalDisplay.provider.recipient_name!) }) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      expect(screen.queryByRole("checkbox", { name: /DeepSeek/ })).toBeNull();
      expect(flow.confirm).not.toHaveBeenCalled();
    }
  });

  it("hides the consent row and duplicate reading links after acceptance", () => {
    const flow = makeFlow();
    flow.terms.status = "accepted";
    render(renderPhase(flow));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(flow.confirm).not.toHaveBeenCalled();
  });

  it("locks the existing consent/config controls during acceptance without hiding reading links", () => {
    const flow = makeFlow();
    flow.terms = { ...flow.terms, status: "accepting", checked: true };
    render(renderPhase(flow));
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLInputElement).disabled).toBe(true);
    expectPinnedLinks(flow);
    expect(screen.getByText(messagesEn.PolishDialog.terms.accepting)).toBeTruthy();
  });

  it("does not show an unpinned consent checkbox without a selected provider", () => {
    const flow = makeFlow();
    flow.availabilityCandidate = { ...flow.availabilityCandidate!, selectedConfigId: null };
    render(renderPhase(flow));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
