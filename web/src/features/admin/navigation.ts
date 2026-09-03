// Return literal routes rather than interpolating DOM input into a navigation
// destination. A cast on a select value is not runtime validation.
export function adminNavigationPath(
  locale: string,
  section: string,
): string | null {
  const prefix = locale === "zh" ? "/zh" : "/en";
  switch (section) {
    case "overview":
      return prefix + "/admin";
    case "users":
      return prefix + "/admin/users";
    case "profiles":
      return prefix + "/admin/profiles";
    case "prices":
      return prefix + "/admin/prices";
    case "policies":
      return prefix + "/admin/policies";
    case "audit":
      return prefix + "/admin/audit";
    default:
      return null;
  }
}

// OAuth returns to a stable Admin entry point. Filters, cursors and fragments
// are transient UI state and must never be copied into the provider callback.
export function adminOAuthRedirectUrl(origin: string, locale: string): string {
  const path = locale === "zh" ? "/zh/admin" : "/en/admin";
  return new URL(path, origin).toString();
}
