import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { QueryProvider } from "@/app/query-provider";
import { HtmlLangSync } from "@/components/layout/html-lang-sync";
import { getMessages } from "@/i18n/messages";
import { isLocale, locales } from "@/i18n/routing";
import { getSiteMetadata } from "@/i18n/site-metadata";

type LocaleParams = Promise<{ locale: string }>;

export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: LocaleParams }): Promise<Metadata> {
  const { locale } = await params;
  return getSiteMetadata(isLocale(locale) ? locale : "zh");
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: LocaleParams;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = getMessages(locale);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <HtmlLangSync locale={locale} />
      <QueryProvider>{children}</QueryProvider>
    </NextIntlClientProvider>
  );
}
