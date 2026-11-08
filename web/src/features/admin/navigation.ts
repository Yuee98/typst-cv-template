import { adminSectionSchema } from "@/lib/admin/contract";
export function adminNavigationPath(locale: string, section: string): string | null {
  const parsed = adminSectionSchema.safeParse(section);
  if (!parsed.success) return null;
  const prefix = locale === "zh" ? "/zh" : "/en";
  return `${prefix}/admin/${parsed.data}`;
}
export function adminOAuthRedirectUrl(origin: string, locale: string): string {
  return new URL(locale === "zh" ? "/zh/admin" : "/en/admin", origin).toString();
}
