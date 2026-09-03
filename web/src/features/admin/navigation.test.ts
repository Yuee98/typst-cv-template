import { expect, it } from "vitest";
import { adminNavigationPath, adminOAuthRedirectUrl } from "./navigation";
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

it("uses a fixed OAuth callback without Admin query or fragment state", () => {
  const current = new URL(
    "https://preview.example/zh/admin/users?search=admin%40example.test&after=cursor#private",
  );
  expect(adminOAuthRedirectUrl(current.origin, "zh")).toBe(
    "https://preview.example/zh/admin",
  );
  expect(adminOAuthRedirectUrl(current.origin, "unsupported")).toBe(
    "https://preview.example/en/admin",
  );
});
