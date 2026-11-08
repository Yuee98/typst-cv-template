// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LegalMarkdownPreview, RestrictedLegalMarkdown } from "./restricted-legal-markdown";
afterEach(cleanup);
describe("shared legal Markdown preview", () => {
  it("renders exactly the same legal body as the public reader", () => {
    const body = "Opening paragraph\n\n## Processing\n\n- Selected content\n- [Policy](https://policy.example/privacy)\n\nLast paragraph";
    const publicView = render(<RestrictedLegalMarkdown body={body} />);
    expect(Array.from(publicView.container.firstElementChild!.children).map(node => node.tagName)).toEqual(["P", "H2", "UL", "P"]);
    const html = publicView.container.innerHTML;
    publicView.unmount();
    const preview = render(<LegalMarkdownPreview body={body} emptyMessage="Empty" invalidMessage="Invalid" />);
    expect(preview.container.innerHTML).toBe(html);
    const link = screen.getByRole("link", { name: "Policy" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
  it.each(["<script>unsafe</script>", "[unsafe](javascript:alert)", "# Unsupported heading"])("keeps invalid editable Markdown out of the preview: %s", body => {
    const view = render(<LegalMarkdownPreview body={body} emptyMessage="Empty" invalidMessage="Invalid legal Markdown" />);
    expect(screen.getByRole("alert").textContent).toBe("Invalid legal Markdown");
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("shows an explicit empty-draft placeholder", () => {
    render(<LegalMarkdownPreview body="  " emptyMessage="Enter text to preview" invalidMessage="Invalid" />);
    expect(screen.getByRole("status").textContent).toBe("Enter text to preview");
  });
});
