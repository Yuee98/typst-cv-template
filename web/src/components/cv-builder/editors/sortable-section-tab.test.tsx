// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
});

function renderSortableTab(keyboardDragActive = true) {
  sortableMock.useSortable.mockReturnValue({
    attributes: {
      "aria-describedby": "dnd-description",
      "aria-roledescription": "sortable tab",
    },
    isDragging: true,
    listeners: {
      onKeyDown: vi.fn(),
    },
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: { x: 12, y: 8 },
    transition: "transform 200ms ease",
  });

  return render(
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
});
