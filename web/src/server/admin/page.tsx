import "server-only";
import { notFound } from "next/navigation";
import AdminApp from "@/features/admin/admin-app";
import { adminRecordSectionSchema } from "@/lib/admin/contract";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string; segments?: string[] }>;
}) {
  const { locale, segments = [] } = await params;
  if (locale !== "zh" && locale !== "en") notFound();
  if (segments.length === 0) return <AdminApp locale={locale} />;
  const section = adminRecordSectionSchema.safeParse(segments[0]);
  if (
    !section.success ||
    segments.length > 2 ||
    (segments[1] &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        segments[1],
      ))
  )
    notFound();
  return (
    <AdminApp locale={locale} section={section.data} recordId={segments[1]} />
  );
}
