"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link, usePathname } from "@/i18n/navigation";
import { locales, type Locale } from "@/i18n/routing";

export function LocaleSwitcher() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const t = useTranslations("LocaleSwitcher");
  const nextLocale = locales.find((item) => item !== locale) ?? "en";
  const currentBadge = locale === "zh" ? "中" : "EN";
  const switchLabel = t("switchTo", { language: t(nextLocale) });

  return (
    <Button
      variant="secondary"
      size="icon"
      asChild
      title={switchLabel}
      aria-label={switchLabel}
      className="relative"
    >
      <Link href={pathname} locale={nextLocale}>
        <Languages />
        <span
          aria-hidden="true"
          className="absolute bottom-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-sm border border-white bg-slate-100 px-0.5 text-[9px] font-semibold leading-none text-slate-700"
        >
          {currentBadge}
        </span>
      </Link>
    </Button>
  );
}
