// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RestrictedLegalMarkdown } from "./restricted-legal-markdown";
afterEach(cleanup);
it("renders the supported blocks and safe external links without HTML injection", () => {
  const view = render(<RestrictedLegalMarkdown body={"Intro\n\n## Scope\n\n- [Policy](https://example.test/policy)\n- Second item\n\nLast"} />);
  expect(Array.from(view.container.firstElementChild!.children).map(node => node.tagName)).toEqual(["P", "H2", "UL", "P"]);
  expect(screen.getByRole("link", {
    name: "Policy"
  }).getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.getByRole("link", {
    name: "Policy"
  }).getAttribute("target")).toBe("_blank");
});
