// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { LIBRARY_DOCK_QUERY, ResponsiveLibrary } from "./responsive-library";
import styles from "./responsive-library.module.css";

const media = {
  matches: false,
  listeners: new Set<() => void>(),
  change(value: boolean) {
    this.matches = value;
    this.listeners.forEach(listener => listener());
  },
};

beforeEach(() => {
  media.matches = false;
  media.listeners.clear();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    media: query,
    get matches() { return media.matches; },
    addEventListener: (_event: string, listener: () => void) => media.listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => media.listeners.delete(listener),
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function reportBrowserAnimations(reducedMotion = false) {
  const computedStyle = window.getComputedStyle.bind(window);
  // jsdom does not run CSS keyframes. Supply the live computed animation names
  // and dispatch their completion events; Radix Presence itself stays real.
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    const computed = computedStyle(element);
    const drawer = element.classList.contains(styles.drawer);
    if (!drawer && !element.classList.contains(styles.overlay)) return computed;
    return new Proxy(computed, {
      get(target, property) {
        if (property === "animationName") {
          return reducedMotion ? "none" : `${drawer ? "slide" : "fade"}-${element.getAttribute("data-state") === "closed" ? "out" : "in"}`;
        }
        return Reflect.get(target, property, target);
      },
    });
  });
  vi.stubGlobal("CSS", { ...globalThis.CSS, escape: (name: string) => name });
}

function endAnimation(element: Element, animationName: string) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  fireEvent(element, event);
}

function Harness({ initialOpen = false, handoff = false }: { initialOpen?: boolean; handoff?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [otherOpen, setOtherOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  return <>
    <button ref={triggerRef} onClick={() => setOpen(true)}>Open library</button>
    <input aria-label="Editor draft" defaultValue="Unsaved editor content" />
    <output data-testid="open-state">{String(open)}</output>
    <ResponsiveLibrary open={open} onOpenChange={setOpen} triggerRef={triggerRef} title="CV library">
      {docked => <aside aria-label="Library content">
        <span>{docked ? "Docked library" : "Drawer library"}</span>
        {!docked && <button onClick={() => setOpen(false)}>Close library</button>}
        {handoff && <button onClick={() => { setOtherOpen(true); setOpen(false); }}>Rename document</button>}
      </aside>}
    </ResponsiveLibrary>
    <ModalDialog open={otherOpen} onClose={() => setOtherOpen(false)} title="Rename" initialFocusRef={otherInput}>
      <input aria-label="New title" ref={otherInput} />
    </ModalDialog>
  </>;
}

describe("ResponsiveLibrary", () => {
  it("uses a deterministic closed drawer shell during SSR even on a docked browser", () => {
    media.matches = true;
    const html = renderToString(<Harness />);
    expect(html).toContain('data-docked="false"');
    expect(html).not.toContain("Docked library");
    expect(html).not.toContain('role="dialog"');
    expect(window.matchMedia).not.toHaveBeenCalled();
  });

  it("renders one docked library, moves only the library to a drawer, and keeps the editor node", async () => {
    media.matches = true;
    const view = render(<Harness />);
    expect(window.matchMedia).toHaveBeenCalledWith(LIBRARY_DOCK_QUERY);
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(screen.getByText("Docked library")).toBeTruthy();
    const editor = screen.getByLabelText("Editor draft") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "Latest unsaved text" } });
    act(() => media.change(false));
    expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    await screen.findByRole("dialog", { name: "CV library" });
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(screen.getByText("Drawer library")).toBeTruthy();
    expect(view.container.querySelector('input[aria-label="Editor draft"]')).toBe(editor);
    expect(editor.value).toBe("Latest unsaved text");
  });

  it("closes with Escape or the close button and restores the header trigger", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open library" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "CV library" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "CV library" });
    fireEvent.click(screen.getByRole("button", { name: "Close library" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes the mobile modal when docking and does not reopen it after shrinking", async () => {
    render(<Harness initialOpen />);
    await screen.findByRole("dialog", { name: "CV library" });
    act(() => media.change(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(screen.getByText("Docked library")).toBeTruthy();
    expect(screen.getByTestId("open-state").textContent).toBe("false");
    act(() => media.change(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes when the user presses the backdrop", async () => {
    render(<Harness initialOpen />);
    await screen.findByRole("dialog", { name: "CV library" });
    // Radix attaches its document-level outside-pointer listener after mount.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const overlay = document.querySelector("[data-library-overlay]")!;
    fireEvent.pointerDown(overlay, { button: 0 });
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("open-state").textContent).toBe("false");
  });

  it("does not steal focus when a library action hands off to another modal", async () => {
    render(<Harness initialOpen handoff />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename document" }));
    await screen.findByRole("dialog", { name: "Rename" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("New title")));
    expect(screen.queryByRole("dialog", { name: "CV library" })).toBeNull();
  });

  it("retains the drawer and overlay through their exit animations before returning focus", async () => {
    reportBrowserAnimations();
    render(<Harness initialOpen />);
    const drawer = await screen.findByRole("dialog", { name: "CV library" });
    const overlay = document.querySelector("[data-library-overlay]")!;
    const trigger = screen.getByText("Open library");
    expect(drawer.classList.contains(styles.drawer)).toBe(true);
    expect(overlay.classList.contains(styles.overlay)).toBe(true);
    expect(overlay.className).not.toContain("backdrop-blur");
    expect(drawer.className).not.toContain("shadow-xl");
    fireEvent.click(screen.getByRole("button", { name: "Close library" }));
    expect(drawer.getAttribute("data-state")).toBe("closed");
    expect(overlay.getAttribute("data-state")).toBe("closed");
    expect(drawer.isConnected).toBe(true);
    expect(overlay.isConnected).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
    act(() => { endAnimation(drawer, "slide-out"); endAnimation(overlay, "fade-out"); });
    await waitFor(() => expect(drawer.isConnected).toBe(false));
    expect(overlay.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not steal the next modal's focus when the delayed exit completes", async () => {
    reportBrowserAnimations();
    render(<Harness initialOpen handoff />);
    const drawer = await screen.findByRole("dialog", { name: "CV library" });
    const overlay = document.querySelector("[data-library-overlay]")!;
    fireEvent.click(screen.getByRole("button", { name: "Rename document" }));
    await screen.findByRole("dialog", { name: "Rename" });
    expect(drawer.isConnected).toBe(true);
    act(() => { endAnimation(drawer, "slide-out"); endAnimation(overlay, "fade-out"); });
    await waitFor(() => expect(drawer.isConnected).toBe(false));
    expect(document.activeElement).toBe(screen.getByLabelText("New title"));
  });

  it("unmounts without waiting when reduced-motion styles report no animation", async () => {
    reportBrowserAnimations(true);
    render(<Harness initialOpen />);
    const drawer = await screen.findByRole("dialog", { name: "CV library" });
    fireEvent.click(screen.getByRole("button", { name: "Close library" }));
    await waitFor(() => expect(drawer.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Open library")));
  });
});
