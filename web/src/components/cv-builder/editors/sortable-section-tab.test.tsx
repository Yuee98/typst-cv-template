// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";

import messages from "../../../../messages/en.json";
import { Tabs, TabsList } from "@/components/ui/tabs";

const sortableMock = vi.hoisted(() => ({
  useSortable: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: sortableMock.useSortable,
}));

import {
  getSortableSectionTabStyle,
  handleSortableTabKeyDown,
  SortableSectionTab,
} from "./sortable-section-tab";

afterEach(() => {
  cleanup();
  sortableMock.useSortable.mockReset();
  vi.unstubAllGlobals();
});

function renderSortableTab(keyboardDragActive = true) {
  const listeners = { onKeyDown: vi.fn(), onPointerDown: vi.fn() };
  sortableMock.useSortable.mockReturnValue({
    attributes: {
      "aria-describedby": "dnd-description",
      "aria-roledescription": "sortable tab",
    },
    isDragging: true,
    listeners,
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: { x: 12, y: 8 },
    transition: "transform 200ms ease",
  });

  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Tabs defaultValue="skills">
        <TabsList>
          <SortableSectionTab
            id="skills"
            label={messages.Editors.tabs.skills}
            keyboardDragActive={keyboardDragActive}
          />
        </TabsList>
      </Tabs>
    </NextIntlClientProvider>,
  );
  return { ...view, listeners };
}

describe("sortable section tab interaction helpers", () => {
  it("lets the drag listener run before claiming navigation keys during drag", () => {
    const calls: string[] = [];
    const event = {
      key: "ArrowRight",
      preventDefault: vi.fn(() => calls.push("prevent")),
    } as unknown as KeyboardEvent<HTMLButtonElement>;

    handleSortableTabKeyDown(event, true, () => calls.push("drag"));

    expect(calls).toEqual(["drag", "prevent"]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not claim navigation keys when no keyboard drag is active", () => {
    const event = {
      key: "ArrowRight",
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent<HTMLButtonElement>;

    handleSortableTabKeyDown(event, false);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps transforms horizontal and raises active tabs above neighbors", () => {
    expect(
      getSortableSectionTabStyle({ x: 12, y: 99 }, "transform 200ms ease", true),
    ).toEqual({
      transform: "translate3d(12px, 0, 0)",
      transition: "transform 200ms ease",
      zIndex: 20,
    });
  });

  it("preserves sortable ARIA wiring on the Radix tab trigger", () => {
    renderSortableTab();

    const tab = screen.getByRole("tab", {
      name: `${messages.Editors.tabs.skills}. ${messages.Editors.dragTitle}.`,
    });
    expect(tab.getAttribute("aria-describedby")).toBe("dnd-description");
    expect(tab.getAttribute("aria-roledescription")).toBe("sortable tab");
    expect(tab.style.transform).toBe("translate3d(12px, 0, 0)");
  });

  it.each([
    { pointerType: "touch", coarse: false, drag: false },
    { pointerType: "mouse", coarse: true, drag: false },
    { pointerType: "mouse", coarse: false, drag: true },
  ])("preserves tab scrolling for $pointerType/coarse=$coarse without disabling keyboard sorting", ({ pointerType, coarse, drag }) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: coarse })));
    const { listeners } = renderSortableTab(false);
    const tab = screen.getByRole("tab");
    const pointer = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
    Object.defineProperty(pointer, "pointerType", { value: pointerType });
    fireEvent(tab, pointer);
    expect(listeners.onPointerDown).toHaveBeenCalledTimes(drag ? 1 : 0);
    expect(tab.className).toContain("touch-auto");
    expect(tab.className).not.toContain("touch-none");
    fireEvent.keyDown(tab, { key: " " });
    expect(listeners.onKeyDown).toHaveBeenCalledOnce();
  });
});
