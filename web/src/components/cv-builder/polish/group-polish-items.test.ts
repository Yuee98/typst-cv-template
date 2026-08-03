import { describe, expect, it } from "vitest";

import { groupPolishItems } from "./group-polish-items";
import type { PolishItem } from "./polish-reducer";

function item(id: string, path: string): PolishItem {
  return { id, path, original: "o", polished: "p", state: "pending" };
}

describe("groupPolishItems", () => {
  it("flat sections yield one unlabeled group", () => {
    const items = [item("i0", "profile.0.body"), item("i1", "profile.1.body")];
    expect(groupPolishItems(items, "profile")).toEqual([
      { key: "", labelPaths: [], items },
    ]);
    expect(groupPolishItems(items, "skills")[0].labelPaths).toEqual([]);
    expect(groupPolishItems(items, "additional")).toHaveLength(1);
  });

  it("groups experience bullets by project with org+title labels", () => {
    const items = [
      item("i0", "experience.0.projects.0.bullets.0.body"),
      item("i1", "experience.0.projects.0.bullets.1.body"),
      item("i2", "experience.0.projects.1.bullets.0.body"),
      item("i3", "experience.1.projects.0.bullets.0.body"),
    ];
    const groups = groupPolishItems(items, "experience");
    expect(groups.map((group) => group.key)).toEqual([
      "experience.0.projects.0",
      "experience.0.projects.1",
      "experience.1.projects.0",
    ]);
    expect(groups[0].items.map((grouped) => grouped.id)).toEqual(["i0", "i1"]);
    expect(groups[0].labelPaths).toEqual([
      "experience.0.org",
      "experience.0.projects.0.title",
    ]);
    expect(groups[2].labelPaths).toEqual([
      "experience.1.org",
      "experience.1.projects.0.title",
    ]);
  });

  it("groups education bullets by entry with org+title labels", () => {
    const items = [
      item("i0", "education.0.bullets.0.body"),
      item("i1", "education.0.bullets.1.body"),
      item("i2", "education.1.bullets.0.body"),
    ];
    const groups = groupPolishItems(items, "education");
    expect(groups.map((group) => group.key)).toEqual(["education.0", "education.1"]);
    expect(groups[0].labelPaths).toEqual(["education.0.org", "education.0.title"]);
  });

  it("groups research bullets by entry with the title label only", () => {
    const items = [item("i0", "research.0.bullets.0.body")];
    expect(groupPolishItems(items, "research")).toEqual([
      { key: "research.0", labelPaths: ["research.0.title"], items },
    ]);
  });

  it("keeps document order and handles empty input", () => {
    expect(groupPolishItems([], "experience")).toEqual([]);
    const groups = groupPolishItems([item("i0", "education.2.bullets.0.body")], "education");
    expect(groups).toHaveLength(1);
  });
});
