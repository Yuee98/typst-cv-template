import { expect, it } from "vitest";
import { ADMIN_SECTIONS } from "@/lib/admin/contract";
import { adminNavigationPath, adminOAuthRedirectUrl } from "./navigation";
it("exposes only six business sections", () => {
  for (const section of ADMIN_SECTIONS) expect(adminNavigationPath("zh", section)).toBe(`/zh/admin/${section}`);
  for (const value of ["javascript:alert(1)", "//evil.test", "__proto__", "../", "users?token=private", "profiles", "providers", "prices"]) expect(adminNavigationPath("zh", value)).toBeNull();
});
it("uses the fixed clean OAuth callback", () => {
  expect(adminOAuthRedirectUrl("https://preview.example", "zh")).toBe("https://preview.example/zh/admin");
});
