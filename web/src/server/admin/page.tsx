import "server-only";
import { notFound } from "next/navigation";
import AdminApp from "@/features/admin/admin-app";
import { adminSectionSchema } from "@/lib/admin/contract";
export default async function AdminPage({
  params
}: {
  params: Promise<{
    locale: string;
    segments?: string[];
  }>;
}) {
  const {
    locale,
    segments = []
  } = await params;
  if (locale !== "zh" && locale !== "en") notFound();
  if (!segments.length) return <AdminApp locale={locale} section="controls" />;
  const section = adminSectionSchema.safeParse(segments[0]);
  if (!section.success || segments.length !== 1) notFound();
  return <AdminApp locale={locale} section={section.data} />;
}
