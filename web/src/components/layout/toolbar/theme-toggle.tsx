"use client";

import { useTheme } from "next-themes";
import { Check, SunMoon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const THEME_OPTIONS = [
  { value: "light", labelKey: "light" },
  { value: "dark", labelKey: "dark" },
  { value: "system", labelKey: "system" },
] as const;

export function ThemeToggle() {
  const t = useTranslations("ThemeToggle");
  const { theme, setTheme } = useTheme();
  const active = theme ?? "system";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          title={t("toggle")}
          aria-label={t("toggle")}
        >
          <SunMoon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map((item) => (
          <DropdownMenuItem
            key={item.value}
            icon={item.value === active ? <Check className="size-4" /> : <span className="size-4" />}
            aria-current={item.value === active ? "true" : undefined}
            className={item.value === active ? "text-foreground" : undefined}
            onSelect={() => setTheme(item.value)}
          >
            {t(item.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}