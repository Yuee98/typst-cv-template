import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { LegalDocumentPage } from "@/components/legal/legal-document-page";
import { PublicInsights } from "@/components/telemetry/public-insights";
import { getLegalContent } from "@/content/legal";
import { isLocale } from "@/i18n/routing";
import { getSiteMetadata } from "@/i18n/site-metadata";

type PageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const validLocale = isLocale(locale) ? locale : "zh";
  const legal = getLegalContent(validLocale);
  const siteMetadata = getSiteMetadata(validLocale);

  return {
    title: `${legal.privacyDocument.title} | ${siteMetadata.title}`,
  };
}

export default async function PrivacyPage({ params }: PageProps) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const legal = getLegalContent(locale);

  return <><LegalDocumentPage document={legal.privacyDocument} />{process.env.VERCEL === "1" && <PublicInsights />}</>;
}
