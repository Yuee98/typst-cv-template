// @vitest-environment jsdom
/**
 * Component-level terms-acceptance lock (relay #1): while the AI-terms
 * acceptance write is in flight, the dialog disables EVERY dismissal path
 * (X button / Escape / overlay) and every config control, so the reviewed
 * snapshot can never be sent from a dismissed or reconfigured dialog. The
 * hook additionally kills the continuation on programmatic close — that
 * half is covered in use-polish-flow.test.tsx.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";

import { ENABLED_AVAILABILITY_BODY } from "./__tests__/client/fixtures";
import { PolishDialog } from "./polish-dialog";
import { resolvePolishProviderAnnexHref } from "./polish-provider-annex";
import { createInitialState } from "./polish-reducer";
import type { PolishFlow } from "./use-polish-flow";

// The config phase renders the AI-terms link via the next-intl Link, which
// pulls next/navigation into the graph — unresolvable under vitest and
// irrelevant to these assertions.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, ...rest }: { children?: unknown; href?: string }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

function makeStubFlow(overrides?: Partial<PolishFlow>): PolishFlow {
  const state = createInitialState();
  return {
    isOpen: true,
    state: { ...state, phase: "config" },
    scope: { sectionId: "skills", granularity: "section" },
    scopeFailure: null,
    signedIn: true,
    encrypted: false,
    getValue: () => undefined,
    quota: { limit: 20, remaining: 5, resetAt: "2026-08-04T00:00:00Z" },
    quotaStatus: "ready",
    availabilityCandidate: ENABLED_AVAILABILITY_BODY.availability,
    availabilityStatus: "ready",
    terms: {
      status: "accepting",
      serverRejected: false,
      checked: true,
      setChecked: vi.fn(),
    },
    configChangedHint: false,
    routeChangedHint: false,
    staleItemIds: new Set(),
    referencesStale: false,
    canConfirm: false,
    open: vi.fn(),
    close: vi.fn(),
    setLevel: vi.fn(),
    setStylePreset: vi.fn(),
    setStyleInstruction: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    backToConfig: vi.fn(),
    acceptItem: vi.fn(),
    rejectItem: vi.fn(),
    undoAcceptItem: vi.fn(),
    undoRejectItem: vi.fn(),
    acceptAll: vi.fn(),
    rejectAll: vi.fn(),
    refreshTerms: vi.fn(),
    quotaRetry: vi.fn(),
    availabilityRetry: vi.fn(),
    ...overrides,
  } as PolishFlow;
}

function renderDialog(flow: PolishFlow) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PolishDialog flow={flow} language="zh" />
    </NextIntlClientProvider>,
  );
}

describe("PolishDialog terms-acceptance lock", () => {
  it("accepting: X / Escape / footer / config controls are all disabled", () => {
    const flow = makeStubFlow();
    renderDialog(flow);

    // X button disabled.
    const closeButton = screen.getByRole("button", { name: messages.PolishDialog.close });
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);
    // Footer cancel + confirm disabled (confirm shows the accepting label).
    expect(
      (screen.getByRole("button", { name: messages.PolishDialog.cancel }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: messages.PolishDialog.terms.accepting,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // Config controls locked: level radios, style preset chips, instruction.
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
    for (const chip of screen.getAllByRole("button", { pressed: false })) {
      expect((chip as HTMLButtonElement).disabled).toBe(true);
    }
    expect(
      (screen.getByLabelText(messages.PolishDialog.style.heading) as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    // Escape must not close while the acceptance write is in flight.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(flow.close).not.toHaveBeenCalled();
  });

  it("not accepting: X and Escape close normally", () => {
    const flow = makeStubFlow({
      terms: { status: "accepted", serverRejected: false, checked: false, setChecked: vi.fn() },
      canConfirm: true,
    });
    renderDialog(flow);

    const closeButton = screen.getByRole("button", { name: messages.PolishDialog.close });
    expect((closeButton as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(flow.close).toHaveBeenCalledTimes(1);
  });

  it("checking: normal UI reconfiguration routes through the safe hook setters", () => {
    const setLevel = vi.fn();
    const setStylePreset = vi.fn();
    const setStyleInstruction = vi.fn();
    const flow = makeStubFlow({
      availabilityCandidate: null,
      availabilityStatus: "loading",
      terms: {
        status: "checking",
        serverRejected: false,
        checked: false,
        setChecked: vi.fn(),
      },
      setLevel,
      setStylePreset,
      setStyleInstruction,
    });
    renderDialog(flow);

    const radios = screen.getAllByRole("radio");
    expect((radios[2] as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(radios[2]);
    expect(setLevel).toHaveBeenCalledWith(2);

    const concise = screen.getByRole("button", {
      name: messages.PolishDialog.style.presets.concise,
    });
    expect((concise as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(concise);
    expect(setStylePreset).toHaveBeenCalledWith("concise");

    const instruction = screen.getByLabelText(
      messages.PolishDialog.style.heading,
    );
    expect((instruction as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(instruction, { target: { value: "Direct and specific" } });
    expect(setStyleInstruction).toHaveBeenCalledWith("Direct and specific");
  });
});

describe("PolishDialog E2EE plaintext warning", () => {
  it("renders the warning prominently for an encrypted document", () => {
    renderDialog(makeStubFlow({ encrypted: true }));

    const warningText = screen.getByText(messages.PolishDialog.e2eeWarning);
    const warning = warningText.parentElement;
    expect(warning).not.toBeNull();
    expect(warning?.className).toContain("border-warning-border");
    expect(warning?.className).toContain("bg-warning-soft");
    expect(warning?.className).toContain("text-warning-foreground");
  });

  it("does not render the E2EE-specific warning for an unencrypted document", () => {
    renderDialog(makeStubFlow({ encrypted: false }));

    expect(screen.queryByText(messages.PolishDialog.e2eeWarning)).toBeNull();
  });
});

describe("PolishDialog provider disclosure", () => {
  it("uses one polite loading region and one non-nested assertive error alert", () => {
    const loading = renderDialog(
      makeStubFlow({ state: { ...createInitialState(), phase: "loading" } }),
    );
    const loadingRegion = screen.getByRole("status");
    expect(loadingRegion.getAttribute("aria-live")).toBe("polite");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    loading.unmount();

    renderDialog(
      makeStubFlow({
        state: {
          ...createInitialState(),
          phase: "error",
          error: { code: "UPSTREAM_ERROR" },
        },
      }),
    );
    const alert = screen.getByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alert.closest("[aria-live]")).toBeNull();
    expect(document.activeElement).not.toBe(alert);
  });

  it("keeps the refreshed recipient and content visible under the route-changed hint", () => {
    renderDialog(makeStubFlow({ routeChangedHint: true }));

    expect(screen.getByText(messages.PolishDialog.routeChanged)).toBeTruthy();
    expect(screen.getByText(/DeepSeek · DeepSeek V4 Flash/)).toBeTruthy();
    expect(screen.getByText(messages.PolishDialog.privacyReminder)).toBeTruthy();
  });

  it("renders the exact DeepSeek recipient, model and code-owned annex without a selector", () => {
    renderDialog(makeStubFlow());

    expect(
      screen.getByText(
        messages.PolishDialog.availability.selected
          .replace("{provider}", "DeepSeek")
          .replace("{model}", "DeepSeek V4 Flash"),
      ),
    ).toBeTruthy();
    const annex = screen.getByRole("link", { name: messages.PolishDialog.availability.annex });
    expect(annex.getAttribute("href")).toBe("/ai-terms#provider-annex-deepseek-official-v1");
    expect(annex.tabIndex).toBe(0);
    annex.focus();
    expect(document.activeElement).toBe(annex);
    expect(annex.className).toContain("focus-visible:ring-2");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("maps the MiMo display key to its exact annex", () => {
    renderDialog(
      makeStubFlow({
        availabilityCandidate: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          displayDisclosure: {
            key: "mimo-cn-v1",
            providerName: "MiMo",
            modelName: "MiMo V2.5 Pro",
          },
        },
      }),
    );

    expect(screen.getByText(/MiMo · MiMo V2.5 Pro/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: messages.PolishDialog.availability.annex })
        .getAttribute("href"),
    ).toBe("/ai-terms#provider-annex-mimo-cn-v1");
  });

  it("renders a sealed configurable disclosure inline without a frontend annex switch", () => {
    renderDialog(
      makeStubFlow({
        availabilityCandidate: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          legalBundleVersion: "legal-bundle-configurable-v2",
          displayDisclosure: {
            key: "configured-provider-v2",
            providerName: "Configured Provider",
            modelName: "Configurable Model V2",
            legalDisplay: {
              schemaVersion: "legal_display_v2",
              displayDisclosureKey: "configured-provider-v2",
              legalBundleVersion: "legal-bundle-configurable-v2",
              legalManifestId: "configured-provider-manifest-v2",
              providerId: "00000000-0000-4000-8000-000000000045",
              recipientKey: "configured-provider",
              modelId: "configurable-model-v2",
              contentSha256: "c".repeat(64),
              factIds: ["fact.configurable-provider-v2"],
              evidenceIds: ["evidence.configurable-provider-v2"],
              en: {
                providerLabel: "Configured Provider",
                modelLabel: "Configurable Model V2",
                blocks: [
                  { kind: "paragraph", text: "Reviewed inline disclosure." },
                  { kind: "bulletList", items: ["No raw HTML is rendered."] },
                ],
              },
              zh: {
                providerLabel: "配置化服务商",
                modelLabel: "配置化模型 V2",
                blocks: [{ kind: "paragraph", text: "已审核的披露。" }],
              },
            },
          },
        },
      }),
    );

    expect(screen.getByText(/Configured Provider · Configurable Model V2/u)).toBeTruthy();
    expect(screen.getByText("Reviewed inline disclosure.")).toBeTruthy();
    expect(screen.getByText("No raw HTML is rendered.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: messages.PolishDialog.availability.annex })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("renders loading, disabled and error states without hiding plaintext disclosure", () => {
    const loading = renderDialog(
      makeStubFlow({ availabilityCandidate: null, availabilityStatus: "loading" }),
    );
    expect(screen.getByText(messages.PolishDialog.availability.loading)).toBeTruthy();
    expect(screen.getByText(messages.PolishDialog.privacyReminder)).toBeTruthy();
    loading.unmount();

    const disabled = renderDialog(
      makeStubFlow({ availabilityCandidate: null, availabilityStatus: "disabled" }),
    );
    expect(screen.getByText(messages.PolishDialog.availability.disabled)).toBeTruthy();
    expect(screen.queryByText(/DeepSeek/)).toBeNull();
    disabled.unmount();

    const availabilityRetry = vi.fn();
    renderDialog(
      makeStubFlow({
        availabilityCandidate: null,
        availabilityStatus: "error",
        availabilityRetry,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: messages.PolishDialog.availability.retry }),
    );
    expect(availabilityRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/DeepSeek/)).toBeNull();
  });

  it("fails closed for an unknown display key instead of interpolating an annex URL", () => {
    const unknownKey = "future-provider-v1";
    expect(resolvePolishProviderAnnexHref(unknownKey)).toBeNull();
    renderDialog(
      makeStubFlow({
        availabilityCandidate: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          displayDisclosure: {
            key: unknownKey,
            providerName: "Future Provider",
            modelName: "Future Model",
          },
        },
      }),
    );

    expect(
      screen.getByText(messages.PolishDialog.availability.unsupportedDisclosure),
    ).toBeTruthy();
    expect(screen.queryByText("Future Provider")).toBeNull();
    expect(screen.queryByRole("link", { name: messages.PolishDialog.availability.annex })).toBeNull();
  });
});

describe("PolishDialog retry guidance", () => {
  it("does not imply that waiting will unlock an AI-disabled account", () => {
    renderDialog(
      makeStubFlow({
        state: {
          ...createInitialState(),
          phase: "error",
          error: { code: "AI_DISABLED", retryAfterSeconds: 300 },
        },
      }),
    );

    expect(screen.getByText(messages.PolishDialog.errors.disabled)).toBeTruthy();
    expect(
      screen.queryByText(messages.PolishDialog.errors.retryAfter.replace("{seconds}", "300")),
    ).toBeNull();
  });

  it("keeps retry guidance for a genuinely temporary service outage", () => {
    renderDialog(
      makeStubFlow({
        state: {
          ...createInitialState(),
          phase: "error",
          error: { code: "SERVICE_UNAVAILABLE", retryAfterSeconds: 300 },
        },
      }),
    );

    expect(
      screen.getByText(messages.PolishDialog.errors.retryAfter.replace("{seconds}", "300")),
    ).toBeTruthy();
  });
});
