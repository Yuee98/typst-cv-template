// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewPane } from "./preview-pane";

const messages = {
  PreviewPane: {
    title: "Preview",
    emptyHint: "Your preview will appear here.",
    status: { waiting: "Waiting", loadingAssets: "Loading assets", compiling: "Compiling", ready: "Ready", error: "Error" },
    pagePosition: "Page {page} of {total}",
  },
};

function svg(pageCount: number, suffix = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="glyph" d="M0 0h1v1z"/></defs>${Array.from({ length: pageCount }, (_, index) => `<g class="typst-page" data-page-width="595.28" data-page-height="841.89" transform="translate(0 ${index * 850})"><text>Content ${index + 1}${suffix}</text></g>`).join("")}</svg>`;
}

type Props = Parameters<typeof PreviewPane>[0];
const defaults = { svg: svg(3), status: "ready", percent: null, error: null } satisfies Props;
function element(props: Props) {
  return <NextIntlClientProvider locale="en" messages={messages}><PreviewPane {...props} /></NextIntlClientProvider>;
}
function preview(overrides: Partial<Props> = {}) {
  const props = { ...defaults, ...overrides };
  const view = render(element(props));
  return { ...view, rerender: (next: Partial<Props>) => view.rerender(element({ ...props, ...next })) };
}
afterEach(cleanup);

describe("PreviewPane shared scrolling surface", () => {
  it("renders every SVG page in order with its shared definitions and accessible page name", () => {
    const view = preview();
    const pages = [...view.container.querySelectorAll(".typst-page-shell")];
    expect(pages.map(page => page.textContent)).toEqual(["Content 1", "Content 2", "Content 3"]);
    expect(pages.every(page => page.querySelector("svg defs #glyph"))).toBe(true);
    expect(screen.getAllByRole("group").map(page => page.getAttribute("aria-label"))).toEqual(["Page 1 of 3", "Page 2 of 3", "Page 3 of 3"]);
  });

  it("updates the complete page set on refresh and retains it while compiling or showing an error", () => {
    const view = preview();
    const pane = view.container.querySelector(".preview-pane");
    view.rerender({ status: "compiling" });
    expect(view.container.querySelectorAll(".typst-page-shell")).toHaveLength(3);
    expect(screen.getByRole("status", { name: "Compiling" })).toBeTruthy();
    view.rerender({ svg: svg(2, " updated") });
    expect([...view.container.querySelectorAll(".typst-page-shell")].map(page => page.textContent)).toEqual(["Content 1 updated", "Content 2 updated"]);
    expect(screen.getAllByRole("group").map(page => page.getAttribute("aria-label"))).toEqual(["Page 1 of 2", "Page 2 of 2"]);
    expect(view.container.querySelector(".preview-pane")).toBe(pane);
    view.rerender({ svg: svg(2, " updated"), status: "error", error: "Preview compile failed" });
    expect(screen.getByText("Preview compile failed")).toBeTruthy();
    expect(view.container.querySelectorAll(".typst-page-shell")).toHaveLength(2);
  });

  it("renders the empty state without a page or navigation controls", () => {
    const view = preview({ svg: null, status: "idle" });
    expect(screen.getByText("Your preview will appear here.")).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(view.container.querySelectorAll("svg.typst-doc")).toHaveLength(0);
  });

  it("preserves the full progress label and export actions", () => {
    preview({ status: "loading-assets", percent: 37, actions: <button type="button">Export</button> });
    const badge = screen.getByRole("status", { name: "Loading assets (37%)" });
    expect(badge.getAttribute("title")).toBe("Loading assets (37%)");
    expect(badge.textContent).toContain("Loading assets");
    expect(badge.textContent).toContain("37%");
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });
});
