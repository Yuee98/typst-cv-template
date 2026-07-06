import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { CvBuilder } from "@/components/cv-builder/cv-builder";
import { isLocale } from "@/i18n/routing";

type PageProps = {
  params: Promise<{ locale: string }>;
};

export default async function Home({ params }: PageProps) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  setRequestLocale(locale);

  return <CvBuilder />;
}
