"use client";

import { Check, Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ToolbarMenu } from "./toolbar-menu";
import { Button } from "@/components/ui/button";
import { MenuItem } from "@/components/ui/menu-item";
import { usePathname, useRouter } from "@/i18n/navigation";
import { locales, type Locale } from "@/i18n/routing";

export function LocaleSwitcher() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("LocaleSwitcher");

  return (
    <ToolbarMenu
      menuClassName="min-w-32"
      trigger={({ open, toggle }) => (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={toggle}
          title={t("label")}
          aria-label={t("label")}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Languages />
        </Button>
      )}
    >
      {({ close }) => (
        <>
          {locales.map((item) => (
            <MenuItem
              key={item}
              icon={item === locale ? <Check className="size-4" /> : <span className="size-4" />}
              aria-current={item === locale ? "true" : undefined}
              className={item === locale ? "text-slate-950" : undefined}
              onClick={() => {
                close();
                if (item !== locale) {
                  router.replace(pathname, { locale: item });
                }
              }}
            >
              {t(item)}
            </MenuItem>
          ))}
        </>
      )}
    </ToolbarMenu>
  );
}
