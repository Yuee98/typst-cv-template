import { expect, it } from "vitest";
import { adminNavigationPath } from "./navigation";
it("restricts DOM-provided destinations to the implemented local sections", () => {
  expect(adminNavigationPath("zh", "profiles")).toBe("/zh/admin/profiles");
  expect(adminNavigationPath("en", "overview")).toBe("/en/admin");
  for (const value of [
    "javascript:alert(1)",
    "//evil.test",
    "__proto__",
    "../",
    "users?token=private",
  ]) {
    expect(adminNavigationPath("zh", value)).toBeNull();
  }
});
