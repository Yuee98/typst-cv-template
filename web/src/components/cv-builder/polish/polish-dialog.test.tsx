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

import { PolishDialog } from "./polish-dialog";
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
    terms: {
      status: "accepting",
      serverRejected: false,
      checked: true,
      setChecked: vi.fn(),
    },
    configChangedHint: false,
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
