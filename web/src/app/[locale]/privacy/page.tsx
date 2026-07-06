import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { LegalDocumentPage } from "@/components/legal/legal-document-page";
import { getLegalContent } from "@/content/legal";
import { getMessages } from "@/i18n/messages";
import { isLocale } from "@/i18n/routing";

type PageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const validLocale = isLocale(locale) ? locale : "zh";
  const messages = getMessages(validLocale);
  const legal = getLegalContent(validLocale);

  return {
    title: `${legal.privacyDocument.title} | ${messages.Metadata.title}`,
  };
}

export default async function PrivacyPage({ params }: PageProps) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const legal = getLegalContent(locale);

  return <LegalDocumentPage document={legal.privacyDocument} />;
}
