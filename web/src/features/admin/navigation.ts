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
