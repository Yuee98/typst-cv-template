"use client";

import { CircleDot, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GithubIcon } from "@/components/ui/github-icon";

const GITHUB_REPOSITORY_URL = "https://github.com/Yuee98/typst-cv-template";
const GITHUB_ISSUES_URL = `${GITHUB_REPOSITORY_URL}/issues`;

export function GithubMenu() {
  const t = useTranslations("CvToolbar");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          title={t("github")}
          aria-label={t("github")}
        >
          <GithubIcon className="!size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => window.open(GITHUB_REPOSITORY_URL, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="size-4" />
          {t("githubRepository")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => window.open(GITHUB_ISSUES_URL, "_blank", "noopener,noreferrer")}
        >
          <CircleDot className="size-4" />
          {t("githubIssues")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
